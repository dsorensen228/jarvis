> **Published branch snapshot:** UNO Q spinner firmware and deployment.
> See [the main project overview](https://github.com/dsorensen228/jarvis) for repository context.
> Deployment configuration in this public copy uses illustrative values.

# Jarvis

Jarvis is a local-first personal assistant built as a polyglot monorepo. It is the clean
successor to Jarvis: one Jarvis agent and one versioned API, with hardware-specific
inference isolated behind internal service contracts.

The API, Jetson inference services, Raspberry Pi voice and camera runtimes, touchscreen UI, Expo
application, and Wear OS application live here as independently built deployables.

## Repository map

```text
apps/
  api/              Python 3.8.10 public API and Jarvis agent
  mobile/           Expo Android/iOS/web app
  device-ui/        React touchscreen UI for voice devices
  wear/             Kotlin/Wear OS Jarvis app
  wear-factory/     Kotlin/Wear OS Code Factory app
devices/
  voice/            Python 3.13.5 Raspberry Pi voice runtime
  camera/           Raspberry Pi AI Camera runtime
packages/            Same-toolchain libraries extracted only when two consumers exist
services/
  asr/              faster-whisper internal service
  llm/              llama.cpp internal service
  tts/              Kokoro internal service
  code-factory/     Native Mac autonomous coding task service
contracts/          Language-neutral OpenAPI and realtime protocol contracts
deploy/
  jetson/           Jetson deployment composition
docs/               Architecture and migration decisions
```

Each deployable owns its runtime and dependency lock. There is deliberately no root Python
environment: the future Python apps do not all use the same Python version, while the Expo,
React, and Kotlin builds have unrelated toolchains.

## API development

```bash
make api-sync
cp .env.example .env
make api-test
make api-run
```

The authenticated OpenAPI UI is available at `http://localhost:8000/docs`. The public API is
under `/v1`; `/health/live` and `/health/ready` are operational probes.

## Voice-device development

The browser UI is a root npm workspace; the Pi process owns a separate exact Python runtime:

```bash
make device-ui-sync
make device-ui-build
make voice-sync
make voice-models
make voice-lint
make voice-test
```

See [the voice-device guide](devices/voice/README.md) for supported ReSpeaker hardware,
Bookworm/Trixie installation, and the persistent voice protocol.

## Mobile, Wear OS, and camera development

```bash
make mobile-sync mobile-typecheck mobile-web
make wear-debug
make wear-factory-debug
make camera-sync camera-lint camera-test
```

The Expo app and Wear app retain their existing application identities. Live audio chat was
removed from Expo; Wear uses Android speech recognition with the canonical v1 Jarvis/Kokoro turn.
The camera is an independent Raspberry Pi runtime with onboard IMX500 detection. See the
[mobile](apps/mobile/README.md), [Wear OS](apps/wear/README.md), and
[camera](devices/camera/README.md) guides for deployment details.

## Jetson deployment

Place model files under `models/`, set secrets in `.env`, and use:

```bash
make jetson-build
make jetson-up
```

See [the architecture notes](docs/architecture.md), [API migration scope](docs/api-migration.md),
and [Jetson deployment guide](deploy/jetson/README.md) before building on the target.

## Autonomous code host

The Mac mini hosts the upstream Jarvis and Sherman repositories plus native Temporal and Code
Factory services backed by Jarvis's existing MongoDB Atlas instance. See [the Mac deployment guide](deploy/macmini/README.md) for the workspace,
launch-daemon installation, task API, and self-update behavior.
