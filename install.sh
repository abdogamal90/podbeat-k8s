#!/usr/bin/env bash
# Install podbeat into the Ubuntu app grid.
#
#   ./install.sh              # install
#   ./install.sh --uninstall  # remove
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor/scalable/apps"
BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
DESKTOP_FILE="$APPS/podbeat.desktop"
ICON_FILE="$ICONS/podbeat.svg"

# --writes: launch the app with edit/restart/delete/exec unlocked
EXEC_PREFIX=""
for arg in "$@"; do
  [[ "$arg" == "--writes" ]] && EXEC_PREFIX="env PODBEAT_ALLOW_WRITES=1 "
done

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DESKTOP_FILE" "$ICON_FILE" "$BIN/podbeat"
  update-desktop-database "$APPS" 2>/dev/null || true
  echo "podbeat removed from the app grid"
  exit 0
fi

chmod +x "$DIR/podbeat-app.py" "$DIR/podbeat.sh"
mkdir -p "$APPS" "$ICONS" "$BIN"
cp "$DIR/static/icon.svg" "$ICON_FILE"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=podbeat
GenericName=Kubernetes dashboard
Comment=Pods, nodes and restarts without the bloat
Exec=${EXEC_PREFIX}"$DIR/podbeat-app.py"
TryExec=$DIR/podbeat-app.py
Path=$DIR
Icon=podbeat
Terminal=false
Categories=Development;
Keywords=kubernetes;k8s;kubectl;pods;nodes;restarts;lens;
StartupNotify=true
StartupWMClass=podbeat
EOF

ln -sf "$DIR/podbeat-app.py" "$BIN/podbeat"

desktop-file-validate "$DESKTOP_FILE" 2>/dev/null || true
update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -f -t "$DATA/icons/hicolor" 2>/dev/null || true

echo "installed:"
echo "  app grid entry  $DESKTOP_FILE"
echo "  icon            $ICON_FILE"
echo "  cli             $BIN/podbeat"
if [[ -n "$EXEC_PREFIX" ]]; then
  echo "  mode            WRITE (edit configmaps, restart, delete, exec)"
else
  echo "  mode            read-only (re-run ./install.sh --writes to unlock writes)"
fi
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo
     echo "note: $BIN is not in PATH - run the app from the grid, or add:"
     echo "  export PATH=\"$BIN:\$PATH\"" ;;
esac

if ! "$DIR/podbeat-app.py" --check 2>&1 | grep -q '^backend     gtk'; then
  echo
  echo "warning: no WebKitGTK window available - podbeat will open a Chrome app window."
  echo "install the native window with:"
  echo "  sudo apt install python3-gi gir1.2-webkit-6.0"
fi
