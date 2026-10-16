# Wear chat protocol v1

Send an authenticated `POST /v1/wear/chat` with JSON containing `message` and an optional
`conversation_id`. The watch performs speech recognition locally. The API uses the shared Jarvis
agent and its chat tools, including named-room and named-device light control, smart-device
discovery, and television control. A watch has no fixed room; specify a room or device when needed.

Without `Accept: text/event-stream`, the response remains a single JSON object with
`conversation_id`, `response`, `audio_base64`, `audio_encoding`, and `sample_rate`.

With `Accept: text/event-stream`, the same endpoint returns UTF-8 server-sent events. Each event
has an `event:` name and one JSON `data:` line, followed by a blank line:

1. `response.text.delta` contains `{ "text": "..." }`. Append each delta to the visible response
   immediately while generation continues.
2. `response.completed` contains `{ "conversation_id": "...", "response": "..." }` after the
   agent saves the final answer, before speech synthesis finishes. Use this authoritative text and
   retain the conversation ID for follow-ups.
3. `response.audio` contains `{ "audio_base64": "...", "audio_encoding": "pcm_s16le",
   "sample_rate": 24000 }`. Decode the complete audio and play it at the declared sample rate.
   Audio is mono signed 16-bit little-endian PCM; the sample rate shown is an example.
4. `turn.done` contains `{}` and ends the turn. Let buffered audio finish playing.

An `error` event contains `{ "message": "..." }` and is followed by `turn.done`. A synthesis
failure leaves the already delivered final text and conversation ID intact and sends no audio.
An agent failure may follow partial text, with no `response.completed` or audio. Do not treat
partial text as a completed answer. Authentication and request validation failures retain their
normal HTTP error statuses before a stream starts.

Ignore unknown event names and SSE comments, including `: keep-alive`. The server disables proxy
buffering and caching. Disconnecting cancels pending generation or synthesis and waits for upstream
resource cleanup.
