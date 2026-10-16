#!/usr/bin/env bash
set -euo pipefail

sink_name=respeaker_shared_sink
source_name=respeaker_shared_source
sink_volume=${JARVIS_RESPEAKER_VOLUME:-0.55}

if ! lsusb | grep -Eiq '2886:0018'; then
  echo "ReSpeaker USB 4 Mic 2886:0018 is not attached; leaving audio unchanged"
  exit 0
fi

# Self-heal the ALSA routing config: without it, the shared PipeWire source cannot
# load at all, and any stale variant reintroduces the multichannel downmix that
# attenuates the AEC-processed capture channel, silently degrading wake-word, ASR,
# and barge-in.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
asoundrc_src="$script_dir/../deploy/asoundrc.respeaker-usb4mic"
if [[ -f $asoundrc_src ]] && ! cmp -s "$asoundrc_src" "$HOME/.asoundrc"; then
  install -m 0644 "$asoundrc_src" "$HOME/.asoundrc"
  echo "installed ReSpeaker ALSA config to $HOME/.asoundrc"
fi

wp_status=$(timeout 3 wpctl status -n 2>/dev/null || timeout 3 wpctl status 2>/dev/null || true)
device_id=$(awk '
  /Devices:/ { devices=1; next }
  devices && /ReSpeaker/ {
    if (match($0, /[0-9]+/)) { print substr($0, RSTART, RLENGTH); exit }
  }
' <<<"$wp_status")

if [[ -n ${device_id:-} ]]; then
  timeout 3 pw-cli s "$device_id" Profile '{ index: 0, save: true }' >/dev/null 2>&1 || true
  sleep 0.4
fi

unload_matching() {
  local needle=$1
  while read -r module_id; do
    [[ -n $module_id ]] || continue
    timeout 2 pactl unload-module "$module_id" >/dev/null 2>&1 || true
  done < <(timeout 3 pactl list modules short 2>/dev/null | awk -v n="$needle" '$0 ~ n { print $1 }')
}

unload_matching "$sink_name"
unload_matching "$source_name"
unload_matching 'device=respeaker_play'
unload_matching 'device=respeaker_asr'

timeout 5 pactl load-module module-alsa-sink \
  device=respeaker_play \
  sink_name="$sink_name" \
  sink_properties=device.description=ReSpeaker_Speakers \
  rate=16000 channels=2 >/dev/null
timeout 5 pactl load-module module-alsa-source \
  device=respeaker_asr \
  source_name="$source_name" \
  source_properties=device.description=ReSpeaker_ASR \
  rate=16000 channels=1 >/dev/null

# The source must be exactly the mono AEC channel; a multichannel spec means an
# outdated ~/.asoundrc produced the attenuating downmix again.
source_spec=$(timeout 3 pactl list sources short | awk -v n="$source_name" '$2 == n { print $0 }')
if [[ $source_spec != *"s16le 1ch 16000Hz"* ]]; then
  echo "ReSpeaker ASR source is not mono 16 kHz: [$source_spec]" >&2
  exit 1
fi

sink_id=$(wpctl status -n | awk -v n="$sink_name" -v d="ReSpeaker_Speakers" \
  '($0 ~ n || $0 ~ d) && match($0, /[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }')
source_id=$(wpctl status -n | awk -v n="$source_name" -v d="ReSpeaker_ASR" \
  '($0 ~ n || $0 ~ d) && match($0, /[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }')
wpctl set-default "$sink_id"
wpctl set-volume "$sink_id" "$sink_volume"
wpctl set-default "$source_id"

timeout 2 arecord -D respeaker_asr -f S16_LE -r 16000 -c 1 -d 1 /tmp/jarvis-respeaker-check.wav >/dev/null
rm -f /tmp/jarvis-respeaker-check.wav
echo "ReSpeaker USB4 shared audio ready: sink=$sink_id source=$source_id"
