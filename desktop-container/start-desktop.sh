#!/bin/bash
set -euo pipefail
umask 077
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.vnc"
chmod 700 "$XDG_RUNTIME_DIR"
if [ ! -f "$HOME/.vnc/passwd" ]; then
  password=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
  printf '%s\n' "$password" > "$HOME/.vnc/viewer-password"
  x11vnc -storepasswd "$password" "$HOME/.vnc/passwd" >/dev/null
  unset password
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0"
fi
children=()
cleanup() { kill "${children[@]}" 2>/dev/null || true; wait || true; }
trap cleanup EXIT
trap 'exit 0' TERM INT
# This container owns display :99; a stopped Xvfb can leave its lock behind.
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
fi
# Provision once inside the private home volume; never put this in the image.
mkdir -p "$HOME/.local/share/desktop"
chmod 700 "$HOME/.local/share/desktop"
keyring_password="$HOME/.local/share/desktop/keyring-password"
if [ ! -s "$keyring_password" ]; then
  python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > "$keyring_password"
fi
chmod 600 "$keyring_password"
gnome-keyring-daemon --unlock --components=secrets < "$keyring_password" >/dev/null
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -noreset &
children+=($!)
for i in {1..100}; do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.1
done
xdpyinfo -display :99 >/dev/null
openbox &
children+=($!)
# The viewer binds only to host loopback through Compose, and VNC requires a password.
x11vnc -display :99 -rfbport 5900 -localhost -forever -shared \
  -rfbauth "$HOME/.vnc/passwd" -noxdamage &
children+=($!)
websockify --web=/usr/share/novnc/ 6080 127.0.0.1:5900 &
children+=($!)
chatgpt --disable-gpu --ozone-platform=x11 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 &
children+=($!)
printf '%s\n' "$!" > /tmp/chatgpt-desktop.pid
if { [ -f /data/node.json ] || [ -f /data/experts.json ]; } && [ -f /data/board.env ]; then
  flock --nonblock /data/desktop-startup.lock node /opt/board/desktop_startup.mjs > /data/desktop-startup.log 2>&1 &
fi
echo 'Desktop started. Viewer: http://127.0.0.1:6080/vnc.html. Password: /home/desktop/.vnc/viewer-password (inside container).'
wait -n "${children[@]}"
exit 1
