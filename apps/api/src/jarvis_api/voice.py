"""Persistent, bidirectional voice session protocol."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import re
import uuid
from collections import defaultdict
from typing import Any, Dict, Optional

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from jarvis_api.agent import JarvisAgent
from jarvis_api.auth import websocket_user
from jarvis_api.config import Settings
from jarvis_api.domain import utc_now_iso
from jarvis_api.speech import SpeechService

SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
WORD = re.compile(r"[a-z0-9']+")


class VoiceConnectionHub:
    """Routes deterministic server announcements to connected voice devices."""

    def __init__(self) -> None:
        self._sessions: Dict[str, Dict[str, VoiceSession]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def register(self, session: VoiceSession) -> None:
        if session.device_id is None:
            return
        async with self._lock:
            self._sessions[session.user["id"]][session.device_id] = session

    async def unregister(self, session: VoiceSession) -> None:
        async with self._lock:
            user_sessions = self._sessions.get(session.user["id"])
            if not user_sessions:
                return
            stale = [device_id for device_id, value in user_sessions.items() if value is session]
            for device_id in stale:
                user_sessions.pop(device_id, None)
            if not user_sessions:
                self._sessions.pop(session.user["id"], None)

    async def announce(
        self,
        user_id: str,
        device_ids: set[str],
        text: str,
        *,
        camera_device_id: Optional[str] = None,
    ) -> list[str]:
        async with self._lock:
            targets = [
                (device_id, session)
                for device_id, session in self._sessions.get(user_id, {}).items()
                if device_id in device_ids
            ]
        if not targets:
            return []
        results = await asyncio.gather(
            *(session.announce(text, camera_device_id=camera_device_id) for _, session in targets),
            return_exceptions=True,
        )
        return [
            device_id
            for (device_id, _), result in zip(targets, results)
            if not isinstance(result, Exception)
        ]

    async def _scripted_session(self, user_id: str, device_id: str) -> VoiceSession:
        async with self._lock:
            session = self._sessions.get(user_id, {}).get(device_id)
        if session is None or not session.scripted_speech_supported:
            raise RuntimeError("response device is offline or lacks scripted speech")
        # Leftover session.audio after response.cancel looks like an in-flight
        # utterance but the device may already be idle. Trust speech_status for
        # that case; only hard-busy on an active turn, announcement, or action.
        if session.turn_task and not session.turn_task.done():
            raise RuntimeError("response device is busy")
        if session._announcement_lock.locked() or session._device_actions:
            raise RuntimeError("response device is busy")
        return session

    async def scripted_speech_ready(self, user_id: str, device_id: str) -> None:
        session = await self._scripted_session(user_id, device_id)
        result = await session._invoke_device_action("speech_status", {}, timeout=3.0)
        if not isinstance(result, dict) or result.get("idle") is not True:
            raise RuntimeError("response device is busy")
        # Device confirmed idle: drop orphaned mic bytes left by interrupt/cancel.
        session.audio.clear()

    async def speak_scripted(self, user_id: str, device_id: str, text: str) -> None:
        session = await self._scripted_session(user_id, device_id)
        async with session._announcement_lock:
            pcm, sample_rate = await session.speech.synthesize_pcm16(text)
            if not 8000 <= sample_rate <= 48000 or not pcm or len(pcm) % 2:
                raise RuntimeError("invalid speech audio")
            if len(pcm) > sample_rate * 2 * 20:
                raise RuntimeError("scripted speech exceeds 20 seconds")
            if session.audio or (session.turn_task and not session.turn_task.done()):
                raise RuntimeError("response device became busy")
            result = await session._invoke_device_action(
                "play_scripted_speech",
                {
                    "pcm_base64": base64.b64encode(pcm).decode("ascii"),
                    "sample_rate": sample_rate,
                },
            )
            if not isinstance(result, dict) or result.get("status") != "played":
                raise RuntimeError("response playback did not complete")


def _looks_like_playback_echo(transcript: str, previous_response: str) -> bool:
    heard = set(WORD.findall(transcript.casefold()))
    spoken = set(WORD.findall(previous_response.casefold()))
    if len(heard) < 4 or not spoken:
        return False
    return len(heard & spoken) / len(heard) >= 0.8


def _exact_local_light_phrase(text: str) -> bool:
    """True when a voice device may short-circuit lights without the LLM."""
    normalized = " ".join(str(text or "").casefold().split()).strip(".,!?;:")
    return normalized in {"lights on", "lights off"}


class VoiceSession:
    def __init__(
        self,
        websocket: WebSocket,
        user: Dict[str, Any],
        settings: Settings,
        speech: SpeechService,
        agent: JarvisAgent,
        connections: VoiceConnectionHub,
    ) -> None:
        self.websocket = websocket
        self.user = user
        self.settings = settings
        self.speech = speech
        self.agent = agent
        self.connections = connections
        self.conversation_id: Optional[str] = None
        self.device_id: Optional[str] = None
        self.device_room = ""
        self.scripted_speech_supported = False
        self.sample_rate = 16000
        self.personality_level = 2
        self.audio = bytearray()
        self.turn_task: Optional[asyncio.Task] = None
        self.cancel_event = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._device_actions: Dict[str, asyncio.Future] = {}
        self._last_response_text = ""
        self._announcement_lock = asyncio.Lock()

    async def run(self) -> None:
        await self._send(
            "session.ready",
            {
                "protocol": 1,
                "input": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
                "output": {"encoding": "pcm_s16le", "channels": 1},
                "vad": "client",
            },
        )
        try:
            while True:
                message = await self.websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    await self._audio_chunk(message["bytes"])
                    continue
                text = message.get("text")
                if text is None:
                    continue
                await self._command(text)
        except WebSocketDisconnect:
            pass
        finally:
            await self._interrupt()
            await self.connections.unregister(self)
            await self._set_device_connected(False)

    async def _audio_chunk(self, chunk: bytes) -> None:
        if len(self.audio) + len(chunk) > self.settings.voice_audio_limit_bytes:
            self.audio.clear()
            await self._send("error", {"code": "audio_too_large"})
            await self._send("session.ended", {"conversation_id": self.conversation_id})
            return
        self.audio.extend(chunk)

    async def _command(self, raw: str) -> None:
        import json

        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            await self._send("error", {"code": "invalid_json"})
            return
        kind = event.get("type")
        if kind == "session.configure":
            if "capabilities" in event:
                self.scripted_speech_supported = "scripted_speech_v1" in (
                    event.get("capabilities") or []
                )
            audio = event.get("audio") or {}
            if audio.get("encoding", "pcm_s16le") != "pcm_s16le":
                await self._send("error", {"code": "unsupported_audio_encoding"})
                return
            if int(audio.get("channels", 1)) != 1:
                await self._send("error", {"code": "unsupported_channel_count"})
                return
            sample_rate = int(audio.get("sample_rate", 16000))
            if sample_rate < 8000 or sample_rate > 48000:
                await self._send("error", {"code": "unsupported_sample_rate"})
                return
            self.sample_rate = sample_rate
            if "personality_level" in event:
                try:
                    personality_level = int(event["personality_level"])
                except (TypeError, ValueError):
                    await self._send("error", {"code": "invalid_personality_level"})
                    return
                if personality_level not in {1, 2, 3}:
                    await self._send("error", {"code": "invalid_personality_level"})
                    return
                self.personality_level = personality_level
            if "conversation_id" in event:
                conversation_id = event["conversation_id"]
                if conversation_id is not None and not isinstance(conversation_id, str):
                    await self._send("error", {"code": "invalid_conversation_id"})
                    return
                self.conversation_id = conversation_id or None
                if self.conversation_id is None:
                    self._last_response_text = ""
            device_id = event.get("device_id")
            if device_id is not None:
                if not isinstance(device_id, str) or not device_id.strip():
                    await self._send("error", {"code": "invalid_device_id"})
                    return
                self.device_id = device_id.strip()[:200]
                device_name = str(event.get("device_name") or self.device_id).strip()[:200]
                room = str(event.get("room") or "").strip()[:200]
                self.device_room = room
                await self._set_device_connected(True, device_name, room)
                await self.connections.unregister(self)
                await self.connections.register(self)
            await self._send(
                "session.configured",
                {
                    "conversation_id": self.conversation_id,
                    "device_id": self.device_id,
                    "personality_level": self.personality_level,
                },
            )
        elif kind == "turn.end":
            if self.turn_task and not self.turn_task.done():
                await self._send("error", {"code": "turn_in_progress"})
                return
            pcm = bytes(self.audio)
            self.audio.clear()
            self.cancel_event = asyncio.Event()
            self.turn_task = asyncio.create_task(self._process_turn(pcm))
        elif kind == "response.cancel":
            await self._interrupt()
            await self._send("response.cancelled", {})
        elif kind == "device.action.result":
            request_id = str(event.get("request_id") or "")
            future = self._device_actions.get(request_id)
            if future is not None and not future.done():
                if event.get("error") is not None:
                    future.set_exception(RuntimeError(str(event["error"])))
                else:
                    future.set_result(event.get("result"))
        elif kind == "ping":
            await self._send("pong", {})
        else:
            await self._send("error", {"code": "unknown_event", "event": kind})

    async def announce(self, text: str, *, camera_device_id: Optional[str] = None) -> None:
        """Interrupt any active turn and send one bounded unsolicited audio message."""
        async with self._announcement_lock:
            await self._interrupt()
            self.audio.clear()
            pcm, sample_rate = await self.speech.synthesize_pcm16(text)
            data = {
                "text": text,
                "encoding": "pcm_s16le",
                "sample_rate": sample_rate,
                "channels": 1,
            }
            if camera_device_id is not None:
                data["camera_device_id"] = camera_device_id
            async with self._send_lock:
                await self.websocket.send_json(
                    {
                        "type": "announcement.started",
                        "data": data,
                    }
                )
                for offset in range(0, len(pcm), 32 * 1024):
                    await self.websocket.send_bytes(pcm[offset : offset + 32 * 1024])
                await self.websocket.send_json({"type": "announcement.done", "data": {}})

    async def _set_device_connected(
        self, connected: bool, device_name: str = "", room: str = ""
    ) -> None:
        if not self.device_id:
            return
        existing = await self.agent.store.get_entity("device", self.device_id, self.user["id"])
        data: Dict[str, Any] = {
            "metadata": {"connected": connected, "last_seen_at": utc_now_iso()},
        }
        if existing is None:
            data.update(
                {
                    "name": device_name or self.device_id,
                    "kind": "voice",
                    "room": room,
                    "base_url": None,
                }
            )
        else:
            if device_name:
                data["name"] = device_name
            if room:
                data["room"] = room
        saved = await self.agent.store.save_device(
            self.user["id"], data, device_id=self.device_id, create=True, reported=True
        )
        if saved is not None:
            self.device_room = str(saved.get("room") or "")

    async def _interrupt(self) -> None:
        self.cancel_event.set()
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.turn_task
        self.turn_task = None
        self.audio.clear()
        for future in self._device_actions.values():
            if not future.done():
                future.cancel()
        self._device_actions.clear()

    async def _invoke_device_action(
        self, action: str, arguments: Dict[str, Any], *, timeout: float = 30.0
    ) -> Any:
        if not self.device_id:
            raise RuntimeError("voice device did not identify itself")
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._device_actions[request_id] = future
        await self._send(
            "device.action",
            {
                "request_id": request_id,
                "action": action,
                "arguments": arguments,
            },
        )
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except asyncio.CancelledError:
            if future.cancelled():
                raise RuntimeError("voice action interrupted") from None
            raise
        finally:
            self._device_actions.pop(request_id, None)

    async def _process_turn(self, pcm: bytes) -> None:
        try:
            await self._process_turn_inner(pcm)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._terminal_failure(exc)

    async def _terminal_failure(self, exc: Exception) -> None:
        message = "I couldn't process that request. The session is ending."
        await self._send("response.started", {})
        await self._send("response.text.delta", {"text": message})
        try:
            pcm, sample_rate = await self.speech.synthesize_pcm16(message)
            async with self._send_lock:
                await self.websocket.send_json(
                    {
                        "type": "response.audio.started",
                        "data": {
                            "encoding": "pcm_s16le",
                            "sample_rate": sample_rate,
                            "channels": 1,
                        },
                    }
                )
                await self.websocket.send_bytes(pcm)
                await self.websocket.send_json({"type": "response.audio.done", "data": {}})
        except Exception:
            pass
        await self._send("error", {"code": "turn_failed", "detail": str(exc)[:500]})
        await self._send("session.ended", {"conversation_id": self.conversation_id})

    async def _process_turn_inner(self, pcm: bytes) -> None:
        if not pcm:
            await self._send("error", {"code": "empty_turn"})
            await self._send("session.ended", {"conversation_id": self.conversation_id})
            return
        await self._send("transcription.started", {})
        transcript = await self.speech.transcribe_pcm16(pcm, self.sample_rate)
        if self.cancel_event.is_set():
            return
        await self._send(
            "transcription.final",
            {
                "text": transcript.text,
                "language": transcript.language,
                "duration_seconds": transcript.duration_seconds,
            },
        )
        if not transcript.text:
            await self._send("session.ended", {"conversation_id": self.conversation_id})
            return
        if _looks_like_playback_echo(transcript.text, self._last_response_text):
            await self._send(
                "session.ended",
                {"conversation_id": self.conversation_id, "reason": "playback_echo"},
            )
            return

        # Exact "lights on/off" may be claimed by the voice device. Give it a short
        # window to cancel before we spend a full agent turn.
        if _exact_local_light_phrase(transcript.text):
            try:
                await asyncio.wait_for(self.cancel_event.wait(), timeout=0.4)
            except asyncio.TimeoutError:
                pass
            if self.cancel_event.is_set():
                return

        tts = StreamingSpeech(self.websocket, self.speech, self._send_lock, self.cancel_event)

        async def emit(event: str, data: Dict[str, Any]) -> None:
            if event == "response.text.delta":
                await tts.add_text(str(data.get("text", "")))
            if event != "response.reasoning.delta":
                await self._send(event, data)

        await self._send("response.started", {})
        result = await self.agent.run(
            self.user["id"],
            transcript.text,
            conversation_id=self.conversation_id,
            emit=emit,
            cancel_event=self.cancel_event,
            device_id=self.device_id,
            device_room=self.device_room,
            device_action=self._invoke_device_action,
            voice_session=True,
            personality_level=self.personality_level,
        )
        self.conversation_id = result.conversation_id
        self._last_response_text = result.text
        await tts.finish()
        if result.session_ended:
            await self._send("session.ended", {"conversation_id": self.conversation_id})
            return
        if not self.cancel_event.is_set():
            await self._send("turn.done", {"conversation_id": self.conversation_id})

    async def _send(self, event: str, data: Dict[str, Any]) -> None:
        async with self._send_lock:
            await self.websocket.send_json({"type": event, "data": data})


class StreamingSpeech:
    """Sentence-level Kokoro synthesis overlaps with the remaining LLM stream."""

    def __init__(
        self,
        websocket: WebSocket,
        speech: SpeechService,
        send_lock: asyncio.Lock,
        cancel_event: asyncio.Event,
    ) -> None:
        self.websocket = websocket
        self.speech = speech
        self.send_lock = send_lock
        self.cancel_event = cancel_event
        self.buffer = ""
        self.queue: asyncio.Queue = asyncio.Queue()
        self.worker = asyncio.create_task(self._work())
        self.started = False

    async def add_text(self, text: str) -> None:
        self.buffer += text
        parts = SENTENCE_END.split(self.buffer)
        self.buffer = parts.pop() if parts else ""
        for part in parts:
            if part.strip():
                await self.queue.put(part.strip())
        if len(self.buffer) > 240:
            split = self.buffer.rfind(" ", 0, 220)
            if split > 0:
                await self.queue.put(self.buffer[:split].strip())
                self.buffer = self.buffer[split:].lstrip()

    async def finish(self) -> None:
        if self.buffer.strip():
            await self.queue.put(self.buffer.strip())
        await self.queue.put(None)
        await self.worker

    async def _work(self) -> None:
        while True:
            sentence = await self.queue.get()
            if sentence is None or self.cancel_event.is_set():
                break
            pcm, sample_rate = await self.speech.synthesize_pcm16(sentence)
            if self.cancel_event.is_set():
                break
            async with self.send_lock:
                if not self.started:
                    await self.websocket.send_json(
                        {
                            "type": "response.audio.started",
                            "data": {
                                "encoding": "pcm_s16le",
                                "sample_rate": sample_rate,
                                "channels": 1,
                            },
                        }
                    )
                    self.started = True
                for offset in range(0, len(pcm), 32 * 1024):
                    await self.websocket.send_bytes(pcm[offset : offset + 32 * 1024])
        if self.started and not self.cancel_event.is_set():
            async with self.send_lock:
                await self.websocket.send_json({"type": "response.audio.done", "data": {}})


async def voice_websocket(websocket: WebSocket) -> None:
    try:
        user = await websocket_user(websocket)
    except HTTPException:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    session = VoiceSession(
        websocket,
        user,
        websocket.app.state.settings,
        websocket.app.state.speech,
        websocket.app.state.agent,
        websocket.app.state.voice_connections,
    )
    await session.run()
