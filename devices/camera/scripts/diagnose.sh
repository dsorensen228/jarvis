#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
python_bin="$package_dir/.venv/bin/python"

"$python_bin" --version
"$python_bin" -c 'import libcamera; import picamera2; from picamera2.devices import IMX500; print("camera imports: ok")'
test -r "$HOME/.config/jarvis/camera.env"
stat -c 'camera env mode: %a' "$HOME/.config/jarvis/camera.env"
systemctl --user status jarvis.service --no-pager || true
