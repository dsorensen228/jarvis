#!/bin/sh
set -eu
TARGET=${1:-example-board}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$SCRIPT_DIR/generate-spinner.py"
ssh "$TARGET" 'mkdir -p /home/arduino/services/power-spinner'
scp -q -r "$SCRIPT_DIR/spinner" "$SCRIPT_DIR/build/boot-spinner.bin" \
    "$SCRIPT_DIR/install-on-device.sh" "$TARGET:/home/arduino/services/power-spinner/"
ssh "$TARGET" 'sh /home/arduino/services/power-spinner/install-on-device.sh'
