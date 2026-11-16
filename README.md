# podlite

A dumb, tiny kubectl dashboard. Replaces Lens for the one job that matters:
**see pods, nodes, and every restart — without 400MB of Electron.**

- native GTK window (WebKitGTK) — no Electron, no bundled browser
- one Python file backend, stdlib only, no build step, no dependencies
- talks to `kubectl` under the hood, so kubeconfig / EKS auth just work
- keeps its **own restart history**, so you can answer "did it restart again?" even after k8s events expire

## Install as an Ubuntu app

```sh
cd ~/personal/podlite
./install.sh
```

Then find **podlite** in the app grid (Super → type "podlite"), pin it to the
dock, or run `podlite` from a terminal. It gets a real window, its own icon,
and Ctrl+R / F11 / Ctrl+Q.

```sh
./install.sh              # install (read-only)
./install.sh --writes     # install with edits/restarts/exec unlocked
./install.sh --uninstall  # remove
```

What the launcher does: starts the backend on `127.0.0.1:8484` if it isn't
already running, opens a WebKitGTK window pointed at it, and stops the backend
when you close the window. If one is already running, it just attaches.

| backend | when |
|---|---|
| GTK4 + WebKit 6.0 | default on Ubuntu 24.04 |
| GTK3 + WebKit2 4.1 | older Ubuntu |
| Chrome/Chromium `--app` window | if WebKitGTK is missing |
| default browser | last resort |

Native window needs `python3-gi` + `gir1.2-webkit-6.0` (`sudo apt install`
if you uninstalled them). Check what you have:

```sh
./podlite-app.py --check
```

## Or just run the web UI

```sh
./podlite.sh        # opens http://127.0.0.1:8484 in your browser
```

Read-only by default. Writes (delete pod, rollout restart, scale, exec,
port-forward) stay locked until you say so:

```sh
PODLITE_ALLOW_WRITES=1 ./podlite.sh
```

## What you can do without typing kubectl

| Tab | Shows |
|---|---|
| **pods** | status, ready, restarts, **last restart + reason**, **up** (container uptime), cpu/mem, node, age. Sorted by **up, newest first** (just restarted = top of the list); click any header to re-sort. Filters: problems / restarted <24h / crashloop+oom / not ready |
| **nodes** | instance type, node group, spot vs on-demand, AZ, pod count, restarts, cpu/mem |
| **deploys** | ready/desired, image, strategy |
| **services** | type, cluster IP, ports, selector, external LB |
| **configmaps** | every key, full value, copy, **edit** (add/change/remove keys) |
| **secrets** | types + key names (values blur until revealed) — *if RBAC allows* |
| **events** | cluster events — *if RBAC allows* |
| **restarts** | podlite's own restart timeline: when, container, reason (OOMKilled / Error / Completed), exit code, how long it ran, running total |

Per pod (click or `enter`): overview + containers, **logs (live tail, follow,
previous container of a crashed pod)**, restart history, YAML, describe, actions.
The detail panel is collapsible (`c` or `»`) into a thin rail, and it closes
itself when you switch tabs — the table always gets the space back.

Per deployment: rollout restart, scale, YAML, describe. Destructive actions
confirm in an in-page dialog (no native `confirm()` surprises).

## Editing configmaps

Open a configmap → **data** tab → **edit**. You get a textarea per key: rename
keys, change values, delete keys (`✕`), add keys (`+ key`), then **save**.

Before writing you get a confirm dialog listing exactly what changes
(`changed: A, C` / `removed: B`), and the editor bar tells you if you're on
**PRODUCTION**.

Safety rails:

- **resourceVersion check** — if someone edited the configmap between opening
  it and saving, you get a conflict instead of silently overwriting their work
  (verified against the real API: `Operation cannot be fulfilled ... object has
  been modified`).
- **immutable configmaps** are refused with a clear message.
- keys validated against the k8s rules (`letters, digits, - _ .`), duplicates
  and non-string values rejected before anything is sent.
- only `data` is replaced; labels, annotations, `binaryData` stay untouched.
- everything else (labels, deletion, etc.) is still kubectl — this is a
  configmap editor, not a manifest editor.

Editing requires write mode:

```sh
PODLITE_ALLOW_WRITES=1 ./podlite.sh     # browser
./install.sh --writes                   # desktop app, persists in the launcher
```

After saving: **mounted files refresh within ~1 minute, env vars need a pod
restart** — the editor says so, and you can restart the deployment from the
deploys tab.

`up` vs `age`: **up** = how long the current container has been running,
**age** = how long the pod object has existed. A pod that restarted 5m ago out
of a 3-day-old pod shows `up 5m` / `age 3d`. The table is ordered by `up`
ascending, so whatever started most recently sits at the top.

## Keyboard (the whole point for an impatient human)

| key | action |
|---|---|
| `/` | filter |
| `1`–`8` | jump to tab |
| `j` / `k` | move selection |
| `enter` | open detail |
| `l` | logs for selected pod |
| `y` / `d` | yaml / describe |
| `c` | collapse / expand detail panel |
| `r` | refresh |
| `esc` | close panel / clear filter |

Restarts pop up as a toast in the corner; click it to open that pod.

## Restart history

Stored at `~/.podlite/restarts.jsonl` (append-only JSON lines).

podlite records a restart whenever a container's restart count goes up while
it is watching. A background watcher polls `PODLITE_WATCH_NAMESPACES` (default
`default`) every 15s, so history keeps filling even when the browser tab is
closed to another view.

On first sight of a container that has already restarted, podlite seeds one
event from the pod's own `lastState` (tagged **prior**), so the tab isn't empty
on day one. Restarting podlite does not duplicate those seeds.

```sh
PODLITE_WATCH_NAMESPACES=default,kube-system ./podlite.sh
```

## Known RBAC reality (prod / `cartona-developers`)

This IAM user cannot list `nodes`, `secrets`, or `events` at cluster scope. So:

- **nodes** are built from node metrics + pod placement — you still get instance
  type, node group, capacity type, AZ, pod count, cpu/mem. Just not kubelet
  conditions/taints.
- **secrets** and **events** tabs explain the block in plain words instead of
  throwing an API error at you. Ask for read RBAC if you need them.
- restart history does **not** depend on events — that is why it is recorded
  locally.

## Env knobs

| var | default | meaning |
|---|---|---|
| `PODLITE_PORT` | `8484` | http port |
| `PODLITE_KUBECTL` | `kubectl` | kubectl binary |
| `PODLITE_TIMEOUT` | `25` | seconds per kubectl call |
| `PODLITE_ALLOW_WRITES` | `0` | unlock delete/restart/scale/exec/port-forward |
| `PODLITE_WATCH_NAMESPACES` | `default` | namespaces for the restart watcher |
| `PODLITE_HOME` | `~/.podlite` | restart history location |

## Layout

```
podlite/
├── podlite-app.py      # native window (WebKitGTK) + server supervision
├── podlite.py          # backend: kubectl wrapper, JSON API, log streaming
├── podlite.sh          # browser launcher
├── install.sh          # app grid entry + icon + `podlite` command
└── static/
    ├── index.html
    ├── style.css
    ├── app.js          # vanilla js, no framework
    └── icon.svg
```

Server log (when launched from the app): `~/.podlite/server.log`.

## Troubleshooting

- **window opens but stays empty / shows `Load failed`** → Ubuntu 24.04 restricts
  unprivileged user namespaces, so WebKit's bubblewrap sandbox can't start
  inside a GNOME app scope (`bwrap: setting up uid map: Permission denied`,
  then `Failed to fully launch dbus-proxy`), and the page can never load.
  podlite turns that sandbox off by default because the UI only loads
  `127.0.0.1`. To force it back on: `PODLITE_WEB_SANDBOX=1 podlite`.
  Check with `podlite-app.py --check`.
- **"AWS session expired"** → `aws sso login --profile ProdViewOnlyAccess-188113730724`
- **empty namespace** → switch context in the top bar; it remembers the
  context's default namespace
- **port in use** → `PODLITE_PORT=8585 ./podlite.sh`
- **native window is black/blank** → `WEBKIT_DISABLE_DMABUF_RENDERER=1 podlite`
  (old Mesa/NVIDIA drivers), or force a Chrome window: `podlite-app.py --browser`
- **window closed but server still running** → it was already running before
  the app started; `fuser -k 8484/tcp`
- **nothing happens when clicking the icon** → an instance is already running;
  it should raise its window. Check `pgrep -af podlite-app` and
  `journalctl --user -n 50 | grep podlite`.
