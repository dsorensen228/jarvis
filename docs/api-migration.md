# API migration scope

The v1 API preserves capabilities, not old route shapes. Clients migrating from Digital
Fiefdom should adopt the generated OpenAPI contract instead of receiving compatibility aliases.

## Preserved in the clean API

- local identity, access/refresh tokens, and user settings;
- conversations, text and streaming chat, one Jarvis agent, and durable memory;
- todos, shopping lists, and locally scheduled timers;
- projects, searchable text assets, and binary file assets;
- registered voice, camera, display, and wearable devices plus camera callbacks;
- Govee discovery/control and Roku LAN discovery/control through normalized smart devices;
- Gmail OAuth, message search/read, digest alerts, alert dismissal, and Expo push-token storage;
- authenticated event and voice WebSockets;
- faster-whisper transcription and Kokoro synthesis through private services.

## Replaced

- Cloud Tasks timer callbacks are a local scheduler and realtime event.
- MongoDB is SQLite WAL plus an asset directory for this single-node deployment.
- foreground events use the persistent `/v1/events` WebSocket; mobile push tokens are stored per
  device and the Expo app handles foreground Gmail alerts locally.
- provider-specific smart-home chats are normal Jarvis tool calls.

## Intentionally removed

- client-specific and generic-chat route variants;
- multi-agent delegation, model catalogs, per-request model selection, and cloud AI providers;
- LangChain/LangGraph orchestration and duplicate agent-auth CRUD routes;
- server-side VAD and one-request-per-utterance voice paths;
- internal HTTP callbacks that existed only to connect old services to one another;
