#!/usr/bin/env bash
set -euo pipefail

voice_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
jarvis_root=$(cd "$voice_dir/../.." && pwd)

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this installer as the kiosk user; it uses sudo only for system packages." >&2
  exit 2
fi

source /etc/os-release
if [[ ${VERSION_CODENAME:-} != bookworm && ${VERSION_CODENAME:-} != trixie ]]; then
  echo "Jarvis voice devices require 64-bit Raspberry Pi OS Bookworm or Trixie; found ${PRETTY_NAME:-unknown}." >&2
  exit 2
fi
if [[ $(uname -m) != aarch64 ]]; then
  echo "Jarvis voice devices require 64-bit Raspberry Pi OS (aarch64)." >&2
  exit 2
fi
if [[ ! -f "$jarvis_root/apps/device-ui/dist/index.html" ]]; then
  echo "Build apps/device-ui before deployment; dist/index.html is missing." >&2
  exit 2
fi

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  alsa-utils \
  ca-certificates \
  chromium \
  curl \
  libgomp1 \
  libportaudio2 \
  libusb-1.0-0 \
  pipewire \
  pipewire-pulse \
  portaudio19-dev \
  pulseaudio-utils \
  tmux \
  wireplumber

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
uv_bin=$(command -v uv || true)
if [[ -z "$uv_bin" && -x "$HOME/.local/bin/uv" ]]; then
  uv_bin="$HOME/.local/bin/uv"
fi
if [[ -z "$uv_bin" ]]; then
  echo "uv installation did not produce an executable." >&2
  exit 1
fi

"$uv_bin" python install 3.13.5
"$uv_bin" sync --project "$voice_dir" --locked --no-dev --python 3.13.5
"$voice_dir/.venv/bin/python" "$voice_dir/scripts/download-wake-models.py"

sudo install -m 0644 \
  "$voice_dir/deploy/99-jarvis-respeaker.rules" \
  /etc/udev/rules.d/99-jarvis-respeaker.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=2886
sudo usermod -aG audio,plugdev "$USER"

config_dir="$HOME/.config/jarvis"
user_unit_dir="$HOME/.config/systemd/user"
mkdir -p "$config_dir" "$user_unit_dir"
if [[ ! -f "$config_dir/voice.env" ]]; then
  install -m 0600 "$voice_dir/voice.env.example" "$config_dir/voice.env"
fi

set_env_if_empty() {
  local key=$1
  local value=$2
  if grep -Eq "^${key}=.+$" "$config_dir/voice.env"; then
    return
  fi
  if grep -Eq "^${key}=" "$config_dir/voice.env"; then
    sed -i "s&^${key}=.*&${key}=${value}&" "$config_dir/voice.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$config_dir/voice.env"
  fi
}

set_env() {
  local key=$1
  local value=$2
  if grep -Eq "^${key}=" "$config_dir/voice.env"; then
    sed -i "s&^${key}=.*&${key}=${value}&" "$config_dir/voice.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$config_dir/voice.env"
  fi
}

# Kitchen/mudroom continued to false-trigger at the 0.68 fleet threshold.
# Persist a further 0.05 increase only on these noisier devices.
case "$(hostname -s 2>/dev/null || hostname)" in
  voice-one|voice-two)
    set_env JARVIS_WAKE_THRESHOLD 0.73
    ;;
esac

if [[ -f "$user_unit_dir/jarvis.service" ]] \
  && grep -q 'jarvis' "$user_unit_dir/jarvis.service"; then
  if [[ -e "$user_unit_dir/jarvis-legacy.service" ]]; then
    echo "Refusing to replace existing $user_unit_dir/jarvis-legacy.service." >&2
    exit 2
  fi
  systemctl --user disable --now jarvis.service
  mv "$user_unit_dir/jarvis.service" "$user_unit_dir/jarvis-legacy.service"
  if [[ -d "$user_unit_dir/jarvis.service.d" ]]; then
    mv "$user_unit_dir/jarvis.service.d" "$user_unit_dir/jarvis-legacy.service.d"
  fi
fi

escaped_root=${jarvis_root//&/\\&}
sed "s&@JARVIS_ROOT@&$escaped_root&g" \
  "$voice_dir/deploy/jarvis.service.in" \
  > "$user_unit_dir/jarvis.service"
sed "s&@JARVIS_ROOT@&$escaped_root&g" \
  "$voice_dir/deploy/jarvis-kiosk.service.in" \
  > "$user_unit_dir/jarvis-kiosk.service"
chmod 0755 "$voice_dir/deploy/launch-kiosk.sh"
chmod 0755 \
  "$voice_dir/scripts/setup-respeaker-lite-audio.sh" \
  "$voice_dir/scripts/setup-usb4mic-audio.sh" \
  "$voice_dir/scripts/setup-xvf3800-audio.sh"

audio_service=
if lsusb | grep -Eiq '2886:0019'; then
  sed "s&@JARVIS_ROOT@&$escaped_root&g" \
    "$voice_dir/deploy/jarvis-respeaker-lite-audio.service.in" \
    > "$user_unit_dir/jarvis-respeaker-lite-audio.service"
  audio_service=jarvis-respeaker-lite-audio.service
  set_env_if_empty JARVIS_AUDIO_INPUT default
  set_env_if_empty JARVIS_AUDIO_OUTPUT default
fi

if lsusb | grep -Eiq '2886:0018'; then
  if [[ -f "$HOME/.asoundrc" ]] \
    && ! cmp -s "$voice_dir/deploy/asoundrc.respeaker-usb4mic" "$HOME/.asoundrc" \
    && [[ ! -f "$HOME/.asoundrc.pre-jarvis" ]]; then
    cp "$HOME/.asoundrc" "$HOME/.asoundrc.pre-jarvis"
  fi
  install -m 0644 "$voice_dir/deploy/asoundrc.respeaker-usb4mic" "$HOME/.asoundrc"
  sed "s&@JARVIS_ROOT@&$escaped_root&g" \
    "$voice_dir/deploy/jarvis-respeaker-usb4-audio.service.in" \
    > "$user_unit_dir/jarvis-respeaker-usb4-audio.service"
  audio_service=jarvis-respeaker-usb4-audio.service
  set_env_if_empty JARVIS_AUDIO_INPUT default
  set_env_if_empty JARVIS_AUDIO_OUTPUT default
fi

if lsusb | grep -Eiq '2886:001a'; then
  sed "s&@JARVIS_ROOT@&$escaped_root&g" \
    "$voice_dir/deploy/jarvis-respeaker-xvf3800-audio.service.in" \
    > "$user_unit_dir/jarvis-respeaker-xvf3800-audio.service"
  audio_service=jarvis-respeaker-xvf3800-audio.service
  set_env_if_empty JARVIS_AUDIO_INPUT default
  set_env_if_empty JARVIS_AUDIO_OUTPUT default
fi

sudo loginctl enable-linger "$USER"
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_boot_behaviour B4
fi

systemctl --user daemon-reload
if [[ -n $audio_service ]]; then
  systemctl --user enable --now "$audio_service"
  systemctl --user disable --now jarvis-respeaker-audio.service >/dev/null 2>&1 || true
  systemctl --user disable --now respeaker-asr-mono.service >/dev/null 2>&1 || true
fi
if grep -Eq '^JARVIS_USERNAME=.+$' "$config_dir/voice.env" \
  && grep -Eq '^JARVIS_PASSWORD=.+$' "$config_dir/voice.env"; then
  systemctl --user enable --now jarvis.service
  if ! grep -Eiq '^JARVIS_UI_ENABLED=(false|0|no|off)$' "$config_dir/voice.env"; then
    systemctl --user enable --now jarvis-kiosk.service
  fi
  echo "Jarvis voice is enabled and running. Reboot once to apply audio/USB groups and kiosk autologin."
else
  echo "Installed but not started. Fill $config_dir/voice.env, then run:"
  echo "  systemctl --user enable --now jarvis.service"
fi
