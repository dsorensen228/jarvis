#!/bin/sh
# Run over SSH on UNO Q after copying spinner/, boot-spinner.bin and this file.
set -eu
cd /home/arduino/services/power-spinner
CORE=/home/arduino/.arduino15/packages/arduino/hardware/zephyr/0.51.0
[ -f "$CORE/firmwares/zephyr-arduino_uno_q_stm32u585xx.dts" ]
python3 - <<'PY'
from pathlib import Path
import re
root = Path('/home/arduino/.arduino15/packages/arduino/hardware/zephyr/0.51.0')
dts = (root / 'firmwares/zephyr-arduino_uno_q_stm32u585xx.dts').read_text()
assert re.search(r'bootanimation: partition@90000\s*\{\s*reg = < 0x90000 0x10000 >', dts), 'unexpected boot partition'
assert 16 < Path('boot-spinner.bin').stat().st_size <= 0x10000
PY
arduino-cli compile --fqbn arduino:zephyr:unoq --build-path "$PWD/build" "$PWD/spinner"
openocd() {
    sudo -n /opt/openocd/bin/openocd -d2 -s /opt/openocd -f openocd_gpiod.cfg -c "$1"
}
# Retain the first complete backup. Never overwrite the pre-spinner firmware.
if [ ! -f mcu-before-spinner.bin ]; then
    openocd "init; halt; dump_image $PWD/mcu-before-spinner.bin 0x08000000 0x200000; resume; shutdown"
fi
python3 - <<'PY'
from pathlib import Path
backup = Path('mcu-before-spinner.bin').read_bytes()
assert len(backup) == 0x200000, 'incomplete MCU backup; stop before flashing'
Path('boot-before-spinner.bin').write_bytes(backup[0x90000:0xa0000])
Path('sketch-before-spinner.bin').write_bytes(backup[0xf0000:])
assert Path('build/spinner.ino.elf-zsk.bin').stat().st_size <= 0x110000
PY
if ! openocd "reset_config srst_only srst_push_pull; init; reset; halt; flash write_image erase $PWD/boot-spinner.bin 0x08090000 bin; verify_image $PWD/boot-spinner.bin 0x08090000 bin; flash write_image erase $PWD/build/spinner.ino.elf-zsk.bin 0x080f0000 bin; verify_image $PWD/build/spinner.ino.elf-zsk.bin 0x080f0000 bin; reset run; shutdown"; then
    echo 'Spinner install failed; restoring original animation and sketch.' >&2
    openocd "reset_config srst_only srst_push_pull; init; reset; halt; flash write_image erase $PWD/boot-before-spinner.bin 0x08090000 bin; verify_image $PWD/boot-before-spinner.bin 0x08090000 bin; flash write_image erase $PWD/sketch-before-spinner.bin 0x080f0000 bin; verify_image $PWD/sketch-before-spinner.bin 0x080f0000 bin; reset run; shutdown"
    exit 1
fi
sha256sum boot-spinner.bin build/spinner.ino.elf-zsk.bin mcu-before-spinner.bin
