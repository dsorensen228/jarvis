# Generated robot banter v1

A stationary robot initiates `POST /v1/banter/scripts` with its normal owner bearer
token. The request has `source_device_id`, `response_device_id`, and optionally
`recent_exchanges` (at most eight previously performed exchange objects). IDs are
1–100 ASCII letters, digits, `_` or `-`. The response speaker is selected by the
robot's configuration, never by model output. There is no default speaker in the API.

The API checks that the selected voice device is connected under the same owner,
advertises `scripted_speech_v1`, and is idle. It calls the existing local Qwen
client without tools, then checks the speaker again. Each interaction randomly
selects one of eight generation prompts: five Sherman-led (quick verdict, workplace
grievance, innocent question, absurd hypothetical, or robot solidarity) and three
Jarvis-led (opening verdict, gossip lead, or recruiting). The selected prompt
specifies one or two connected exchanges, who speaks first, and a distinct
reply-length range; the same selection is retained across generation retries. All
share blunt, sulky Sherman and an abrasive British Jarvis who alone understands his
beeps. Jarvis uses explicit profanity while talking about their owner to Sherman.
The styles vary the subject and pacing, from a short putdown to a longer robot
conversation. Jarvis-led scripts set `initiator` to `jarvis` so the robot plays
Jarvis's line before Sherman's beep for each exchange; Sherman-led scripts use
`initiator: sherman` (the default).
This prompt is independent of a speaker's ordinary interactive personality setting.
There are no canned exchanges or repair/fallback dialogue.

The response includes:

- `schema_version`: integer 1;
- `script_id`: fresh 32-character lowercase hexadecimal ID;
- `source_device_id`, `response_device_id`: exact requested IDs;
- `expires_in_seconds`: 180, starting after generation;
- `initiator`: `sherman` or `jarvis`, naming who speaks first in each exchange;
- `exchanges`: one or two objects, each containing `sherman` (English meaning,
  1–180 characters), `emotion` (`curious`, `pleased`, `skeptical`, `indignant`, or
  `conspiratorial`), and `jarvis` (1–240 characters, at most 30 words).

The canonical content schema originates in Sherman
`proto/schema/banter-script-v1.json`; the matching shared fixture is under
`apps/api/tests/fixtures/banter-script-v1.json`. The full HTTP contract is generated
by `make contracts` into `contracts/openapi/jarvis-v1.json`. Invented owner actions, the stale "He's X again / Can we / Only if" joke pattern,
extra content fields, unknown emotions, invalid JSON, oversized output, or timeout
reject the attempt; style rejects may be regenerated a few times server-side, then
the whole script fails. The model cannot supply commands, audio URLs, output devices, or file paths.

For `initiator: sherman` (default), the robot renders each `sherman` meaning as
local procedural beeps, then calls
`POST /v1/banter/scripts/{script_id}/replies/{exchange_index}` with an empty body.
For `initiator: jarvis`, it requests the Jarvis reply first, then plays the beep.
Index starts at zero. The API speaks only the corresponding stored Jarvis line on
the bound target. Success returns `status: played`, `script_id`, and
`exchange_index` only after the device acknowledges playback. Only then may the
robot begin the next exchange.

For automatic banter, the API admits one attempt per authenticated owner per five minutes and retains at
most 128 owners in memory. Generation is bounded to 45 seconds and 4096 UTF-8 bytes.
Scripts expire after 180 seconds; old IDs also become invalid on API restart.
Replies are consumed *before* network I/O. Duplicate, expired, wrong-owner,
out-of-order, busy, unsupported, and unavailable requests return HTTP 409. There
is no replay after a lost response, and no queue for offline devices. A failed reply
invalidates the remainder of that script. Clients skip the attempt and draw a fresh
normal interval, including after invalid model content; never immediately retry.

## Standby demo button

An enabled Sherman daemon posts its configured `source_device_id`,
`response_device_id`, and boolean `ready` to `/v1/banter/poll` every five seconds.
The authenticated owner's pairing makes the robot button appear beside volume on
that voice device's standby screen. The voice runtime proxies `GET /api/banter`
to `GET /v1/banter/devices/{response_device_id}`, fixing the ID to its own config.
The response contains `paired`, `available`, `busy`, `status`, and
`source_device_id`. A robot not seen for 15 seconds is unavailable; the pairing
expires after 300 seconds. At most 128 pairings are held in memory.

The button posts `/api/banter/trigger`, proxied to the associated device's
`POST /v1/banter/devices/{response_device_id}/trigger`. An idle, connected response
speaker and recently ready robot are required. One request is queued for up to
90 seconds, then delivered once as `trigger_id` in a ready robot poll. Polls
without a request return `trigger_id: null`. The robot passes that ID to script
creation to bypass only the automatic cooldown; overlapping scripts, non-idle
devices, wrong owners/devices, expired IDs, and replay remain rejected.

The robot performs the existing sequential chirp/reply path and reports
`result: {trigger_id, status}` in its next poll, with status `completed` or `failed`.
Outcome acknowledgments are idempotent, running requests expire after 180 seconds,
and a failed robot outcome retires the matching script. The UI disables the button
while unavailable or running and reports completion or failure. A manual request
samples a fresh automatic interval so scheduled chatter does not immediately follow.

## Voice device actions

`session.configure.capabilities` may include `scripted_speech_v1`. The server uses
existing `device.action` / `device.action.result` messages:

- `speech_status`, empty arguments: return `{"idle": true}` only when the voice
  device is idle with working audio, no active conversation/announcement/coding
  recorder, and no queued speech. Readiness is advisory, checked again at playback.
- `play_scripted_speech`, arguments `sample_rate` and `pcm_base64`: strictly decoded
  mono signed little-endian PCM16, 8–48 kHz and at most 20 seconds. The device returns
  `status: played` after its audio queue and reported output latency drain; `busy`,
  `interrupted`, or `failed` abort the script. A wake word or user tap stops playback
  and retains the user's new conversation. Speech never opens a follow-up window.

Unlike camera alerts, scripted speech does not interrupt an active user turn.
Readiness has a 3-second deadline; reply synthesis/dispatch/ack has a 45-second total
deadline (the existing device action itself is limited to 30 seconds). The existing
announcement protocol is unchanged. Older voice devices remain usable for normal
voice; they cannot be selected for this feature until upgraded.
