# podbeat-k8s

A tiny Kubernetes dashboard for the daily loop: **pods, nodes, restarts, logs, configmaps — without the bloat.**

No Electron, no account, no telemetry, no dependencies. One Python file (stdlib only) that shells out to your existing `kubectl`, a single-page UI with no build step, and a native GTK window on Linux.

> Not affiliated with Elastic Beats or the Podbeat podcast app.

## Why

Lens needs a login and ~1–2 GB of Electron; k9s is fast but terminal-only. podbeat is the boring middle: a native window that answers *what restarted, when, and why* in one glance, and stays out of the way.

## Quick start

```sh
git clone https://github.com/abdogamal90/podbeat-k8s
cd podbeat-k8s
./podbeat.sh          # opens http://127.0.0.1:8484 in your browser
```

Requirements: Python 3.9+, `kubectl` on PATH, a working kubeconfig. Linux gives you the native window; everything else gets the browser UI.

## Install as a Linux desktop app

```sh
./install.sh              # read-only mode
./install.sh --writes     # also unlock edits/restarts/exec in the launcher
./install.sh --uninstall
```

You get an app-grid entry, an icon, and a `podbeat` command. The window is GTK4 + WebKitGTK, with a Chrome `--app` window and plain browser as fallbacks. Check your backend with `./podbeat-app.py --check`.

## What you can do without typing kubectl

| tab | shows |
|---|---|
| **pods** | status, ready, restarts, **last restart + reason**, **up** (container uptime), cpu/mem, node, age — sorted by uptime, newest first; filters: problems / restarted <24h / crashloop+oom / not ready |
| **nodes** | instance type, node group, spot vs on-demand, zone, pod count, restarts, cpu/mem (derived from node metrics when RBAC blocks node objects) |
| **deploys** | ready/desired, image, strategy, rollout restart, scale |
| **services** | type, cluster IP, ports, selector, LB |
| **configmaps** | every key, full value, copy, **edit** (add/change/remove keys) |
| **secrets** | types + keys, values blurred until revealed — *if your RBAC allows reading them* |
| **events** | cluster events — *if your RBAC allows them* |
| **restarts** | podbeat's own restart timeline: when, container, reason, exit code, how long it ran, running total |

Per pod: containers with requests/limits, **live logs (follow, previous crashed container, timestamps)**, restart history, YAML, describe. Per deployment: rollout restart and scale. Plus port-forward and exec.

`up` vs `age`: **up** is how long the current container has run; **age** is how long the pod object has existed. A pod that restarted 5 minutes ago out of a 3-day-old pod shows `up 5m` / `age 3d`.

## Editing configmaps

Open a configmap → **data** tab → **edit**. Textarea per key, add/remove keys, save. Before writing you get a confirm dialog listing exactly what changes, and the editor bar tells you if you are on a cluster whose name matches your prod marker. Safety rails:

- **conflict detection** — the save carries the `resourceVersion` you opened with; if someone edited it meanwhile you get a 409, not a silent overwrite
- immutable configmaps are refused; keys are validated against k8s naming rules; only `data` is replaced
- mounted files refresh within ~1 minute; env vars need a pod restart (the editor says so)

## Keyboard

`/` filter · `1`–`8` tabs · `j`/`k` move · `enter` open · `l` logs · `y` yaml · `d` describe · `c` collapse panel · `r` refresh · `esc` close

## Restart history

podbeat records every container restart it sees into `~/.podbeat/restarts.jsonl` (a background watcher polls `PODBEAT_WATCH_NAMESPACES`, default `default`). This is podbeat's own record: k8s events expire after ~1h and many users can't list them at all, so the tool keeps the timeline itself. On first sight of a container that already restarted, it seeds one event from the pod's own `lastState`.

## Security model

- **Read-only by default.** Delete/restart/scale/configmap-edit/exec/port-forward are locked until `PODBEAT_ALLOW_WRITES=1`. Destructive actions confirm in-page; exec also confirms when the prod marker matches.
- **The server binds 127.0.0.1 only** and requires a per-launch random token (plus Host and Origin checks) on every API call, so other websites cannot drive it (no CSRF) or read from it (no DNS rebinding). The UI fetches the token same-origin from `/api/health`; every response carries a CSP including `frame-ancestors 'self'`.
- **Single-user assumption.** The token handout means any *local OS account* on a shared machine could read the token and use your kubeconfig authority through podbeat. On a single-user workstation that collapses to processes you already own (they can run kubectl directly). **Do not run write mode on multi-user hosts.**
- A quick-profile security review (Cloudflare's `security-audit-skill` workflow, Nov 2026) found no confirmed vulnerabilities; the loopback token bootstrap above is its one documented caveat.
- The desktop window disables WebKit's sandbox by default because Ubuntu 24.04's AppArmor userns restrictions break it (`bwrap: setting up uid map: Permission denied`). The UI only ever loads `127.0.0.1`; set `PODBEAT_WEB_SANDBOX=1` to force the sandbox back on.

## Env knobs

| var | default | meaning |
|---|---|---|
| `PODBEAT_PORT` | `8484` | http port |
| `PODBEAT_KUBECTL` | `kubectl` | kubectl binary (point at a stub for testing) |
| `PODBEAT_TIMEOUT` | `25` | seconds per kubectl call |
| `PODBEAT_ALLOW_WRITES` | `0` | unlock delete/restart/scale/configmap-edit/exec/port-forward |
| `PODBEAT_WATCH_NAMESPACES` | `default` | namespaces for the restart watcher |
| `PODBEAT_PROD_PATTERN` | `prod` | context names matching this get the PRODUCTION marker |
| `PODBEAT_HOME` | `~/.podbeat` | state (restart history, server log) |
| `PODBEAT_WEB_SANDBOX` | unset | `1` re-enables the WebKit sandbox |

## Troubleshooting

- **"cloud session expired"** → re-authenticate with your provider (`aws sso login`, `gcloud auth login`, …) and retry.
- **window opens but stays empty / shows `Load failed`** → WebKit's sandbox cannot start on your distro; podbeat disables it by default, so if you forced `PODBEAT_WEB_SANDBOX=1`, unset it.
- **nothing happens when clicking the icon** → an instance is already running; it should raise its window. Check `pgrep -af podbeat-app`.
- **secrets/events tabs say "blocked for your user"** → that is your RBAC, not a bug; the restart history does not depend on events.
- **port in use** → `PODBEAT_PORT=8585 ./podbeat.sh`

Uninstall removes the launcher, icon and symlink; `rm -rf ~/.podbeat` removes the local state.

## Layout

```
podbeat.py        backend: kubectl wrapper, JSON API, log streaming (stdlib only)
podbeat-app.py    native window + server supervisor
podbeat.sh        browser launcher
install.sh        app-grid installer
static/           index.html, app.js, style.css, icon.svg — no framework, no build
```
