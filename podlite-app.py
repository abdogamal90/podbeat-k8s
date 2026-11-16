#!/usr/bin/env python3
"""
podlite desktop app - the same tiny dashboard, in a native window.

No Electron. This is a WebKitGTK window pointed at the podlite server, which
it starts itself and stops when you close the window. If WebKitGTK is missing
it falls back to a Chrome app window, then to your default browser.

    podlite-app.py            # native window
    podlite-app.py --browser  # force a browser window
    podlite-app.py --check    # print what it would use, start/stop the server, exit
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE / "podlite.py"
PORT = int(os.environ.get("PODLITE_PORT", "8484"))
URL = f"http://127.0.0.1:{PORT}/"
APP_ID = "io.cartona.podlite"
HOME_DIR = Path(os.environ.get("PODLITE_HOME", Path.home() / ".podlite"))
SERVER_LOG = HOME_DIR / "server.log"
START_TIMEOUT = 20.0
WINDOW_SIZE = (1440, 900)


def configure_webkit_environment() -> str:
    """
    WebKitGTK sandboxes its web/network processes with bubblewrap, which needs
    unprivileged user namespaces. On Ubuntu 24.04 those are restricted
    (kernel.apparmor_restrict_unprivileged_userns=1) and inside a GNOME app
    scope bwrap dies with "setting up uid map: Permission denied", so the web
    process never starts and the page can never load.

    The UI only ever loads http://127.0.0.1:<port>, so the sandbox buys little
    here. Disable it by default; PODLITE_WEB_SANDBOX=1 puts it back.
    """
    if os.environ.get("PODLITE_WEB_SANDBOX") == "1":
        os.environ.pop("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", None)
        return "web sandbox: on (PODLITE_WEB_SANDBOX=1)"
    os.environ["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"
    return "web sandbox: off (localhost-only UI; PODLITE_WEB_SANDBOX=1 to enable)"


# --------------------------------------------------------------------------
# server lifecycle
# --------------------------------------------------------------------------

def healthy(timeout: float = 0.8) -> bool:
    try:
        with urllib.request.urlopen(URL + "api/health", timeout=timeout) as res:
            return res.status == 200
    except Exception:
        return False


def _die_with_parent() -> None:
    """Make the server exit if the app dies, even on SIGKILL (Linux PR_SET_PDEATHSIG)."""
    try:
        import ctypes

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        pr_set_pdeathsig = 1
        libc.prctl(pr_set_pdeathsig, signal.SIGTERM)
    except Exception:
        pass


def start_server() -> subprocess.Popen | None:
    """Start the backend unless one is already listening. Returns our child, or None."""
    if healthy():
        print(f"podlite server already running on {URL} - attaching")
        return None
    if not SERVER.exists():
        raise SystemExit(f"missing {SERVER}")
    HOME_DIR.mkdir(parents=True, exist_ok=True)
    log = SERVER_LOG.open("a")
    log.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} starting ---\n")
    log.flush()
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(PORT)],
        cwd=str(HERE),
        stdout=log,
        stderr=subprocess.STDOUT,
        preexec_fn=_die_with_parent,
    )
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"podlite server exited immediately - see {SERVER_LOG}")
        if healthy():
            return proc
        time.sleep(0.15)
    proc.terminate()
    raise SystemExit(f"podlite server did not come up in {START_TIMEOUT:.0f}s - see {SERVER_LOG}")


def stop_server(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


# --------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------

def detect_backend() -> str:
    for name, gtk, version, module in (
        ("gtk4", "4.0", "6.0", "WebKit"),
        ("gtk3", "3.0", "4.1", "WebKit2"),
    ):
        try:
            import gi  # optional dependency, probed at runtime

            gi.require_version("Gtk", gtk)
            gi.require_version(module, version)
            import importlib

            importlib.import_module(f"gi.repository.{module}")
            return name
        except Exception:
            continue
    return "browser"


def run_gtk4() -> None:
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("WebKit", "6.0")
    from gi.repository import Gdk, Gio, GLib, Gtk, WebKit

    GLib.set_prgname("podlite")
    GLib.set_application_name("podlite")
    settings = Gtk.Settings.get_default()
    if settings is not None:
        settings.set_property("gtk-application-prefer-dark-theme", True)

    app = Gtk.Application(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
    windows: list = []

    def quit_on_signal(*_args):
        # let the main loop unwind so the server child is stopped cleanly
        app.quit()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, quit_on_signal)
    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT, quit_on_signal)

    def activate(application):
        # clicking the icon again must focus the window, not spawn a second one
        if windows:
            windows[0].present()
            return
        window = Gtk.ApplicationWindow(application=application, title="podlite")
        window.set_default_size(*WINDOW_SIZE)
        view = WebKit.WebView()
        view.get_settings().set_property("enable-developer-extras", True)
        view.load_uri(URL)
        window.set_child(view)

        keys = Gtk.EventControllerKey()

        def on_key(_controller, keyval, _code, state):
            ctrl = bool(state & Gdk.ModifierType.CONTROL_MASK)
            if ctrl and keyval in (Gdk.KEY_r, Gdk.KEY_R):
                view.reload()
                return True
            if keyval == Gdk.KEY_F11:
                window.set_fullscreened(not window.get_fullscreened())
                return True
            if ctrl and keyval in (Gdk.KEY_q, Gdk.KEY_Q):
                application.quit()
                return True
            if ctrl and (state & Gdk.ModifierType.SHIFT_MASK) and keyval in (Gdk.KEY_I, Gdk.KEY_i):
                try:
                    view.get_inspector().show()
                except Exception:
                    pass
                return True
            return False

        keys.connect("key-pressed", on_key)
        window.add_controller(keys)
        window.present()
        windows.append(window)

    app.connect("activate", activate)
    app.run([])


def run_gtk3() -> None:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2

    GLib.set_prgname("podlite")
    GLib.set_application_name("podlite")
    Gdk.set_program_class("podlite")
    settings = Gtk.Settings.get_default()
    if settings is not None:
        settings.set_property("gtk-application-prefer-dark-theme", True)

    app = Gtk.Application(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
    windows: list = []

    def quit_on_signal(*_args):
        app.quit()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGTERM, quit_on_signal)
    GLib.unix_signal_add(GLib.PRIORITY_HIGH, signal.SIGINT, quit_on_signal)

    def activate(application):
        if windows:
            windows[0].present()
            return
        window = Gtk.ApplicationWindow(application=application, title="podlite")
        window.set_default_size(*WINDOW_SIZE)
        view = WebKit2.WebView()
        view.get_settings().set_property("enable-developer-extras", True)
        view.load_uri(URL)
        window.add(view)
        window.show_all()

        keys = Gtk.EventControllerKey()

        def on_key(_controller, keyval, _code, state):
            ctrl = bool(state & Gdk.ModifierType.CONTROL_MASK)
            if ctrl and keyval in (Gdk.KEY_r, Gdk.KEY_R):
                view.reload()
                return True
            if keyval == Gdk.KEY_F11:
                if window.get_window() and window.get_window().get_state() & Gdk.WindowState.FULLSCREEN:
                    window.unfullscreen()
                else:
                    window.fullscreen()
                return True
            if ctrl and keyval in (Gdk.KEY_q, Gdk.KEY_Q):
                application.quit()
                return True
            return False

        keys.connect("key-pressed", on_key)
        window.add_controller(keys)
        windows.append(window)

    app.connect("activate", activate)
    app.run([])


def run_browser() -> None:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"):
        exe = shutil.which(name)
        if not exe:
            continue
        width, height = WINDOW_SIZE
        chrome = subprocess.Popen([
            exe,
            f"--app={URL}",
            f"--window-size={width},{height}",
            "--class=podlite",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        try:
            chrome.wait()
        finally:
            if chrome.poll() is None:
                chrome.terminate()
        return

    opener = shutil.which("xdg-open")
    if not opener:
        raise SystemExit("no webview and no browser found - open " + URL + " manually")
    subprocess.Popen([opener, URL])
    print(f"opened {URL} in your browser - Ctrl+C here to stop the server")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def run_check() -> int:
    backend = detect_backend()
    print(f"python      {sys.version.split()[0]}")
    print(f"backend     {backend}")
    print(f"{configure_webkit_environment()}")
    print(f"bwrap       {'usable' if userns_usable() else 'blocked (userns restricted)'}")
    proc = start_server()
    try:
        print(f"server      {'up at ' + URL if healthy() else 'NOT responding'}")
        print(f"log         {SERVER_LOG}")
    finally:
        stop_server(proc)
    print("server      stopped")
    return 0


def userns_usable() -> bool:
    """Can bwrap (WebKit's sandbox helper) create a user namespace here?"""
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return False
    try:
        probe = subprocess.run(
            [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-user", "--unshare-pid", "true"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
        )
        return probe.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="podlite desktop window")
    parser.add_argument("--browser", action="store_true", help="force a browser window")
    parser.add_argument("--check", action="store_true", help="report the environment and exit")
    args = parser.parse_args()

    if args.check:
        return run_check()

    configure_webkit_environment()
    backend = "browser" if args.browser else detect_backend()
    proc = start_server()
    try:
        if backend == "gtk4":
            run_gtk4()
        elif backend == "gtk3":
            run_gtk3()
        else:
            run_browser()
    except KeyboardInterrupt:
        pass
    finally:
        stop_server(proc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
