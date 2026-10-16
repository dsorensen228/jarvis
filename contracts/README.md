# Contracts

This directory is the language-neutral compatibility boundary for all Jarvis clients.

- `openapi/jarvis-v1.json` is generated from the API and should not be hand-edited.
- `realtime/voice-v1.md` defines binary framing and JSON events for persistent voice sessions.
- `code-factory-v1.md` defines job pagination, resumable live activity, and queued follow-ups.
- `research-v1.md` defines research depth, task isolation, and embedded HTML reports.

Future TypeScript, Kotlin, and Python client generation should consume these artifacts without
making one application depend directly on another application's source tree.
