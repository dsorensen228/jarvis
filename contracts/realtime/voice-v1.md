# Voice WebSocket protocol v1

Connect to `GET /v1/voice?token=<access-token>`. The connection persists for multiple turns.

## Input

1. Send `session.configure` with optional `device_id`, `device_name`, `room`, `conversation_id`,
   `personality_level`, and an `audio` object. The server upserts an identified voice device and its
   current connection state. `personality_level` is an integer from 1 through 3: concise/polite,
   dry/sardonic, or openly mean/profane. It changes presentation only; every level has the same capabilities.
   Send an explicit `null` `conversation_id` to start the next turn in a new conversation. Version 1
   accepts 8–48 kHz mono `pcm_s16le`; 16 kHz is the default and preferred wire rate. The ASR
   service resamples other declared rates to Whisper's 16 kHz input.
2. Send raw binary PCM frames as the Pi records speech.
3. When Pi-side VAD closes the utterance, send `{"type":"turn.end"}`.
4. Send `{"type":"response.cancel"}` for barge-in, then begin the next audio turn.

## Output

JSON events include `session.ready`, `transcription.final`, `response.started`,
`response.text.delta`, `response.audio.started`, `response.audio.done`, `turn.done`, and
`session.ended`.
Raw binary frames between `response.audio.started` and `response.audio.done` contain mono
signed 16-bit PCM at the sample rate declared by `response.audio.started`.

`tool.finished` includes the tool `name` and its JSON-decoded `result`. A display may use
successful results for local presentation (for example, mirroring a newly created timer) while
the API remains the durable source of truth.

The server invokes device-local capabilities with `device.action`, containing a unique
`request_id`, an `action`, and an `arguments` object. The device replies on the same socket with
`device.action.result`, echoing the `request_id` and supplying either `result` or `error`. These
requests are bounded to 30 seconds. Device-local actions include touchscreen, browser, Spotify,
and system-volume operations; credentials and hardware access remain on the device.

The server may send an unsolicited `announcement.started`, followed by raw PCM chunks and
`announcement.done`. The start event declares `text`, `encoding`, `sample_rate`, and `channels`.
Announcements interrupt an active turn and never open a follow-up listening window. This is used
for deterministic system events such as an opted-in camera person-detection alert; no LLM turn is
involved.

Successful one-shot control actions end with `session.ended` deterministically. A failed tool call
produces one plain-language `response.text.delta` (and audio when TTS remains available), then ends
with `session.ended`; the client must not reopen listening after an error. Empty transcriptions also
end the session. Search and open conversation turns end with `turn.done` and retain the conversation
until device idle timeout. Clients should drain already-received response audio before applying
`turn.done` or `session.ended`, so speaker playback cannot be recaptured as a new user turn.

Clients must ignore unknown JSON event types so additive protocol changes remain safe.

Idle-only generated robot replies use the additive `scripted_speech_v1` capability
and acknowledged `speech_status` / `play_scripted_speech` device actions. See the
[banter contract](../devices/banter-v1.md) for limits, ordering, interruption and
completion semantics.
