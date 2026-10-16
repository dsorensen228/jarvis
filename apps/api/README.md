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

The deterministic tool policy gives commands a small domain-specific schema set. Ordinary
conversation and unrecognized speech receive only the web-answer tool, avoiding roughly six
thousand irrelevant prompt tokens while keeping current-information questions useful. Web answers
are constrained to three or four sentences and returned directly without a second local-model pass;
every other capability remains available through an explicit route.

Run tests from this directory with `.venv/bin/pytest` after `uv sync --extra dev --python
3.8.10`.

`JARVIS_CODE_FACTORY_URL` points at the LAN-only Code Factory service and defaults to
`http://code-host.local:8010`. Coding tasks are exposed to authenticated clients through
`/v1/code-tasks`; these endpoints are intentionally not registered as Jarvis agent tools.

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
