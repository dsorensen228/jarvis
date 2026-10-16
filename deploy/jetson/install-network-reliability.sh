#!/usr/bin/env bash
# Run on the Jetson; an optional BSSID pins this stationary server to a known-good AP.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0 [interface] [known-good-bssid]" >&2
  exit 1
fi
if [[ $# -gt 2 ]]; then
  echo "Usage: $0 [interface] [known-good-bssid]" >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
wifi_interface=${1:-wlan0}
wifi_bssid=${2:-}
if [[ ! $wifi_interface =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$ ]]; then
  echo "Invalid Wi-Fi interface" >&2
  exit 1
fi
if [[ -n $wifi_bssid && ! $wifi_bssid =~ ^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$ ]]; then
  echo "Invalid BSSID" >&2
  exit 1
fi
for command in python3 nmcli iw ip ping curl systemctl systemd-tmpfiles journalctl; do
  command -v "$command" >/dev/null
done
wifi_uuid=$(nmcli -g GENERAL.CON-UUID device show "$wifi_interface")
if [[ ! $wifi_uuid =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  echo "Connect $wifi_interface to the intended Wi-Fi network before installation" >&2
  exit 1
fi
if [[ $(nmcli -g connection.type connection show uuid "$wifi_uuid") != 802-11-wireless ]]; then
  echo "$wifi_interface is not an active Wi-Fi profile" >&2
  exit 1
fi

# Keep the original non-secret settings for a precise rollback, including on reinstall.
backup_dir=/var/lib/jarvis-network-watchdog
install -d -m 0700 "$backup_dir"
if [[ ! -e $backup_dir/original-wifi-settings.txt ]]; then
  {
    printf 'interface=%s\nuuid=%s\n' "$wifi_interface" "$wifi_uuid"
    nmcli -f 802-11-wireless.powersave,802-11-wireless.bssid connection show uuid "$wifi_uuid"
  } > "$backup_dir/original-wifi-settings.txt"
fi

install -d -m 0755 /usr/local/libexec/jarvis /etc/default /etc/systemd/journald.conf.d
install -m 0755 "$script_dir/network-watchdog.py" /usr/local/libexec/jarvis/network-watchdog.py
install -m 0644 "$script_dir/jarvis-network-watchdog.service" /etc/systemd/system/
install -m 0644 "$script_dir/jarvis-network-watchdog.timer" /etc/systemd/system/
if [[ ! -e /etc/default/jarvis-network-watchdog ]]; then
  cat > /etc/default/jarvis-network-watchdog <<EOF
JARVIS_WIFI_INTERFACE=$wifi_interface
JARVIS_WIFI_CONNECTION_UUID=$wifi_uuid
JARVIS_PUBLIC_HEALTH_URL=https://jarvis-api.example.com/health/live
EOF
  chmod 0644 /etc/default/jarvis-network-watchdog
fi

nmcli connection modify uuid "$wifi_uuid" 802-11-wireless.powersave 2
iw dev "$wifi_interface" set power_save off
if [[ -n $wifi_bssid ]]; then
  nmcli connection modify uuid "$wifi_uuid" 802-11-wireless.bssid "$wifi_bssid"
  echo "Saved AP pin $wifi_bssid. Reactivate the connection from a detached service to apply it."
fi

# Preserve network/kernel evidence across reboot with bounded disk use.
install -m 0644 "$script_dir/journald-persistent.conf" /etc/systemd/journald.conf.d/60-jarvis-persistent.conf
install -d -m 2755 -o root -g systemd-journal /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal
systemctl restart systemd-journald
journalctl --flush
systemctl daemon-reload
systemctl enable --now jarvis-network-watchdog.timer
systemctl start jarvis-network-watchdog.service
iw dev "$wifi_interface" get power_save
systemctl --no-pager status jarvis-network-watchdog.timer
