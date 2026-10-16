# Deployment — 2026-09-26 EDT

Installed on `uno-q` with Arduino core 0.51.0. The spinner runs on the onboard
STM32 matrix and replaces the boot-animation data and factory idle sketch.

- The original complete 2 MiB MCU flash is preserved on the board as
  `services/power-spinner/mcu-before-spinner.bin` (SHA-256
  `74526a2ccfab5faefe92a4532039d3333596c6a72cc86f7573afdabedfe71ae5`).
- Confirmed the installed core partition map (animation at 0x08090000, sketch
  at 0x080f0000). The original loader matches the installed core binary except
  four bytes at 0x234; loader code was left in place.
- Arduino CLI compile succeeds: 1,209 bytes code, 40 bytes globals. Generated
  sketch artifact SHA-256:
  `7003ad604ed43c0d65e9d7a5ffd046848329a9912d7f420515f0878affd747d6`.
- Both animation and sketch flash writes pass OpenOCD `verify_image`; the MCU
  was reset and resumed. Animation payload SHA-256:
  `71ca6203bb3225a5e5108cc94a7f344173950f7e213d49c33e6f539d785250e2`.
- Four successive actual MCU framebuffer captures at the core's
  `framebuffer_color` symbol (0x20000488) each match a generated spinner frame,
  with distinct positions advancing clockwise. See `evidence/frames.json`.
  This verifies running display data, not an optical photo of the LEDs.
- Home Assistant container remained up for 35 hours and healthy; local HTTP
  endpoint returned 200. Arduino router and app CLI services remained active.
- Shell syntax, Python compilation and `git diff --check` pass. The generated
  header is reproducible from `generate-spinner.py`.

Full Linux reboot/power cycling was not performed. The flash-resident sketch
survived the MCU reset performed by the installer; both boot and idle data are
persistently stored. Flash logs are in `evidence/`; firmware backups stay on the
board. No Home Assistant settings or container changes were made.

## Follow-up: two opposite dots

Updated the boot and running spinner to exactly two equally bright dots, 180°
apart, preserving the radius and 1.024-second revolution. The generator's eight
frames each contain two pixels mirrored across the circle center (6, 3).

Compilation and both flash verifications passed. Four actual framebuffer
captures match the new generated frames and advance through positions 0, 2, 3,
and 1; every capture has exactly two opposite dots. Home Assistant remained
healthy and up for 37 hours. See `evidence/two-dot-*` for logs and sampled pixels.
The prior single-dot payloads are retained on-device under `previous-single-dot/`.

- Boot payload SHA-256:
  `d7140dea5f40b04a5fbc414ad8e4d58580a81ea30be29b24a73533f73dbbf22d`
- Sketch SHA-256:
  `4c5aeec454cb89f7247670677adda0c62a40ea5290767ff5bab4fb3cb6f067c3`
