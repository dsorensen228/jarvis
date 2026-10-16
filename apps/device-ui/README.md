# Jarvis device UI

The touchscreen UI used by Jarvis voice-interface devices. Its visual design and navigation are
carried forward from Jarvis. It talks only to the loopback HTTP/WebSocket bridge served
by `devices/voice`; credentials never enter the browser.

```bash
npm ci
npm run device-ui:build
```

The production build is written to `apps/device-ui/dist/` and served by the voice runtime.

On devices with `JARVIS_CODING_TASKS_ENABLED=true`, Code Factory has visible Code and Research
buttons. Each mode retains its own task list, history filter, scroll position, and unfinished
dictation draft. New research tasks use the existing record → review → create flow, with an
agent model and Concise, Standard, or In depth report detail. Activity, cancellation, and prompt
reuse work in both modes; follow-up tasks and streamed events remain code-only.

Completed research opens in an HTML reader covering the touchscreen. It preserves tables,
static SVG diagrams, section links, and source addresses. Text defaults to 16px and adjusts
from 14–22px without reloading the report. Controls are at least 48px, exceeding the
[W3C enhanced target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)
recommendation. The frame uses a restrictive sandbox and CSP; scripts, external resources,
and source navigation are disabled, following [MDN's srcdoc isolation guidance](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc).
The reader pauses idle standby while open. Alarms, voice sessions, and door-camera previews
take priority; the selected task and draft remain available afterward. Report responses are
not cached and credentials remain in the local bridge. Music uses a simple music-note icon.

Run `npm run test:e2e --workspace @jarvis/device-ui -- factory.spec.ts research-report.spec.ts`
for task flows, interrupted reading, both native screen sizes, and the report trust boundary.

The research and Music icon release `6b89d7a` was deployed on 2026-10-15 to office, kitchen,
bedroom, and mudroom. Their existing runtime root remains
`/home/example/.local/share/jarvis/releases/8483e39`; only the voice UI bridge and built web assets
were replaced. All four load `index-DhJn44PP.js` and `index-feO_DgUo.css`. Code Factory remains
enabled only in office; Music remains enabled in office and kitchen. The production build,
70 UI unit tests, 172 browser tests, and 200 voice tests passed. Live checks verified an existing
report in office, the Music note on both enabled devices, loaded asset hashes, voice connectivity,
and unchanged configuration, tokens, volume, favorites, and complete local/session storage.
Private rollback snapshots are on each device under
`~/.local/state/jarvis-upgrades/voice-research-6b89d7a-20261015T052708Z/`.

On standby, tap the Jarvis avatar to start or stop a voice session. Devices paired with Sherman
also show a robot button beside volume: tap it to start a Sherman/Jarvis exchange, or press and
hold (~500 ms) to mute or unmute interactions. While muted, a single slash crosses the Sherman
robot icon (same cue as system volume mute); the Jarvis avatar is unchanged. Long-press the robot
again to unmute. Tap stays blocked while either device is unavailable, a voice session is active,
interactions are muted, or an exchange is running; long-press mute still works. Pairing and
availability come from the API, so other devices have no robot button.
Run `npm test --workspace @jarvis/device-ui` for the UI checks.

Door alerts temporarily open the originating camera for ten seconds. A further alert switches
to its camera and restarts the ten-second window, then returns to the original screen with its
unfinished inputs intact. Navigating elsewhere (including selecting a camera) cancels the
automatic return. Alerts use the camera ID supplied by the voice runtime, so custom announcement
wording works too. Run `npm run test:e2e --workspace @jarvis/device-ui -- camera-preview.spec.ts`
for the mocked event, timing, and restoration checks.

Music now includes a full player with seeking, shuffle/repeat, device favorites, persistent search,
category filters, recent searches, and an Up Next queue. Favorites are saved on the kiosk; they do
not modify your Spotify library. A temporary network failure keeps the account connected and
exposes Retry. Only explicit sign-out clears the saved sign-in, favorites, and recent searches.

Browser regression coverage uses a mocked Spotify SDK and cannot produce household audio:

```bash
npx playwright install chromium
npm run test:e2e --workspace @jarvis/device-ui
```

The standby avatar follows the voice runtime's reported phase: listening has a steady lilac
rim and an outward ripple, thinking has two slowly orbiting arcs, and speaking has a gentle
pulse. A short status label distinguishes the states even with reduced motion enabled. The
clock stays in place throughout a turn. Announcement speech also lights the avatar without
claiming an active conversation. Run `npm run test:e2e --workspace @jarvis/device-ui --
voice-status.spec.ts` for the mocked voice-state and native-display checks.

The door-camera release `961f9e8` is deployed on 2026-10-01 to the API and all four voice
devices: bedroom, mudroom, office, and kitchen. They run `index-rf-_FZIS.js` and
`index-DAUsu61A.css`, including the earlier voice-status and Roku updates. Kitchen also received
its pending Roku bridge update. Voice services were restarted with the owner's authorization;
the API's model containers were not restarted. Source and loaded-asset checks, voice connectivity,
configuration digests, volume/mute settings, and saved timer/alarm state passed on every device.

Before rollout, the production build, 69 UI unit tests, 126 browser tests, and API/voice tests
passed; the final alarm-overlay change also passed all 38 camera-preview and timer browser checks.
Silent live checks exercise the actual front and side camera views and their ten-second return,
with private screenshots and timing evidence in each device's rollback directory. These checks
do not generate spoken announcements or mobile push notifications.

Device rollback snapshots and manifests are under
`~/.local/state/jarvis-upgrades/door-camera-20261001T2016Z/`. The API source and image rollback
record is under `/home/example/.local/state/jarvis-upgrades/door-camera-961f9e8/` on `jarvis`;
the prior image is tagged `jarvis-api:before-door-camera-961f9e8`.

Hold the standby light icon for half a second to open Lights; a short tap still toggles the
local room. The panel starts in the device's room, with horizontally scrollable room buttons,
explicit All on / All off controls, and a scrollable two-column list of individual lights.
Unavailable lights are labeled and disabled; unknown power is labeled and a tap turns it on.
Done, Escape, or tapping outside the panel dismisses it. Keyboard users can open it with
Arrow Down on the light button. State refreshes after commands and every fifteen seconds while
open. Commands are never automatically retried; partial failures remain visible. The menu uses
the existing smart-home API through the local voice bridge and never exposes credentials.
