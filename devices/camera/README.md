# Jarvis camera

One clean Raspberry Pi AI Camera (IMX500) runtime. Picamera2 owns capture, the IMX500 performs local
person detection, and the Jetson API owns registration, event persistence, scene description, and
client access. A rising person-detection edge is announced through Kokoro on connected voice
devices whose `doorbell_alerts_enabled` setting is enabled, and the same event pushes an Expo
notification to registered Android app tokens. There are no legacy operating modes or
cloud-auth branches, and no model is consulted for the fixed alert.

The package owns Python 3.13.5, its virtual environment, lockfile, tests, and user systemd unit. It
must be installed with `--system-site-packages` because Raspberry Pi OS supplies libcamera,
Picamera2, and the IMX500 bindings through apt.

## Install on the camera Pi

```bash
cd ~/jarvis/devices/camera
chmod +x scripts/*.sh
./scripts/install.sh
editor ~/.config/jarvis/camera.env
./scripts/diagnose.sh
```

Use a random callback token of at least 16 characters. The environment file is installed with mode
`0600`; it contains the camera account password and callback token and must never be committed.
Set `JARVIS_CAMERA_PERSON_ALERT_TEXT` when a camera needs a specific fixed announcement, such as
`Someone's at the side door.` The API delivers that exact text without asking the LLM.
`JARVIS_CAMERA_PERSON_CONFIRMATIONS` controls how many consecutive detections are required before
an alert; the default of two rejects isolated false positives. Entrance cameras default to
`JARVIS_CAMERA_PERSON_THRESHOLD=0.65` so the live IMX500 strong-positive buckets (~0.68 and
~0.73) alert while rejecting the weaker 0.56–0.62 false-positive mass. A doorbell can combine that
threshold with a shorter detection interval so only a person who remains in view triggers an alert.

An mDNS callback URL such as `http://camera-two.local:8089` is resolved by the camera to its
current LAN IPv4 when it registers. This keeps the configuration readable while allowing the
containerized API to call the camera without depending on the host's Avahi resolver.

The installer preserves a legacy `jarvis.service` automatically as `jarvis-legacy.service` and
leaves both services stopped after installation. Never run them together; Picamera2 cannot safely
share the sensor.

To preserve the unit manually instead:

```bash
systemctl --user disable --now jarvis.service
mv ~/.config/systemd/user/jarvis.service ~/.config/systemd/user/jarvis-legacy.service
```

Install the new unit only after the legacy copy exists, then run once in the foreground:

```bash
set -a
. ~/.config/jarvis/camera.env
set +a
.venv/bin/jarvis-camera
```

After snapshots, orientation, colors, and detection are verified:

```bash
loginctl enable-linger "$USER"
systemctl --user enable --now jarvis.service
```

Never run legacy and new services together; Picamera2 cannot safely share the sensor.

## Verification

```bash
curl http://localhost:8089/health/ready
curl -o snapshot.jpg \
  -H "Authorization: Bearer $JARVIS_CAMERA_CALLBACK_TOKEN" \
  http://localhost:8089/v1/camera/snapshot
journalctl --user -u jarvis.service -f
```

From the Jetson, verify the camera appears in `GET /v1/devices`, the API-proxied snapshot works,
and `describe_scene` uses one bounded frame through Qwen3-VL. On `camera-two` and
`doorbell-camera`, these checks and automatic reboot recovery passed on 2026-08-11; each new service
is enabled and each legacy service is preserved but disabled. Their fixed announcements are
`Someone's at the side door.` and `Someone's at the front door.`, respectively.

## Rollback

```bash
systemctl --user disable --now jarvis.service
systemctl --user enable --now jarvis-legacy.service
```

The wire contract is documented in `contracts/devices/camera-v1.md` at repository root.
