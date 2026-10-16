# Architecture

## Boundaries

Jarvis uses deployable boundaries, not language-wide shared packages:

- `apps/api` is the only public server and the source of truth for user data.
- `services/*` are private inference processes. They are replaceable as long as their small
  health/inference contracts remain stable.
- `apps/*` and `devices/*` are clients of the versioned public API.
- `contracts/*` contains generated OpenAPI plus hand-written realtime protocols. Client code
  may be generated independently for TypeScript, Kotlin, and Python.

There is no repository-wide runtime. A root npm workspace coordinates the migrated device UI
and will coordinate compatible JavaScript clients as they arrive. Gradle remains rooted in
`apps/wear`, and each Python deployable retains its own `.python-version`, manifest, lock,
image or host deployment, and tests.

This lets every Python process select the version required by its hardware or native wheels.
It also avoids forcing Gradle and Node projects through a Python-oriented workspace tool.

## Runtime flow

Text requests follow:

```text
client -> API -> llama.cpp -> optional API tools -> llama.cpp -> client
```

Voice requests follow:

```text
Pi VAD -> persistent API WebSocket -> faster-whisper -> Jarvis -> Kokoro -> same WebSocket
```

The same socket carries request/result RPC for device-owned capabilities such as Spotify,
touchscreen navigation, browser links, volume, and alarms. Camera description is routed through a
separate local Qwen vision runtime; no model runtime is loaded into the API process.

Audio is mono signed 16-bit PCM. The Pi decides when a turn ends and sends `turn.end`; the API
does not run another VAD implementation.

Each voice device runs one Python 3.13.5 process. USB VID/PID detection selects one of three
hardware profiles (ReSpeaker Lite, USB 4-Mic Array, or XVF3800); it is not an operating mode.
The process owns capture, WebRTC VAD, openWakeWord, ReSpeaker LEDs, interruptible playback, and
the loopback facade that serves the React kiosk. The browser never receives Jarvis credentials.

## Persistence

SQLite in WAL mode is the initial single-node store. Binary assets live in a mounted data
directory and SQLite stores their metadata. This matches the one-Jetson deployment, removes a
database container, and keeps backups to one database file plus one asset tree. A repository
interface can be introduced if the deployment becomes multi-node.

Personal-integration credentials are encrypted using a key derived from the deployment secret.

Home Assistant owns every smart-home device integration, discovery, and state, and Jarvis holds
one provider-neutral model above it: a device is a record with a list of addressable components
(`main`, or `socket_1`/`socket_2` on a plug with separate outlets), each advertising only the
capabilities its Home Assistant entity genuinely reports. Actions are neutral too, so no client
or tool names a vendor. Imported device ids stay derived from the vendor id, which is why rooms,
labels, primary-screen choices, and scheduled references survived the move unchanged. This is
capability dispatch, not an operating mode exposed to clients.

## What is intentionally gone

The rebuild has no operating-mode router variants, agent-auth duplicate routes, provider model
catalog, cloud LLM branches, LangChain/LangGraph graph, server-side VAD, or separate Pi/Wear/chat
agent implementations. Device and UI differences belong at the protocol edges.

## Future migrations

The remaining packages move one at a time after the v1 contract is stable. Their source runtime
versions remain local to their directory:

- Expo and compatible React packages join the existing root npm workspace when they arrive.
- Kotlin/Wear keeps Gradle wrappers under `apps/wear` and `apps/wear-factory`.
- Python device processes each keep their own `pyproject.toml`, `.python-version`, and lockfile.
- Reusable semantics cross boundaries as schemas in `contracts`, not imports from `apps/api`.
