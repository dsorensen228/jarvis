#!/usr/bin/env bash
# Install or update Jarvis's Home Assistant custom components and restart HA.
#
# Idempotent: the tree is shipped with tar over ssh (the Uno Q has no rsync) and
# Home Assistant is only restarted when the synced content hash actually changes.
#
#   HA_SSH_HOST=arduino@192.0.2.35 ./install-custom-components.sh
set -euo pipefail

HA_SSH_HOST="${HA_SSH_HOST:-arduino@192.0.2.35}"
HA_SSH_KEY="${HA_SSH_KEY:-$HOME/.ssh/jetson_orin_rsa}"
HA_CONFIG_DIR="${HA_CONFIG_DIR:-/home/arduino/services/homeassistant/config}"
HA_CONTAINER="${HA_CONTAINER:-homeassistant}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$here/custom_components"
stamp_file="$HA_CONFIG_DIR/custom_components/.jarvis-install-stamp"

if [[ ! -d "$source_dir" ]]; then
  echo "missing $source_dir" >&2
  exit 1
fi

ssh_opts=(-o ConnectTimeout=15 -o BatchMode=yes -i "$HA_SSH_KEY")
remote() { ssh "${ssh_opts[@]}" "$HA_SSH_HOST" "$@"; }

# Hash file names plus contents so additions and deletions both register.
local_stamp="$(
  cd "$source_dir"
  find . -type f ! -name '*.pyc' -print0 |
    LC_ALL=C sort -z |
    xargs -0 shasum -a 256 |
    shasum -a 256 |
    awk '{print $1}'
)"

remote_stamp="$(remote "cat '$stamp_file' 2>/dev/null || true" | tr -d '[:space:]')"

if [[ "$local_stamp" == "$remote_stamp" ]]; then
  echo "==> custom components already current ($local_stamp)"
  exit 0
fi

echo "==> syncing custom components to $HA_SSH_HOST:$HA_CONFIG_DIR"
remote "mkdir -p '$HA_CONFIG_DIR/custom_components'"
# --delete removes components dropped from the repo; scoped to our own directory
# so nothing else in the Home Assistant config is touched.
# COPYFILE_DISABLE stops macOS tar from emitting AppleDouble members; the remote
# sweep covers archives built without it, because a stray binary "._x" file makes
# compileall fail inside the container.
COPYFILE_DISABLE=1 tar -cf - -C "$source_dir" --exclude '*.pyc' --exclude '__pycache__' . |
  remote "tar -xf - -C '$HA_CONFIG_DIR/custom_components' &&
          find '$HA_CONFIG_DIR/custom_components' -name '._*' -delete"

echo "==> compiling in the Home Assistant container"
remote "docker exec '$HA_CONTAINER' python -m compileall -q /config/custom_components" >/dev/null

remote "printf '%s' '$local_stamp' > '$stamp_file'"

echo "==> restarting $HA_CONTAINER"
remote "docker restart '$HA_CONTAINER'" >/dev/null

echo "==> waiting for the Home Assistant API"
for _ in $(seq 1 60); do
  if remote "curl -sf -o /dev/null -m 5 http://127.0.0.1:8123/" 2>/dev/null; then
    echo "==> Home Assistant is serving ($local_stamp)"
    exit 0
  fi
  sleep 5
done

echo "Home Assistant did not come back within five minutes" >&2
exit 1
