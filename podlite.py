#!/usr/bin/env python3
"""
podlite - a dumb, tiny kubectl dashboard.

One file, stdlib only. It shells out to kubectl (so EKS auth / kubeconfig
just work) and serves a single-page UI. No build step, no Electron, no CRD
zoo. If it needs explaining, it's too clever.

    ./podlite.sh                 # http://127.0.0.1:8484
    PODLITE_ALLOW_WRITES=1 ./podlite.sh   # unlock delete / restart / exec

Env knobs:
    PODLITE_PORT=8484
    PODLITE_KUBECTL=kubectl
    PODLITE_TIMEOUT=25                 # seconds per kubectl call
    PODLITE_ALLOW_WRITES=0             # destructive actions + exec
    PODLITE_WATCH_NAMESPACES=default   # background restart watcher
    PODLITE_HOME=~/.podlite            # restart history file
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import webbrowser
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PORT = int(os.environ.get("PODLITE_PORT", "8484"))
KUBECTL = os.environ.get("PODLITE_KUBECTL", "kubectl")
TIMEOUT = int(os.environ.get("PODLITE_TIMEOUT", "25"))
ALLOW_WRITES = os.environ.get("PODLITE_ALLOW_WRITES", "0") == "1"
WATCH_NAMESPACES = [
    n.strip()
    for n in os.environ.get("PODLITE_WATCH_NAMESPACES", "default").split(",")
    if n.strip()
]
HOME_DIR = Path(os.environ.get("PODLITE_HOME", Path.home() / ".podlite"))
HISTORY_FILE = HOME_DIR / "restarts.jsonl"
HISTORY_MAX = 2000

# resource plural -> kubectl resource arg. Anything not listed is refused.
KINDS = {
    "pods": "pods",
    "nodes": "nodes",
    "deployments": "deployments",
    "statefulsets": "statefulsets",
    "daemonsets": "daemonsets",
    "jobs": "jobs",
    "cronjobs": "cronjobs",
    "services": "services",
    "ingresses": "ingresses",
    "configmaps": "configmaps",
    "secrets": "secrets",
    "events": "events",
    "persistentvolumeclaims": "persistentvolumeclaims",
    "horizontalpodautoscalers": "horizontalpodautoscalers",
}

# namespaced or cluster-scoped
CLUSTER_SCOPED = {"nodes"}

# configmap/secret data keys: alphanumerics, '-', '_' and '.'
CONFIG_KEY_RE = re.compile(r"^[-._a-zA-Z0-9]+$")

# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[podlite] {msg}", flush=True)


def parse_quantity(q) -> float:
    """k8s quantity -> float. '458m'->0.458, '928Mi'->973078528."""
    if q is None or q == "":
        return 0.0
    m = re.match(r"^([0-9.]+)([a-zA-Z]*)$", str(q))
    if not m:
        return 0.0
    n = float(m.group(1))
    mult = {
        "": 1.0,
        "n": 1e-9,
        "u": 1e-6,
        "m": 1e-3,
        "k": 1e3,
        "M": 1e6,
        "G": 1e9,
        "T": 1e12,
        "P": 1e15,
        "Ki": 1024.0,
        "Mi": 1024.0**2,
        "Gi": 1024.0**3,
        "Ti": 1024.0**4,
        "Pi": 1024.0**5,
    }.get(m.group(2))
    return n if mult is None else n * mult


def fmt_cpu(cores: float) -> str:
    if cores <= 0:
        return "-"
    return f"{cores * 1000:.0f}m" if cores < 1 else f"{cores:.1f}"


def fmt_mem(nbytes: float) -> str:
    if nbytes <= 0:
        return "-"
    for unit, div in (("Gi", 1024.0**3), ("Mi", 1024.0**2), ("Ki", 1024.0)):
        if nbytes >= div:
            return f"{nbytes / div:.0f}{unit}"
    return f"{nbytes:.0f}B"


def age_seconds(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        dt = datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        return max(0, int(time.time() - dt.timestamp()))
    except ValueError:
        return 0


# --------------------------------------------------------------------------
# kubectl
# --------------------------------------------------------------------------

class KubeError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.message = message
        self.status = status


def friendly_error(stderr: str) -> str:
    text = (stderr or "").strip()
    low = text.lower()
    if "expired" in low or ("sso" in low and "token" in low):
        return "AWS session expired. Run: aws sso login --profile ProdViewOnlyAccess-188113730724"
    if "get-token" in low or "exec plugin" in low:
        return "kubectl auth plugin failed (aws eks get-token). Re-run aws sso login."
    if "connection refused" in low or "dial tcp" in low or "no such host" in low:
        match = re.search(r'https?://[^\s"\\]+', text)
        return f"Cluster unreachable ({match.group(0) if match else 'no route'}). Check VPN / that the cluster is up."
    if "forbidden" in low:
        return "RBAC says no: " + text.splitlines()[0]
    if "not found" in low:
        return "Not found: " + text.splitlines()[0]
    if "no such context" in low or ("context" in low and "does not exist" in low):
        return "Unknown kubectl context. Check kubectl config get-contexts."
    for line in text.splitlines():
        if "error" in line.lower():
            return line[:300]
    return text.splitlines()[0][:300] if text else "kubectl failed"


def kubectl(args: list[str], ctx: str | None = None, ns: str | None = None,
            timeout: int | None = None, check: bool = True,
            stdin: str | None = None) -> str:
    cmd = [KUBECTL]
    if ctx:
        cmd += ["--context", ctx]
    if ns:
        cmd += ["-n", ns]
    cmd += args
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout or TIMEOUT,
            input=stdin,
        )
    except subprocess.TimeoutExpired:
        raise KubeError(f"kubectl timed out after {timeout or TIMEOUT}s: {' '.join(args)}", 504)
    except FileNotFoundError:
        raise KubeError(f"kubectl binary not found ({KUBECTL})", 500)
    if proc.returncode != 0 and check:
        raise KubeError(friendly_error(proc.stderr), 502)
    return proc.stdout


def kubectl_json(args: list[str], ctx: str | None = None, ns: str | None = None) -> dict:
    out = kubectl(args + ["-o", "json"], ctx=ctx, ns=ns)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise KubeError("kubectl returned non-JSON output", 502)


# tiny TTL cache: kubectl is ~1s, this keeps tab switching snappy
class Cache:
    def __init__(self):
        self._data: OrderedDict[str, tuple[float, object]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str, ttl: float):
        with self._lock:
            hit = self._data.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        return None

    def put(self, key: str, value):
        with self._lock:
            self._data[key] = (time.time(), value)
            while len(self._data) > 200:
                self._data.popitem(last=False)

    def drop(self):
        with self._lock:
            self._data.clear()


CACHE = Cache()

# --------------------------------------------------------------------------
# restart detection + history
# --------------------------------------------------------------------------

class RestartTracker:
    """
    Remembers the last restart count per container and records increases.

    This is the whole point of the tool: you should never have to ask
    'did that pod restart?' again.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._prev: dict[tuple, int] = {}
        self._events: list[dict] = []
        self._seq = 0
        self._load()

    # --- persistence -------------------------------------------------------
    def _load(self):
        if not HISTORY_FILE.exists():
            return
        try:
            lines = HISTORY_FILE.read_text().splitlines()[-HISTORY_MAX:]
        except OSError:
            return
        for line in lines:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            self._seq = max(self._seq, int(ev.get("seq", 0)))
            self._events.append(ev)
            # seed what we already know so a podlite restart doesn't re-record
            # the same container state as brand new history
            key = (ev.get("ctx"), ev.get("ns"), ev.get("pod"), ev.get("container"))
            self._prev[key] = max(int(ev.get("total") or 0), self._prev.get(key, 0))
        log(f"loaded {len(self._events)} restart events from {HISTORY_FILE}")

    def _append(self, ev: dict):
        try:
            HOME_DIR.mkdir(parents=True, exist_ok=True)
            with HISTORY_FILE.open("a") as fh:
                fh.write(json.dumps(ev) + "\n")
        except OSError as exc:
            log(f"could not persist restart history: {exc}")

    # --- detection ---------------------------------------------------------
    def detect(self, ctx: str, ns: str, pods: list[dict]) -> None:
        with self._lock:
            for pod in pods:
                for c in pod["containers"]:
                    key = (ctx, ns, pod["name"], c["name"])
                    count = c["restarts"]
                    prev = self._prev.get(key)
                    self._prev[key] = count
                    if prev is None:
                        # first time we see this container: seed history from what
                        # k8s already knows, so day one isn't empty
                        if count > 0 and c["lastFinishedAt"]:
                            self._record(ctx, ns, pod, c, delta=count, total=count, historical=True)
                        continue
                    if count <= prev:
                        continue
                    self._record(ctx, ns, pod, c, delta=count - prev, total=count, historical=False)
            if len(self._events) > HISTORY_MAX:
                self._events = self._events[-HISTORY_MAX:]

    def _record(self, ctx: str, ns: str, pod: dict, c: dict, delta: int,
                total: int, historical: bool) -> None:
        self._seq += 1
        now = time.time()
        ev = {
            "seq": self._seq,
            "ts": int(now - age_seconds(c["lastFinishedAt"])) if historical else int(now),
            "ctx": ctx,
            "ns": ns,
            "pod": pod["name"],
            "node": pod["node"],
            "container": c["name"],
            "delta": delta,
            "total": total,
            "reason": c["lastReason"] or "unknown",
            "exitCode": c["lastExitCode"],
            "ranForSec": c["ranForSec"],
            "owner": pod["owner"],
            "historical": historical,
        }
        self._events.append(ev)
        self._append(ev)

    def since(self, after: int, limit: int = 200) -> list[dict]:
        with self._lock:
            return [e for e in self._events if e["seq"] > after][-limit:]

    def latest_seq(self) -> int:
        with self._lock:
            return self._seq

    def count_since(self, ts: int) -> int:
        with self._lock:
            return sum(1 for e in self._events if e["ts"] >= ts)


RESTARTS = RestartTracker()

# --------------------------------------------------------------------------
# data shaping
# --------------------------------------------------------------------------

def pod_status(pod: dict) -> tuple[str, bool]:
    """(human status, ready-for-traffic?)"""
    phase = pod["status"].get("phase") or "Unknown"
    statuses = pod["status"].get("containerStatuses") or []
    if (pod.get("metadata") or {}).get("deletionTimestamp"):
        return "Terminating", False
    for cs in statuses:
        state = cs.get("state") or {}
        waiting = state.get("waiting") or {}
        reason = waiting.get("reason")
        if reason in ("CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull",
                      "CreateContainerConfigError", "CreateContainerError",
                      "RunContainerError", "InvalidImageName", "OOMKilled"):
            return reason, False
    if phase == "Running":
        ready = pod["status"].get("conditions") or []
        if any(c.get("type") == "Ready" and c.get("status") == "False" for c in ready):
            return "NotReady", False
        return "Running", all(cs.get("ready") for cs in statuses) if statuses else False
    if phase == "Succeeded":
        return "Completed", False
    if phase == "Failed":
        for cs in statuses:
            term = ((cs.get("state") or {}).get("terminated") or {})
            if term.get("reason"):
                return term["reason"], False
        return "Failed", False
    return phase, False


def container_info(cs: dict, spec_c: dict) -> dict:
    state = cs.get("state") or {}
    last = (cs.get("lastState") or {}).get("terminated") or {}
    waiting = state.get("waiting") or {}
    terminated = state.get("terminated") or {}
    running = state.get("running") or {}
    ran_for = 0
    if last.get("startedAt") and last.get("finishedAt"):
        ran_for = max(0, age_seconds(last["startedAt"]) - age_seconds(last["finishedAt"]))
    res = spec_c.get("resources") or {}
    req = res.get("requests") or {}
    lim = res.get("limits") or {}
    return {
        "name": cs.get("name"),
        "image": cs.get("image") or spec_c.get("image"),
        "ready": bool(cs.get("ready")),
        "restarts": int(cs.get("restartCount") or 0),
        "state": "running" if running else "waiting" if waiting else "terminated" if terminated else "unknown",
        "reason": waiting.get("reason") or terminated.get("reason") or "",
        "startedAt": running.get("startedAt") or "",
        "lastReason": last.get("reason") or "",
        "lastExitCode": last.get("exitCode"),
        "lastFinishedAt": last.get("finishedAt") or "",
        "ranForSec": ran_for,
        "cpuReq": parse_quantity(req.get("cpu")),
        "cpuLim": parse_quantity(lim.get("cpu")),
        "memReq": parse_quantity(req.get("memory")),
        "memLim": parse_quantity(lim.get("memory")),
        "ready": bool(cs.get("ready")),
    }


def owner_of(meta: dict) -> str:
    for ref in meta.get("ownerReferences") or []:
        return f"{ref.get('kind')}/{ref.get('name')}"
    return ""


def uptime_seconds(containers: list[dict]) -> int:
    """How long the pod has actually been up: since its earliest running container started."""
    started = [c["startedAt"] for c in containers if c["state"] == "running" and c["startedAt"]]
    if not started:
        return 0
    return age_seconds(min(started))


def pod_rows(ctx: str, ns: str, metrics: dict) -> list[dict]:
    raw = kubectl_json(["get", "pods"], ctx=ctx, ns=ns)
    rows = []
    for pod in raw.get("items", []):
        meta = pod["metadata"]
        status = pod["status"]
        spec = pod["spec"]
        spec_containers = {c["name"]: c for c in spec.get("containers") or []}
        containers = [
            container_info(cs, spec_containers.get(cs["name"], {}))
            for cs in status.get("containerStatuses") or []
        ]
        ready_n = sum(1 for c in containers if c["ready"])
        total_n = len(spec.get("containers") or [])
        human, ready = pod_status(pod)
        restarts = sum(c["restarts"] for c in containers)
        last_restart_at = max((c["lastFinishedAt"] for c in containers if c["lastFinishedAt"]), default="")
        last_reason = next((c["lastReason"] for c in containers if c["lastReason"]), "")
        cpu, mem = metrics.get(meta["name"], (0.0, 0.0))
        rows.append({
            "ns": ns,
            "name": meta["name"],
            "node": spec.get("nodeName") or "",
            "phase": status.get("phase") or "",
            "status": human,
            "ready": ready,
            "readyText": f"{ready_n}/{total_n or len(containers)}",
            "restarts": restarts,
            "ageSec": age_seconds(meta.get("creationTimestamp")),
            "upSec": uptime_seconds(containers),
            "nodeAgeSec": 0,
            "lastRestartAt": last_restart_at,
            "lastRestartAgoSec": age_seconds(last_restart_at) if last_restart_at else 0,
            "lastReason": last_reason,
            "owner": owner_of(meta),
            "qos": status.get("qosClass") or "",
            "podIP": status.get("podIP") or "",
            "images": [c["image"] for c in containers],
            "containers": containers,
            "cpu": cpu,
            "mem": mem,
            "cpuText": fmt_cpu(cpu),
            "memText": fmt_mem(mem),
        })
    return rows


def pod_metrics(ctx: str, ns: str) -> dict:
    try:
        raw = kubectl(["get", "--raw", f"/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"],
                      ctx=ctx, timeout=10)
        data = json.loads(raw)
    except (KubeError, json.JSONDecodeError):
        return {}
    out = {}
    for item in data.get("items", []):
        cpu = 0.0
        mem = 0.0
        for c in item.get("containers") or []:
            usage = c.get("usage") or {}
            cpu += parse_quantity(usage.get("cpu"))
            mem += parse_quantity(usage.get("memory"))
        out[item["metadata"]["name"]] = (cpu, mem)
    return out


def node_rows(ctx: str, pods: list[dict]) -> tuple[list[dict], str]:
    """
    Core node objects are RBAC-blocked for regular devs, so we build the node
    list out of metrics (which include nodegroup/instance-type labels) plus
    pod placement. Returns (rows, note).
    """
    note = ""
    metrics = {}
    try:
        raw = kubectl(["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"], ctx=ctx, timeout=10)
        metrics = json.loads(raw)
    except (KubeError, json.JSONDecodeError) as exc:
        note = f"node metrics unavailable: {exc}"

    counts: dict[str, int] = {}
    restarts: dict[str, int] = {}
    for p in pods:
        counts[p["node"]] = counts.get(p["node"], 0) + 1
        restarts[p["node"]] = restarts.get(p["node"], 0) + p["restarts"]

    rows = []
    for item in metrics.get("items", []):
        name = item["metadata"]["name"]
        labels = item["metadata"].get("labels") or {}
        usage = item.get("usage") or {}  # NodeMetrics keeps usage flat, not per-container
        cpu = parse_quantity(usage.get("cpu"))
        mem = parse_quantity(usage.get("memory"))
        rows.append({
            "name": name,
            "short": name.split(".")[0],
            "instanceType": labels.get("beta.kubernetes.io/instance-type") or labels.get("node.kubernetes.io/instance-type") or "",
            "nodegroup": labels.get("eks.amazonaws.com/nodegroup") or "",
            "capacityType": labels.get("eks.amazonaws.com/capacityType") or "",
            "zone": labels.get("topology.kubernetes.io/zone") or "",
            "arch": labels.get("kubernetes.io/arch") or "",
            "pods": counts.get(name, 0),
            "restarts": restarts.get(name, 0),
            "cpu": cpu,
            "mem": mem,
            "cpuText": fmt_cpu(cpu),
            "memText": fmt_mem(mem),
        })
    # pods on nodes that report no metrics still deserve a row
    known = {r["name"] for r in rows}
    for n in counts:
        if n and n not in known:
            rows.append({
                "name": n, "short": n.split(".")[0], "instanceType": "", "nodegroup": "",
                "capacityType": "", "zone": "", "arch": "", "pods": counts[n],
                "restarts": restarts.get(n, 0), "cpu": 0.0, "mem": 0.0,
                "cpuText": "-", "memText": "-",
            })
    rows.sort(key=lambda r: r["name"])
    if not note and not rows:
        note = "no node metrics available"
    return rows, note


def generic_rows(kind: str, ctx: str, ns: str) -> list[dict]:
    raw = kubectl_json(["get", KINDS[kind]], ctx=ctx, ns=ns)
    rows = []
    for obj in raw.get("items", []):
        meta = obj["metadata"]
        row = {
            "ns": meta.get("namespace") or ns,
            "name": meta["name"],
            "ageSec": age_seconds(meta.get("creationTimestamp")),
            "labels": meta.get("labels") or {},
        }
        if kind in ("deployments", "statefulsets", "daemonsets"):
            spec = obj.get("spec") or {}
            status = obj.get("status") or {}
            desired = spec.get("replicas", status.get("desiredNumberScheduled", 0)) or 0
            if kind == "daemonsets":
                ready = status.get("numberReady") or 0
                desired = status.get("desiredNumberScheduled") or 0
            else:
                ready = status.get("readyReplicas") or 0
            images = [c.get("image") for c in
                      ((spec.get("template") or {}).get("spec") or {}).get("containers") or []]
            row.update({
                "ready": ready,
                "desired": desired,
                "readyText": f"{ready}/{desired}",
                "healthy": ready == desired and desired > 0,
                "images": images,
                "strategy": (spec.get("strategy") or {}).get("type") or (spec.get("updateStrategy") or {}).get("type") or "",
                "updated": status.get("updatedReplicas") or 0,
            })
        elif kind == "services":
            spec = obj.get("spec") or {}
            ports = spec.get("ports") or []
            row.update({
                "type": spec.get("type") or "",
                "clusterIP": spec.get("clusterIP") or "",
                "ports": ", ".join(
                    f"{p.get('port')}→{p.get('targetPort', p.get('port'))}/{p.get('protocol', 'TCP')}"
                    for p in ports
                ),
                "selector": ", ".join(f"{k}={v}" for k, v in (spec.get("selector") or {}).items()),
                "external": ", ".join(
                    (i.get("ip") or i.get("hostname") or "")
                    for i in (obj.get("status") or {}).get("loadBalancer", {}).get("ingress", [])
                ),
            })
        elif kind in ("configmaps", "secrets"):
            data = obj.get("data") or {}
            row.update({
                "keys": sorted(data),
                "keyCount": len(data),
                "type": obj.get("type") or "",
                "immutable": bool(obj.get("immutable")),
            })
        elif kind == "events":
            involved = obj.get("involvedObject") or {}
            row.update({
                "reason": obj.get("reason") or "",
                "message": obj.get("message") or "",
                "type": obj.get("type") or "",
                "count": obj.get("count") or 1,
                "objectKind": involved.get("kind") or "",
                "objectName": involved.get("name") or "",
                "lastSeen": obj.get("lastTimestamp") or obj.get("eventTime") or
                            (obj.get("metadata") or {}).get("creationTimestamp") or "",
                "lastSeenAgoSec": age_seconds(
                    obj.get("lastTimestamp") or obj.get("eventTime") or
                    (obj.get("metadata") or {}).get("creationTimestamp")
                ),
                "source": (obj.get("source") or {}).get("component") or "",
            })
        elif kind == "jobs":
            status = obj.get("status") or {}
            row.update({
                "succeeded": status.get("succeeded") or 0,
                "failed": status.get("failed") or 0,
                "active": status.get("active") or 0,
                "completionTime": status.get("completionTime") or "",
            })
        elif kind == "cronjobs":
            spec = obj.get("spec") or {}
            row.update({
                "schedule": spec.get("schedule") or "",
                "suspend": bool(spec.get("suspend")),
                "lastSchedule": (obj.get("status") or {}).get("lastScheduleTime") or "",
            })
        elif kind == "persistentvolumeclaims":
            spec = obj.get("spec") or {}
            capacity = (obj.get("status") or {}).get("capacity") or {}
            row.update({
                "status": (obj.get("status") or {}).get("phase") or "",
                "storageClass": spec.get("storageClassName") or "",
                "size": capacity.get("storage") or "",
                "accessModes": ", ".join(spec.get("accessModes") or []),
            })
        elif kind == "ingresses":
            rules = (obj.get("spec") or {}).get("rules") or []
            row.update({
                "hosts": ", ".join(r.get("host", "") for r in rules if r.get("host")),
                "class": (obj.get("spec") or {}).get("ingressClassName") or "",
                "loadBalancers": ", ".join(
                    (i.get("ip") or i.get("hostname") or "")
                    for i in (obj.get("status") or {}).get("loadBalancer", {}).get("ingress", [])
                ),
            })
        elif kind == "horizontalpodautoscalers":
            spec = obj.get("spec") or {}
            status = obj.get("status") or {}
            row.update({
                "target": f"{spec.get('scaleTargetRef', {}).get('kind')}/{spec.get('scaleTargetRef', {}).get('name')}",
                "min": spec.get("minReplicas") or 0,
                "max": spec.get("maxReplicas") or 0,
                "current": status.get("currentReplicas") or 0,
                "desired": status.get("desiredReplicas") or 0,
            })
        rows.append(row)
    rows.sort(key=lambda r: r["name"])
    return rows


# --------------------------------------------------------------------------
# port forwards
# --------------------------------------------------------------------------

class PortForwards:
    """kubectl port-forward children, because `kubectl pf` does not exist."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items: dict[int, dict] = {}
        self._next = 1

    def start(self, ctx: str, ns: str, pod: str, ports: str) -> dict:
        if not re.match(r"^[0-9]+(:[0-9]+)?(\s*[0-9]+(:[0-9]+)?)*$", ports.strip()):
            raise KubeError("ports must look like 8080:80 (host:container)", 400)
        cmd = [KUBECTL, "--context", ctx, "-n", ns, "port-forward", f"pod/{pod}", *ports.split()]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        with self._lock:
            pid = self._next
            self._next += 1
            item = {"id": pid, "ctx": ctx, "ns": ns, "pod": pod, "ports": ports,
                    "proc": proc, "started": int(time.time()), "output": []}
            self._items[pid] = item
        threading.Thread(target=self._drain, args=(item,), daemon=True).start()
        return {"id": pid, "pod": pod, "ports": ports, "local": ports.split(":")[0]}

    def _drain(self, item: dict):
        assert item["proc"].stdout is not None
        for line in item["proc"].stdout:
            item["output"].append(line.rstrip())
            del item["output"][:-20]

    def list(self) -> list[dict]:
        out = []
        with self._lock:
            for pid, item in list(self._items.items()):
                alive = item["proc"].poll() is None
                if not alive:
                    self._items.pop(pid, None)
                    continue
                out.append({k: item[k] for k in ("id", "pod", "ns", "ports", "started")})
        return out

    def stop(self, pid: int) -> bool:
        with self._lock:
            item = self._items.pop(pid, None)
        if not item:
            return False
        try:
            item["proc"].terminate()
        except OSError:
            pass
        return True


FORWARDS = PortForwards()

# --------------------------------------------------------------------------
# background restart watcher
# --------------------------------------------------------------------------

def current_context() -> str:
    try:
        return kubectl(["config", "current-context"], timeout=10).strip()
    except KubeError:
        return ""


def background_watcher():
    """Keep restart history warm even when the UI is sitting on another tab."""
    ctx = current_context()
    if not ctx:
        log("no current context; background watcher disabled")
        return
    log(f"watching restarts in ctx={ctx} namespaces={WATCH_NAMESPACES}")
    while True:
        for ns in WATCH_NAMESPACES:
            try:
                pods = pod_rows(ctx, ns, {})
                RESTARTS.detect(ctx, ns, pods)
            except KubeError as exc:
                log(f"watcher {ns}: {exc.message}")
        time.sleep(15)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "podlite"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        if "/api/" not in (args[0] if args else ""):
            return

    # -- plumbing -----------------------------------------------------------
    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, body: str, status=200, ctype="text/plain; charset=utf-8"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _fail(self, exc: KubeError):
        self._json({"error": exc.message}, exc.status)

    def _q(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    # -- routing ------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/":
                return self._serve_file("index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                return self._serve_file(path[len("/static/"):])
            if path == "/api/health":
                return self._json({
                    "ok": True,
                    "writes": ALLOW_WRITES,
                    "context": current_context(),
                    "watch": WATCH_NAMESPACES,
                })
            if path == "/api/contexts":
                return self._json(self.contexts())
            if path == "/api/namespaces":
                return self._json(self.namespaces(self._q().get("ctx")))
            if path == "/api/pods":
                return self._json(self.pods(self._q()))
            if path == "/api/nodes":
                q = self._q()
                ctx = q.get("ctx") or current_context()
                ns = q.get("ns") or "default"
                pods = self.pods({"ctx": ctx, "ns": ns}).get("pods", [])
                rows, note = node_rows(ctx, pods)
                return self._json({"nodes": rows, "note": note, "ts": int(time.time())})
            if path == "/api/resources":
                q = self._q()
                kind = q.get("kind", "")
                if kind not in KINDS:
                    return self._json({"error": f"unsupported kind: {kind}"}, 400)
                ctx = q.get("ctx") or current_context()
                ns = q.get("ns") or "default"
                rows = generic_rows(kind, ctx, ns)
                return self._json({"kind": kind, "rows": rows, "ts": int(time.time())})
            if path == "/api/object":
                return self._json(self.object_detail(self._q()))
            if path == "/api/secret":
                return self._json(self.secret(self._q()))
            if path == "/api/yaml":
                q = self._q()
                return self._text(self.raw_object(q, "-o", "yaml"))
            if path == "/api/describe":
                q = self._q()
                return self._text(self.describe(q))
            if path == "/api/logs":
                return self.stream_logs(self._q())
            if path == "/api/restarts":
                q = self._q()
                after = int(q.get("after", 0))
                limit = int(q.get("limit", 200))
                return self._json({
                    "events": RESTARTS.since(after, limit),
                    "latest": RESTARTS.latest_seq(),
                    "count24h": RESTARTS.count_since(int(time.time()) - 86400),
                })
            if path == "/api/forwards":
                return self._json({"forwards": FORWARDS.list()})
            return self._json({"error": "not found"}, 404)
        except KubeError as exc:
            return self._fail(exc)
        except BrokenPipeError:
            return
        except Exception as exc:  # noqa: BLE001 - surface, never crash the server
            log(f"error on {path}: {type(exc).__name__}: {exc}")
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json({"error": "bad JSON body"}, 400)
        try:
            if path == "/api/action":
                return self._json(self.action(body))
            if path == "/api/forwards/start":
                if not ALLOW_WRITES:
                    return self._json({"error": "port-forward is disabled in read-only mode"}, 403)
                return self._json(FORWARDS.start(
                    body.get("ctx") or current_context(),
                    body.get("ns") or "default",
                    body["pod"], body["ports"]))
            if path == "/api/forwards/stop":
                return self._json({"stopped": FORWARDS.stop(int(body.get("id", 0)))})
            return self._json({"error": "not found"}, 404)
        except KubeError as exc:
            return self._fail(exc)
        except KeyError as exc:
            return self._json({"error": f"missing field: {exc}"}, 400)
        except Exception as exc:  # noqa: BLE001
            log(f"error on {path}: {type(exc).__name__}: {exc}")
            return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # -- handlers -----------------------------------------------------------
    def _serve_file(self, name: str, ctype: str | None = None):
        target = (STATIC / name).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            return self._json({"error": "not found"}, 404)
        if ctype is None:
            ctype = {
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".html": "text/html; charset=utf-8",
            }.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def contexts(self):
        raw = kubectl(["config", "view", "-o", "json"], timeout=15)
        view = json.loads(raw)
        out = []
        current = view.get("current-context") or ""
        ctx_objects = {c["name"]: c.get("context", {}) for c in view.get("contexts") or []}
        for name, body in ctx_objects.items():
            out.append({
                "name": name,
                "cluster": body.get("cluster") or "",
                "namespace": body.get("namespace") or "default",
                "current": name == current,
            })
        out.sort(key=lambda c: (not c["current"], c["name"]))
        return {"contexts": out, "current": current}

    def namespaces(self, ctx: str | None):
        cached = CACHE.get(f"ns:{ctx}", 30)
        if cached is not None:
            return cached
        raw = kubectl_json(["get", "namespaces"], ctx=ctx)
        names = sorted(i["metadata"]["name"] for i in raw.get("items", [])
                       if (i.get("status") or {}).get("phase") != "Terminating")
        payload = {"namespaces": names}
        CACHE.put(f"ns:{ctx}", payload)
        return payload

    def pods(self, q: dict):
        ctx = q.get("ctx") or current_context()
        ns = q.get("ns") or "default"
        # pods + metrics are independent kubectl calls; run them together
        with ThreadPoolExecutor(max_workers=2) as pool:
            metrics_future = pool.submit(pod_metrics, ctx, ns)
            rows = pod_rows(ctx, ns, {})
            metrics = metrics_future.result()
        for row in rows:
            cpu, mem = metrics.get(row["name"], (0.0, 0.0))
            row.update({"cpu": cpu, "mem": mem, "cpuText": fmt_cpu(cpu), "memText": fmt_mem(mem)})
        RESTARTS.detect(ctx, ns, rows)
        latest = RESTARTS.latest_seq()
        return {
            "pods": rows,
            "ts": int(time.time()),
            "ctx": ctx,
            "ns": ns,
            "latestRestart": latest,
            "summary": {
                "total": len(rows),
                "ready": sum(1 for p in rows if p["ready"]),
                "problems": sum(1 for p in rows if p["status"] not in ("Running", "Completed")),
                "restarts": sum(p["restarts"] for p in rows),
                "nodes": len({p["node"] for p in rows if p["node"]}),
            },
        }

    def _resolve(self, q: dict) -> tuple[str, str, str, str | None]:
        kind = q.get("kind", "pods")
        if kind not in KINDS:
            raise KubeError(f"unsupported kind: {kind}", 400)
        ctx = q.get("ctx") or current_context()
        ns = None if kind in CLUSTER_SCOPED else (q.get("ns") or "default")
        name = q.get("name", "")
        if not name:
            raise KubeError("missing name", 400)
        return ctx, kind, name, ns

    def object_detail(self, q: dict):
        ctx, kind, name, ns = self._resolve(q)
        raw = kubectl_json(["get", KINDS[kind], name], ctx=ctx, ns=ns)
        return {"kind": kind, "object": raw}

    def secret(self, q: dict):
        ctx, kind, name, ns = self._resolve({**q, "kind": "secrets"})
        raw = kubectl_json(["get", "secrets", name], ctx=ctx, ns=ns)
        decoded = {}
        for key, value in (raw.get("data") or {}).items():
            try:
                decoded[key] = base64.b64decode(value).decode("utf-8", "replace")
            except (ValueError, TypeError):
                decoded[key] = "<binary>"
        return {"name": name, "type": raw.get("type") or "", "data": decoded}

    def raw_object(self, q: dict, *args):
        ctx, kind, name, ns = self._resolve(q)
        return kubectl(["get", KINDS[kind], name, *args], ctx=ctx, ns=ns)

    def describe(self, q: dict):
        ctx, kind, name, ns = self._resolve(q)
        return kubectl(["describe", KINDS[kind], name], ctx=ctx, ns=ns)

    def stream_logs(self, q: dict):
        ctx = q.get("ctx") or current_context()
        ns = q.get("ns") or "default"
        pod = q.get("pod") or ""
        container = q.get("container") or None
        tail = q.get("tail") or "300"
        follow = q.get("follow") == "1"
        previous = q.get("previous") == "1"
        timestamps = q.get("timestamps") == "1"
        if not pod:
            return self._json({"error": "missing pod"}, 400)
        cmd = [KUBECTL, "--context", ctx, "-n", ns, "logs", pod, f"--tail={tail}",
               f"--timestamps={'true' if timestamps else 'false'}"]
        if container:
            cmd += ["-c", container]
        if previous:
            cmd.append("--previous")
        if follow:
            cmd.append("--follow")

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(data: bytes):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()

        proc = None
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            assert proc.stdout is not None
            for line in proc.stdout:
                chunk(line.encode())
            proc.wait()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                chunk(f"\n[podlite] stream error: {exc}\n".encode())
            except OSError:
                return
        finally:
            try:
                if proc is not None and proc.poll() is None:
                    proc.terminate()
            except OSError:
                pass
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                pass

    def action(self, body: dict):
        kind = body.get("action", "")
        ctx = body.get("ctx") or current_context()
        ns = body.get("ns") or "default"

        if kind == "exec":
            if not ALLOW_WRITES:
                raise KubeError("exec is disabled in read-only mode (PODLITE_ALLOW_WRITES=1)", 403)
            pod = body.get("pod")
            cmd = body.get("cmd") or ""
            if not pod or not cmd:
                raise KubeError("missing pod or cmd", 400)
            args = ["exec", pod]
            if body.get("container"):
                args += ["-c", body["container"]]
            args += ["--", "sh", "-c", cmd]
            try:
                out = kubectl(args, ctx=ctx, ns=ns, timeout=40, check=False)
            except KubeError as exc:
                raise exc
            return {"output": out}

        if not ALLOW_WRITES:
            raise KubeError("action disabled in read-only mode (set PODLITE_ALLOW_WRITES=1)", 403)

        if kind == "delete-pod":
            out = kubectl(["delete", "pod", body["pod"], "--wait=false"], ctx=ctx, ns=ns, check=False)
            CACHE.drop()
            return {"output": out}

        if kind == "save-configmap":
            return self.save_configmap(body, ctx, ns)

        if kind == "rollout-restart":
            out = kubectl(["rollout", "restart", body["kind"], body["name"]], ctx=ctx, ns=ns, check=False)
            CACHE.drop()
            return {"output": out}

        if kind == "scale":
            replicas = str(int(body["replicas"]))
            out = kubectl(["scale", body["kind"], body["name"], f"--replicas={replicas}"],
                          ctx=ctx, ns=ns, check=False)
            CACHE.drop()
            return {"output": out}

        raise KubeError(f"unknown action: {kind}", 400)

    def save_configmap(self, body: dict, ctx: str, ns: str) -> dict:
        """
        Replace a configmap's data map.

        Uses `kubectl replace` with the resourceVersion we read, so a concurrent
        edit fails loudly (409) instead of being silently overwritten.
        """
        name = body.get("name") or ""
        data = body.get("data")
        expected_rv = body.get("resourceVersion") or ""
        if not name:
            raise KubeError("missing configmap name", 400)
        if not isinstance(data, dict):
            raise KubeError("data must be an object of key -> string", 400)

        clean = {}
        for key, value in data.items():
            if not isinstance(key, str) or not CONFIG_KEY_RE.match(key):
                raise KubeError(
                    f"invalid key {key!r}: use letters, digits, '-', '_' or '.'", 400)
            if not isinstance(value, str):
                raise KubeError(f"value for {key!r} must be a string", 400)
            clean[key] = value

        live = kubectl_json(["get", "configmaps", name], ctx=ctx, ns=ns)
        meta = live.get("metadata") or {}
        if live.get("immutable"):
            raise KubeError(f"configmap {name} is immutable: it cannot be edited", 409)
        live_rv = str(meta.get("resourceVersion") or "")
        if expected_rv and live_rv and expected_rv != live_rv:
            raise KubeError(
                "configmap changed since you opened it (someone else edited it). "
                "Reload the key list and re-apply your change.", 409)

        before = live.get("data") or {}
        changed = sorted(k for k in clean if before.get(k) != clean.get(k))
        removed = sorted(k for k in before if k not in clean)

        live["data"] = clean
        live.pop("managedFields", None)
        out = kubectl(["replace", "-f", "-", "-o", "json"], ctx=ctx, ns=ns,
                      stdin=json.dumps(live))
        try:
            new_rv = str((json.loads(out).get("metadata") or {}).get("resourceVersion") or "")
        except json.JSONDecodeError:
            new_rv = ""
        CACHE.drop()
        return {
            "name": name,
            "resourceVersion": new_rv,
            "changed": changed,
            "removed": removed,
            "keys": len(clean),
        }


def main():
    global PORT
    args = sys.argv[1:]
    if "--open" in args:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    args = [a for a in args if a != "--open"]
    if args and args[0].isdigit():
        PORT = int(args[0])

    HOME_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=background_watcher, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    log(f"podlite on http://127.0.0.1:{PORT}  (writes={'ON' if ALLOW_WRITES else 'off'})")
    if not ALLOW_WRITES:
        log("read-only mode: delete / rollout restart / exec / port-forward are locked")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("bye")


if __name__ == "__main__":
    main()
