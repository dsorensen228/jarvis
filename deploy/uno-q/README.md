# UNO Q power spinner

Replaces the factory heart with a small blue spinner: two equally bright dots
180° apart, eight positions, one rotation every 1.024 seconds. It
indicates that the microcontroller is running; it is not a Home Assistant health
check. The built-in boot animation uses the same frames, so the heart also stays
replaced during Linux startup.

The sketch controls only the onboard 8×13 matrix. Home Assistant stays in its
existing Linux container. No new daemon, network request or Python runtime is
needed for the animation.

## Install

Requires the existing UNO Q core **arduino:zephyr 0.51.0**, `arduino-cli`, and the
board's `/opt/openocd` GPIO SWD tooling. This installer is intentionally pinned
to that core's partition layout; do not reuse its addresses for newer cores.

```sh
./deploy/uno-q/deploy.sh uno-q
```

`generate-spinner.py` produces the checked-in sketch header and an ignored boot
payload using Arduino's custom boot-animation format. The installer checks the
installed partition definition, compiles the sketch, preserves the original
2 MiB MCU flash on the device, writes only the animation and sketch partitions,
verifies both writes and resets the MCU. The Linux host is not rebooted. A failed
write restores the original animation and sketch partitions. A partial backup
causes installation to stop before writing anything.

Files live at `/home/arduino/services/power-spinner/`; retain the backup there.
Installing a different sketch later can replace this idle display. The boot
animation persists until explicitly replaced or the MCU is fully reflashed.

## Verify and rollback

Check compile/flash verification output and watch the dots rotate. Check the
Home Assistant HTTP endpoint and its existing container after deployment.
`EVIDENCE.md` records the actual deployment and memory-level animation check.

To restore the previous animation and sketch on the UNO Q:

```sh
cd /home/arduino/services/power-spinner
sudo /opt/openocd/bin/openocd -d2 -s /opt/openocd -f openocd_gpiod.cfg -c \
  "reset_config srst_only srst_push_pull; init; reset; halt; flash write_image erase $PWD/boot-before-spinner.bin 0x08090000 bin; verify_image $PWD/boot-before-spinner.bin 0x08090000 bin; flash write_image erase $PWD/sketch-before-spinner.bin 0x080f0000 bin; verify_image $PWD/sketch-before-spinner.bin 0x080f0000 bin; reset run; shutdown"
```

Format reference: Arduino's [Reflash_Bootanimation example](https://github.com/arduino/ArduinoCore-zephyr/blob/0.51.0/libraries/Arduino_LED_Matrix/examples/Reflash_Bootanimation/Reflash_Bootanimation.ino)
and [loader](https://github.com/arduino/ArduinoCore-zephyr/blob/0.51.0/loader/main.c).
