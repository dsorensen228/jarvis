# Jarvis device UI

The touchscreen UI used by Jarvis voice-interface devices. Its visual design and navigation are
carried forward from Jarvis. It talks only to the loopback HTTP/WebSocket bridge served
by `devices/voice`; credentials never enter the browser.

```bash
npm ci
npm run device-ui:build
```

The production build is written to `apps/device-ui/dist/` and served by the voice runtime.

On standby, tap the Jarvis avatar to start or stop a voice session. Devices paired with Sherman
also show a robot button beside volume: tap it to start a Sherman/Jarvis exchange, or press and
hold (~500 ms) to mute or unmute interactions. While muted, a single slash crosses the Sherman
robot icon (same cue as system volume mute); the Jarvis avatar is unchanged. Long-press the robot
again to unmute. Tap stays blocked while either device is unavailable, a voice session is active,
interactions are muted, or an exchange is running; long-press mute still works. Pairing and
availability come from the API, so other devices have no robot button.
Run `npm test --workspace @jarvis/device-ui` for the UI checks.
