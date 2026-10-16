# Voice device

One Python 3.13.5 process runs the microphone, wake word, VAD, speaker, ReSpeaker LEDs, persistent
Jarvis connection, and touchscreen facade. There are no operating modes or provider branches.

## Supported hardware

The attached USB VID/PID is detected at startup. Exactly one of these must be present:

| USB ID | Profile | Audio |
| --- | --- | --- |
| `2886:0019` | ReSpeaker Lite 2-Mic | Native 16 kHz; no firmware AEC, so defaults route through a PipeWire WebRTC echo-cancel pair |
| `2886:0018` | ReSpeaker USB 4-Mic Array | 16 kHz mono AEC channel via shared ALSA/PipeWire source, plus firmware VAD for barge-in |
| `2886:001a` | ReSpeaker XVF3800 | 16 kHz stereo capture; the daemon keeps AEC channel 0 and discards the raw echo channel |

An unknown board, no board, or multiple supported boards is a startup error. Audio device-name
overrides exist only for PipeWire naming problems; there is no hardware-profile setting.

## Runtime flow

`openWakeWord` recognizes “Hey Jarvis” locally. WebRTC VAD on the Pi adds pre-roll and closes the
utterance, then the device sends `turn.end` over its always-connected `/v1/voice` WebSocket. The
Jetson returns Kokoro PCM on that same connection. Playback is written in 20 ms slices so local
speech can issue `response.cancel` and stop output quickly.

Exact transcripts `lights on` and `lights off` are handled on the device: it cancels the remote
agent turn and calls the room light control API immediately, so those phrases never wait on the
LLM.

The API emits tool results. When a voice tool creates a durable API timer, the local facade also
notifies the browser so the established fullscreen timer UX is retained.

Each device sets `JARVIS_PERSONALITY_LEVEL` to `1`, `2`, or `3`. Level 1 is concise and polite for
shared or children's rooms, level 2 is dry and sardonic, and level 3 is deliberately profane and
mean. This changes presentation only; every level receives the same tool capabilities.

## Development

From the repository root:

```bash
make device-ui-build
make voice-sync
make voice-models
make voice-lint
make voice-test
```

The lock resolves Linux ARM64 wheels as well as the macOS development environment. openWakeWord
runs ONNX only; its unused TFLite and Speex dependencies are intentionally excluded. The three
model artifacts are downloaded from the pinned `v0.5.1` release and SHA-256 verified.

## Raspberry Pi installation

The supported OS is 64-bit Raspberry Pi OS Bookworm or Trixie on Pi 4 or Pi 5. The system Python
is left alone: `uv` installs and locks CPython 3.13.5 inside `devices/voice/.venv`.

1. Build `apps/device-ui/dist` and copy the monorepo to the Pi.
2. Keep the install running in `tmux`, then run:

   ```bash
   tmux new -s jarvis-install
   ./devices/voice/scripts/install-pi.sh
   ```

3. Fill `~/.config/jarvis/voice.env` from `voice.env.example`, then enable the user service:

   ```bash
   systemctl --user enable --now jarvis.service
   ./devices/voice/.venv/bin/jarvis-voice-diagnose
   ```

The installer adds the three scoped udev rules, audio/USB group membership, PipeWire/PortAudio,
Chromium, `tmux`, systemd user-service lingering, and desktop autologin. The voice/UI server and
kiosk units use `Restart=always` and start at boot independently of the Jetson's API/inference containers.
Reboot once after the initial install so group membership and kiosk autologin take effect.

For ReSpeaker Lite devices, a boot-time user service selects the card by USB identity rather than
its unstable ALSA card number, enforces its 16 kHz stereo duplex profile, and normalizes
speaker/microphone levels to 50%/100%. Because the Lite's USB firmware performs no echo
cancellation, the service then loads a PipeWire WebRTC echo-cancel pair (`jarvis_ec_sink`,
`jarvis_ec_source`) over the board and makes that pair the default; without it the device's own
playback swamps the microphone and barge-in is impossible. XVF3800 devices get an equivalent
boot-time service that pins the PipeWire defaults to the board by USB identity. Jarvis opens the
PipeWire default for capture and playback on every profile.
The Lite USB firmware does not expose the 4-mic array's host pixel-ring commands, so its onboard
WS2812 is left under board/attached-MCU control instead of issuing failing USB writes.

The kiosk uses `http://127.0.0.1:8765`. Its `/api/events` WebSocket replaces legacy Playwright
JavaScript injection; the remaining loopback endpoints are a credential-hiding facade for
Spotify, cameras, screens, room lights, system volume, and voice taps. The lights and screen
endpoints read their state from the API on each request rather than caching it, so the
touchscreen agrees with the phone and with what voice just did.

Set `JARVIS_CODING_TASKS_ENABLED=true` only on touchscreens that should expose the manual Code
Factory tab. Its prompt recorder temporarily diverts the daemon's already-open microphone to a
bounded PCM buffer, transcribes it with the Jetson's faster-whisper service, and creates the task
only after the user presses stop. It is not connected to the agent tool surface.

Set `JARVIS_MUSIC_TAB_ENABLED=true` only on touchscreens that should show the Music tab. When
false, the tab is omitted from the bottom nav (Spotify voice/API integration is unchanged).

### Legacy rollback during migration

On an upgraded device, the prior runtime is retained as `jarvis-legacy.service`. Only one runtime
may own the microphone and local UI port at a time:

```bash
systemctl --user disable --now jarvis.service jarvis-kiosk.service
systemctl --user enable --now jarvis-legacy.service
```

Switch back with:

```bash
systemctl --user disable --now jarvis-legacy.service
systemctl --user enable --now jarvis.service jarvis-kiosk.service
```

Generated Sherman replies use the existing speaker and Kokoro path. This runtime
advertises `scripted_speech_v1`; it accepts a reply only while idle, acknowledges
completion after playback, and yields to a wake word or tap without opening its
own follow-up conversation. Sherman selects this device by its `JARVIS_DEVICE_ID`
in Sherman's `response_device_id` config. See the
[banter contract](../../contracts/devices/banter-v1.md).

The standby robot button uses local `GET /api/banter` and `POST /api/banter/trigger` endpoints.
The facade authenticates upstream and fixes the target to this device's `JARVIS_DEVICE_ID`;
Sherman's live pairing determines whether the button appears. It requests the same exchange
path used by spontaneous banter and starts a fresh automatic interval after the request.
