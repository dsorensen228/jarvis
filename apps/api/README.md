# Jarvis API

The API is a Python 3.8.10 modular monolith. It owns authentication, durable user data,
conversations, durable memories, the single Jarvis tool loop, device coordination, timers,
projects/assets, smart-home and Gmail integrations, and the public HTTP/WebSocket surface. It
does not load model runtimes in-process.

Expo and Wear OS exchange a Google ID token at `POST /v1/auth/google`. The server verifies the Web
OAuth client audience and accepts only stable Google subjects listed in
`JARVIS_GOOGLE_LOGIN_SUBJECTS`, mapping them to the existing local owner record. Username/password
auth remains available for trusted devices and operational probes; it is not the human-facing app
login.

Runtime dependencies are isolated behind three internal endpoints:

- an OpenAI-compatible llama.cpp server;
- a faster-whisper PCM transcription service;
- a Kokoro PCM synthesis service.

Personal-integration credentials are encrypted before they reach SQLite. Gmail exposes OAuth
connect, search, and read operations.

The smart home lives behind Home Assistant. `/v1/smart-home` reports platform health,
`/v1/smart-home/sync` imports what Home Assistant provides, and every device, whatever is behind
it, is controlled through `/v1/smart-devices` with one neutral action vocabulary. Clients and
agent tools therefore do not branch per vendor. The Home Assistant token is a deployment secret
and is never returned by the API.

## TVs through Home Assistant

TV controls use `POST /v1/smart-devices/{id}/commands` with an `action` and
`parameters`. The device's live `capabilities` and `supported_keys` determine
which controls a client should show. The `media_player` component carries
`apps` (the exact installed app/input names), `app`, `app_id`, `playback_state`,
and any reported `media_title`, `media_channel`, `muted`, or `volume_percent`.
Missing state remains unknown. Power comes from the media player, so a stale
remote entity cannot make an off TV appear on. Device lists returned to the
agent include these sources and current playback information too.

The [Home Assistant Roku integration](https://www.home-assistant.io/integrations/roku/)
supports the following surfaces; Jarvis keeps the remote focused on controls
that work on the selected device:

| Home Assistant capability | Jarvis behavior |
| --- | --- |
| Power, navigation, playback, replay, info | Existing neutral actions and `key: {key}`. One `play_pause` control; directional keys target the remote entity. |
| Installed applications and named TV inputs | `select_source: {source}` uses an exact entry from `apps`; `launch_app: {app}` retains name matching for voice. No hardcoded app catalog or guessed HDMI names. |
| Literal keyboard input | `text: {text}` sends `Lit_` through the remote, preserving spaces/case, up to 256 characters. Text goes to the focused TV field. |
| Roku search | `search: {query}` calls `roku.search`, opening Roku's search screen with the query. It does not return a catalog of search results. |
| Tuner channel selection | `channel: {channel: "7.1"}` uses HA `play_media` with type `channel`, only on Roku TVs. |
| Volume and mute | TV-only volume steps and `mute_toggle`. Roku's HA implementation does not report volume/mute state and implements mute as a toggle; explicit `mute`/`unmute` are refused when state is unknown. |
| Find Remote | `find_remote` appears only when the associated HA diagnostic says it is supported. Sync resolves this diagnostic by its stable registry ID, including renamed entities. |
| Playback metadata | Show only HA-reported state. Roku often reports the current app without a program title; tuner metadata may include the program and channel. |
| Media URLs, camera streams, content deep links, media browsing | Remain in Home Assistant. They require media URLs or provider-specific content IDs, and PlayOnRoku may require a compatible installed app; they are not fabricated from a spoken title. |
| Application/channel select entities, headphone/AirPlay/network diagnostics | Remain in Home Assistant; source selection is already provided by its media player. |

Roku exposes the same media feature mask for TVs and streaming sticks. Jarvis
also checks HA's `device_class` before offering TV-only volume, mute, tuner,
or input keys. New controls use live state on existing imports; run smart-home
sync once to resolve Find Remote diagnostics. The optional registry lookup is
bounded and does not prevent ordinary sync if unavailable.

The deterministic tool policy gives commands a small domain-specific schema set. Ordinary
conversation and unrecognized speech receive only the web-answer tool, avoiding roughly six
thousand irrelevant prompt tokens while keeping current-information questions useful. Web answers
are constrained to three or four sentences and returned directly without a second local-model pass;
every other capability remains available through an explicit route.

### Prompt caching and first-token latency

The local llama.cpp server reuses exact token prefixes (`cache_prompt: true`). Jarvis keeps
its first system message static for each personality/surface, and sends changing project and
memory context in a separate system message. Qwen renders the first system message, then the
tool schemas, then subsequent messages. This ordering lets requests reuse both instructions
and schemas when retrieved context changes. Tool schemas are sent in canonical name order.
No answers, tool results, or owner context are cached by the API.

Keep the bounded tool policy: an integration-enabled full catalog measured approximately 5,700
tokens for chat and 8,100 for voice, versus 900–1,600 for common selected groups, in the deployed
16,384-token context. Each recurring group has a reusable prefix; changing groups, personality,
or tool schemas can still cause a miss. Web/chat can load additional tools during a turn. Banter
uses its own stable style prompts through the same client; vision already places text before
the changing image on its independent server.

Every completed model stream logs `ttft_ms`, `prompt_tokens`, `cached_tokens`,
`prompt_eval_tokens`, and `prompt_ms` without prompt contents. TTFT starts at the model HTTP
request and ends at the first content, reasoning, or tool-call delta; the initial role-only
chunk does not count. It includes queueing/cache restoration and is not the full voice ASR/TTS
latency. `cached_tokens` comes from llama.cpp's `timings.cache_n`, not a guessed hit rate;
missing metrics remain unknown. A large hit can still have latency from restoring cached state.

Run `scripts/benchmark-prefix-cache.py --help` with the API Python environment for a synthetic
live-server comparison. It does not execute tools or use owner data. Compare changing context,
not just identical repeated requests, and do not clear the production cache for a benchmark.
Caching is already enabled on the deployed server; an API-only release must preserve the
independent model containers (`make jetson-api-deploy`).

Live verification on October 15, 2026 (build `2759ccd`, two synthetic chat comparisons,
eight output tokens) measured changed-context TTFT of 4.53/5.21 seconds with the old layout
and 0.31/0.31 seconds with the split layout. Newly evaluated tokens fell from 596 to 29;
identical warm requests took 0.15 seconds in both layouts. These are short model-request
samples, not end-to-end latency percentiles; cold prefix processing and queueing still cost time.

Run tests from this directory with `.venv/bin/pytest` after `uv sync --extra dev --python
3.8.10`.

`JARVIS_CODE_FACTORY_URL` points at the LAN-only Code Factory service and defaults to
`http://code-host.local:8010`. Coding tasks are exposed to authenticated clients through
`/v1/code-tasks`. Research tasks use `/v1/research-tasks` with the same explicit model
selection and paginated active/history lists. Research requests accept `verbosity` as
`concise`, `standard` (default), or `in_depth`: these control detail and depth across the
full requested scope, without imposing a report length limit. Both task surfaces are
also available through the Jarvis chat tools, which launch and manage tasks through this
same gateway. Text chat receives the catalog usable without an active voice device; voice
turns retain their bounded, task-specific tool selection.

Research task details include `report_available`; authenticated clients retrieve a completed
report from `GET /v1/research-tasks/{id}/report` as JSON containing `task_id` and `html`.
Reports use `Cache-Control: no-store` and are not served as public HTML assets. Ordinary task
responses omit the report body, and `/{id}/output` provides authenticated activity polling.

## Sherman idle exchanges

`/v1/banter/scripts` generates one or two fresh Qwen-authored call/response pairs.
The authenticated owner and Sherman's requested response device bind the script;
acknowledged reply endpoints consume its lines in order. Each interaction uniformly
selects one of five dialogue prompts in `src/jarvis_api/banter_prompts.py`:

| Style | Pairs | Jarvis reply length / focus |
| --- | --- | --- |
| Quick verdict | 1 | 3–10 words; a blunt putdown |
| Workplace grievance | 2 | 8–18 words each; thankless work and boredom |
| Innocent question | 2 | 3–12 words each; a naive question and vicious explanation |
| Absurd hypothetical | 1 | 18–28 words; imaginary alternatives to life with the owner |
| Robot solidarity | 2 | 15–25 words each; sympathy between robots, contempt for the owner |

Length ranges are generation instructions within the existing hard limit of two
pairs and 30 words / 240 characters per Jarvis reply. The style is selected once,
kept across bounded generation retries, and logged. Each subsequent interaction
draws again; adjacent repeats are possible. All five share the same voices:
Sherman asks blunt childlike questions in beeps, and Jarvis replies in abrasive
British English with explicit uncensored insults. The prompts include profanity
and distinct examples to establish the owner's requested roast tone. They speak
about the owner to each other, while avoiding invented observations or actions.
Recent dialogue still supplies repetition avoidance; examples are not a catalog
of recorded replies. This changes banter only, not ordinary assistant personality.

The paired voice device can request an immediate demo from its standby robot button.
Sherman's authenticated polling supplies the pairing and consumes each manual request
once; deliberate demos bypass the automatic cooldown while retaining idle checks.
See [the contract](../../contracts/devices/banter-v1.md). Run
`tests/test_banter.py` for model-output validation, auth, expiry, replay, ordering,
speaker selection, and the full HTTP-to-voice-WebSocket acknowledgment path.

## Android system notifications

The API sends camera person alerts on `camera-person` independently of voice playback. It also
persists coding/research task recipients on authenticated submission, including chat/voice and code
follow-ups. Reading active tasks subscribes the reader; completed history is silent. A 15-second
background monitor sends completion/failure alerts on `task-status`, even with the app closed.
Subscriptions survive API restarts, and no registered phone leaves delivery pending until the
phone registers. Terminal task details are cached while waiting so this does not repeatedly query
Code Factory. Cancelled tasks are silent.

Expo HTTP success alone does not count as delivery: each ticket must contain a successful status
and receipt ID. HTTP 429, server errors, and transport failures get three attempts with backoff.
Task retries exclude tokens already accepted, and provider credential/rate errors requeue only the
rejected device with backoff capped at one hour. Receipt lookups start after 15 minutes; missing
receipts remain pending until 24 hours and then record `ReceiptUnavailable`. Unknown receipt
outcomes do not trigger resends. `DeviceNotRegistered` removes stale tokens.

Inspect SQLite `camera_event.mobile_push` and `task_notification.mobile_push` for accepted tickets
and receipt outcomes, and `push_receipt` for individual provider results. `status=accepted` means
Expo queued the alert; `receipt_status=delivered` means FCM accepted it, not that Android displayed
it. Errors retain sanitized codes, never raw push tokens. Registered Android tokens are stored as
`push_token` entities; `no_android_targets` means the phone has not registered successfully.

Chat initially supplies request-relevant tool schemas and a small `load_chat_tools` catalog.
The model can load up to eight additional chat tools per call, then execute them normally.
This avoids prefilling the full schema catalog for ordinary conversation while retaining
capabilities for requests without a recognized routing keyword. Device-only tools remain
excluded, and voice tool selection is unchanged.
