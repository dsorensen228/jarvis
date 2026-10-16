"""Persistent Jarvis voice WebSocket with bounded reconnect behavior."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from websockets.asyncio.client import connect

from jarvis_voice.api import JarvisApiClient

logger = logging.getLogger(__name__)

EventHandler = Callable[[str, dict[str, Any]], Awaitable[None]]
AudioHandler = Callable[[bytes], Awaitable[None]]
ConnectionHandler = Callable[[bool], Awaitable[None]]


class VoiceProtocolClient:
    def __init__(
        self,
        api: JarvisApiClient,
        device_id: str,
        room: str,
        sample_rate: int,
        personality_level: int,
        on_event: EventHandler,
        on_audio: AudioHandler,
        on_connection: ConnectionHandler,
    ) -> None:
        self._api = api
        self._device_id = device_id
        self._room = room
        self._sample_rate = sample_rate
        self._personality_level = personality_level
        self._on_event = on_event
        self._on_audio = on_audio
        self._on_connection = on_connection
        self._conversation_id: str | None = None
        self._outbound: asyncio.Queue[tuple[int, str | bytes]] = asyncio.Queue(maxsize=256)
        self._connected = asyncio.Event()
        self._closing = asyncio.Event()
        self._generation = 0
        self._task: asyncio.Task[None] | None = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    @property
    def conversation_id(self) -> str | None:
        return self._conversation_id

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="voice-websocket")

    async def wait_connected(self, timeout: float = 15.0) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout=timeout)

    async def configure_conversation(self, conversation_id: str | None) -> None:
        self._conversation_id = conversation_id
        if self.connected:
            await self._send_json({"type": "session.configure", "conversation_id": conversation_id})

    async def send_audio(self, pcm: bytes) -> None:
        if pcm:
            await self._send(pcm)

    async def end_turn(self) -> None:
        await self._send_json({"type": "turn.end"})

    async def cancel_response(self) -> None:
        await self._send_json({"type": "response.cancel"})

    async def send_device_action_result(
        self,
        request_id: str,
        *,
        result: Any = None,
        error: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "type": "device.action.result",
            "request_id": request_id,
        }
        if error is None:
            payload["result"] = result
        else:
            payload["error"] = error
        await self._send_json(payload)

    async def close(self) -> None:
        self._closing.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        await self._set_connected(False)

    async def _send_json(self, payload: dict[str, Any]) -> None:
        await self._send(json.dumps(payload, separators=(",", ":")))

    async def _send(self, payload: str | bytes) -> None:
        if not self.connected:
            raise ConnectionError("Jarvis voice WebSocket is not connected")
        await self._outbound.put((self._generation, payload))

    async def _run(self) -> None:
        backoff = 1.0
        while not self._closing.is_set():
            sender: asyncio.Task[None] | None = None
            try:
                token = await self._api.access_token(force=backoff > 1.0)
                async with connect(
                    self._api.voice_websocket_url,
                    additional_headers={"Authorization": f"Bearer {token}"},
                    compression=None,
                    max_size=None,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as websocket:
                    self._generation += 1
                    generation = self._generation
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "session.configure",
                                "device_id": self._device_id,
                                "device_name": self._device_id,
                                "room": self._room,
                                "conversation_id": self._conversation_id,
                                "personality_level": self._personality_level,
                                "capabilities": ["scripted_speech_v1"],
                                "audio": {
                                    "encoding": "pcm_s16le",
                                    "sample_rate": self._sample_rate,
                                    "channels": 1,
                                },
                            },
                            separators=(",", ":"),
                        )
                    )
                    await self._set_connected(True)
                    backoff = 1.0
                    sender = asyncio.create_task(
                        self._sender(websocket, generation), name="voice-websocket-sender"
                    )
                    async for message in websocket:
                        if isinstance(message, bytes):
                            await self._on_audio(message)
                            continue
                        try:
                            payload = json.loads(message)
                        except json.JSONDecodeError:
                            logger.warning("backend sent invalid voice JSON")
                            continue
                        event = str(payload.get("type") or "")
                        data = payload.get("data")
                        if not isinstance(data, dict):
                            data = {}
                        if event in {"session.configured", "turn.done"}:
                            conversation_id = data.get("conversation_id")
                            if conversation_id is None or isinstance(conversation_id, str):
                                self._conversation_id = conversation_id
                        await self._on_event(event, data)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("voice WebSocket disconnected: %s", exc)
            finally:
                if sender is not None:
                    sender.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await sender
                await self._set_connected(False)
                self._discard_stale_outbound()
            if not self._closing.is_set():
                await asyncio.sleep(backoff)
                backoff = min(15.0, backoff * 2.0)

    async def _sender(self, websocket: Any, generation: int) -> None:
        while True:
            item_generation, payload = await self._outbound.get()
            if item_generation != generation:
                continue
            await websocket.send(payload)

    async def _set_connected(self, connected: bool) -> None:
        changed = self._connected.is_set() != connected
        if connected:
            self._connected.set()
        else:
            self._connected.clear()
        if changed:
            await self._on_connection(connected)

    def _discard_stale_outbound(self) -> None:
        while True:
            try:
                self._outbound.get_nowait()
            except asyncio.QueueEmpty:
                return
