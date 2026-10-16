#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

python_version=$(/usr/bin/python3 -c 'import platform; print(platform.python_version())')
if [[ "$python_version" != "3.13.5" ]]; then
  echo "Jarvis camera requires system Python 3.13.5; found $python_version." >&2
  exit 2
fi

sudo apt-get update
sudo apt-get install -y python3-venv python3-picamera2 python3-opencv python3-munkres imx500-all

/usr/bin/python3 -m venv --system-site-packages "$package_dir/.venv"
"$package_dir/.venv/bin/python" -m pip install --upgrade pip
"$package_dir/.venv/bin/python" -m pip install "$package_dir"

mkdir -p "$HOME/.config/jarvis" "$HOME/.config/systemd/user"
if [[ ! -f "$HOME/.config/jarvis/camera.env" ]]; then
  install -m 0600 "$package_dir/.env.example" "$HOME/.config/jarvis/camera.env"
  echo "Edit $HOME/.config/jarvis/camera.env before starting the service." >&2
fi

current_unit="$HOME/.config/systemd/user/jarvis.service"
legacy_unit="$HOME/.config/systemd/user/jarvis-legacy.service"
if [[ -f "$current_unit" ]] && grep -q 'jarvis' "$current_unit"; then
  if [[ -e "$legacy_unit" ]]; then
    echo "Refusing to replace existing $legacy_unit." >&2
    exit 2
  fi
  systemctl --user disable --now jarvis.service
  mv "$current_unit" "$legacy_unit"
fi

install -m 0644 "$package_dir/systemd/jarvis.service" "$current_unit"
systemctl --user daemon-reload
sudo loginctl enable-linger "$USER"

echo "Installed but not started. Run scripts/diagnose.sh, then enable the service." >&2
