# Contracts

This directory is the language-neutral compatibility boundary for all Jarvis clients.

- `openapi/jarvis-v1.json` is generated from the API and should not be hand-edited.
- `realtime/voice-v1.md` defines binary framing and JSON events for persistent voice sessions.

Future TypeScript, Kotlin, and Python client generation should consume these artifacts without
making one application depend directly on another application's source tree.

