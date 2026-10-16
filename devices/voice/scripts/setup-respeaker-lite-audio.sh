#!/usr/bin/env bash
set -euo pipefail

sink_volume=${JARVIS_RESPEAKER_LITE_SINK_VOLUME:-50%}
source_volume=${JARVIS_RESPEAKER_LITE_SOURCE_VOLUME:-100%}
profile=output:analog-stereo+input:analog-stereo

if ! lsusb | grep -Eiq '2886:0019'; then
  echo "ReSpeaker Lite 2886:0019 is not attached; leaving audio unchanged"
  exit 0
fi

# PipeWire assigns a different ALSA card number depending on what else was
# enumerated during boot. Select the card by its stable USB identity instead.
card_name=
for _ in {1..20}; do
  card_name=$(timeout 3 pactl list cards short 2>/dev/null \
    | awk '$2 ~ /^alsa_card\.usb-Seeed_Studio_ReSpeaker_Lite_/ { print $2; exit }')
  [[ -n $card_name ]] && break
  sleep 0.25
done
if [[ -z $card_name ]]; then
  echo "PipeWire did not expose the attached ReSpeaker Lite card" >&2
  exit 1
fi

timeout 3 pactl set-card-profile "$card_name" "$profile"

sink_name=
source_name=
for _ in {1..20}; do
  sink_name=$(timeout 3 pactl list sinks short 2>/dev/null \
    | awk '$2 ~ /^alsa_output\.usb-Seeed_Studio_ReSpeaker_Lite_.*\.analog-stereo$/ { print $2; exit }')
  source_name=$(timeout 3 pactl list sources short 2>/dev/null \
    | awk '$2 ~ /^alsa_input\.usb-Seeed_Studio_ReSpeaker_Lite_.*\.analog-stereo$/ { print $2; exit }')
  [[ -n $sink_name && -n $source_name ]] && break
  sleep 0.25
done
if [[ -z $sink_name || -z $source_name ]]; then
  echo "PipeWire did not create the ReSpeaker Lite duplex nodes" >&2
  exit 1
fi

sink_spec=$(timeout 3 pactl list sinks short | awk -v name="$sink_name" '$2 == name { print $0 }')
source_spec=$(timeout 3 pactl list sources short | awk -v name="$source_name" '$2 == name { print $0 }')
if [[ $sink_spec != *"s16le 2ch 16000Hz"* || $source_spec != *"s16le 2ch 16000Hz"* ]]; then
  echo "Unexpected ReSpeaker Lite format; sink=[$sink_spec] source=[$source_spec]" >&2
  exit 1
fi

timeout 3 pactl set-sink-mute "$sink_name" 0
timeout 3 pactl set-source-mute "$source_name" 0
timeout 3 pactl set-sink-volume "$sink_name" "$sink_volume"
timeout 3 pactl set-source-volume "$source_name" "$source_volume"

# The Lite's USB firmware performs no echo cancellation: the device's own playback
# comes back in the capture at full strength (~6000 RMS measured), which makes
# barge-in and wake-word-during-playback impossible. Route all default audio
# through a PipeWire WebRTC echo-cancel pair instead; its cancelled residual
# measured 16-100 RMS after convergence.
while read -r module_id; do
  [[ -n $module_id ]] || continue
  timeout 2 pactl unload-module "$module_id" >/dev/null 2>&1 || true
done < <(timeout 3 pactl list modules short 2>/dev/null \
  | awk '/module-echo-cancel/ && /jarvis_ec_/ { print $1 }')

timeout 5 pactl load-module module-echo-cancel \
  aec_method=webrtc \
  source_master="$source_name" \
  sink_master="$sink_name" \
  source_name=jarvis_ec_source \
  sink_name=jarvis_ec_sink \
  rate=16000 channels=1 \
  source_properties=device.description=Jarvis_EC_Mic \
  sink_properties=device.description=Jarvis_EC_Speaker >/dev/null

ec_ready=
for _ in {1..20}; do
  if timeout 3 pactl list sources short | grep -q '^[0-9]*[[:space:]]*jarvis_ec_source' \
    && timeout 3 pactl list sinks short | grep -q '^[0-9]*[[:space:]]*jarvis_ec_sink'; then
    ec_ready=1
    break
  fi
  sleep 0.25
done
if [[ -z $ec_ready ]]; then
  echo "PipeWire did not create the jarvis_ec echo-cancel nodes" >&2
  exit 1
fi

timeout 3 pactl set-default-sink jarvis_ec_sink
timeout 3 pactl set-default-source jarvis_ec_source
timeout 3 pactl set-sink-mute jarvis_ec_sink 0
timeout 3 pactl set-source-mute jarvis_ec_source 0
timeout 3 pactl set-sink-volume jarvis_ec_sink 100%
timeout 3 pactl set-source-volume jarvis_ec_source 100%

echo "ReSpeaker Lite audio ready: sink=jarvis_ec_sink source=jarvis_ec_source (webrtc echo cancel over $sink_name)"
