#!/usr/bin/env bash
set -euo pipefail

url="http://127.0.0.1:${JARVIS_UI_PORT:-8765}/"
for _ in $(seq 1 90); do
  if curl --fail --silent --max-time 1 "$url" >/dev/null; then
    break
  fi
  sleep 1
done

if command -v chromium >/dev/null 2>&1; then
  browser=chromium
elif command -v chromium-browser >/dev/null 2>&1; then
  browser=chromium-browser
else
  logger -t jarvis-kiosk "Chromium is not installed"
  exit 1
fi

exec "$browser" \
  --kiosk \
  --user-data-dir="$HOME/.local/share/jarvis/chromium-kiosk" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-popup-blocking \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --autoplay-policy=no-user-gesture-required \
  "$url"
