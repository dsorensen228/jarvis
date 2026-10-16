from __future__ import annotations

import asyncio
import json

from websockets.asyncio.server import serve

from jarvis_voice.protocol import VoiceProtocolClient


class FakeApi:
    def __init__(self, url: str) -> None:
        self.voice_websocket_url = url

    async def access_token(self, *, force: bool = False) -> str:
        return "test-token"


async def test_voice_protocol_configures_once_and_streams_both_directions():
    received: list[str | bytes] = []
    configured = asyncio.Event()
    turn_done = asyncio.Event()
    events: list[tuple[str, dict]] = []
    audio: list[bytes] = []
    connection_states: list[bool] = []

    async def handler(websocket):
        first = await websocket.recv()
        payload = json.loads(first)
        assert payload["type"] == "session.configure"
        assert payload["device_id"] == "voice-one"
        assert payload["device_name"] == "voice-one"
        assert payload["room"] == "kitchen"
        assert payload["conversation_id"] is None
        assert payload["personality_level"] == 3
        await websocket.send(
            json.dumps(
                {
                    "type": "session.configured",
                    "data": {"conversation_id": None, "device_id": "voice-one"},
                }
            )
        )
        configured.set()
        while True:
            message = await websocket.recv()
            received.append(message)
            if isinstance(message, str) and json.loads(message)["type"] == "turn.end":
                await websocket.send(b"tts-pcm")
                await websocket.send(
                    json.dumps({"type": "turn.done", "data": {"conversation_id": "conv-1"}})
                )
                return

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]

        async def on_event(event, data):
            events.append((event, data))
            if event == "turn.done":
                turn_done.set()

        async def on_audio(pcm):
            audio.append(pcm)

        async def on_connection(connected):
            connection_states.append(connected)

        client = VoiceProtocolClient(
            FakeApi(f"ws://127.0.0.1:{port}"),
            "voice-one",
            "kitchen",
            16000,
            3,
            on_event,
            on_audio,
            on_connection,
        )
        client.start()
        await client.wait_connected()
        await asyncio.wait_for(configured.wait(), 2)
        await client.send_audio(b"mic-pcm")
        await client.end_turn()
        await asyncio.wait_for(turn_done.wait(), 2)
        assert received[0] == b"mic-pcm"
        assert json.loads(received[1])["type"] == "turn.end"
        assert audio == [b"tts-pcm"]
        assert client.conversation_id == "conv-1"
        await client.close()
        assert connection_states[0] is True
        assert connection_states[-1] is False
