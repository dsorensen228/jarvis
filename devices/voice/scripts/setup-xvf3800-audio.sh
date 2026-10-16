#!/usr/bin/env bash
set -euo pipefail

sink_volume=${JARVIS_XVF3800_SINK_VOLUME:-35%}
source_volume=${JARVIS_XVF3800_SOURCE_VOLUME:-100%}
profile=output:analog-stereo+input:analog-stereo

if ! lsusb | grep -Eiq '2886:001a'; then
  echo "ReSpeaker XVF3800 2886:001a is not attached; leaving audio unchanged"
  exit 0
fi

# PipeWire assigns a different ALSA card number depending on what else was
# enumerated during boot, and an HDMI display can steal the default. Select the
# card by its stable USB identity instead. The daemon depends on the default
# source being the XVF3800's stereo capture: ch0 is the AEC/DSP output it keeps,
# ch1 is raw echo it discards.
card_name=
for _ in {1..20}; do
  card_name=$(timeout 3 pactl list cards short 2>/dev/null \
    | awk '$2 ~ /^alsa_card\.usb-.*XVF3800/ { print $2; exit }')
  [[ -n $card_name ]] && break
  sleep 0.25
done
if [[ -z $card_name ]]; then
  echo "PipeWire did not expose the attached ReSpeaker XVF3800 card" >&2
  exit 1
fi

timeout 3 pactl set-card-profile "$card_name" "$profile"

sink_name=
source_name=
for _ in {1..20}; do
  sink_name=$(timeout 3 pactl list sinks short 2>/dev/null \
    | awk '$2 ~ /^alsa_output\.usb-.*XVF3800.*\.analog-stereo$/ { print $2; exit }')
  source_name=$(timeout 3 pactl list sources short 2>/dev/null \
    | awk '$2 ~ /^alsa_input\.usb-.*XVF3800.*\.analog-stereo$/ { print $2; exit }')
  [[ -n $sink_name && -n $source_name ]] && break
  sleep 0.25
done
if [[ -z $sink_name || -z $source_name ]]; then
  echo "PipeWire did not create the ReSpeaker XVF3800 duplex nodes" >&2
  exit 1
fi

source_spec=$(timeout 3 pactl list sources short | awk -v name="$source_name" '$2 == name { print $0 }')
if [[ $source_spec != *"2ch 16000Hz"* ]]; then
  echo "Unexpected ReSpeaker XVF3800 capture format: [$source_spec]" >&2
  exit 1
fi

timeout 3 pactl set-default-sink "$sink_name"
timeout 3 pactl set-default-source "$source_name"
timeout 3 pactl set-sink-mute "$sink_name" 0
timeout 3 pactl set-source-mute "$source_name" 0
timeout 3 pactl set-sink-volume "$sink_name" "$sink_volume"
timeout 3 pactl set-source-volume "$source_name" "$source_volume"

echo "ReSpeaker XVF3800 audio ready: sink=$sink_name source=$source_name"
