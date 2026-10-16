from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional

from conftest import FakeLlm, FakeSpeech
from fastapi.testclient import TestClient

from jarvis_api.app import create_app
from jarvis_api.inference import LlmDelta, LlmTurn, ToolCall
from jarvis_api.speech import Transcript
from jarvis_api.voice import (
    VoiceConnectionHub,
    _exact_local_light_phrase,
    _looks_like_playback_echo,
)


class LightsOnSpeech(FakeSpeech):
    async def transcribe_pcm16(
        self, pcm: bytes, sample_rate: int = 16000, language: str = "en"
    ) -> Transcript:
        return Transcript("lights on", "en", len(pcm) / float(sample_rate * 2))


def test_exact_local_light_phrase_detection():
    assert _exact_local_light_phrase("lights on")
    assert _exact_local_light_phrase("Lights off.")
    assert not _exact_local_light_phrase("turn the lights on")


def test_device_cancel_after_lights_transcript_skips_llm(settings):
    llm = FakeLlm("should not run")
    app = create_app(settings, llm=llm, speech_service=LightsOnSpeech())
    with TestClient(app) as client:
        token = client.post(
            "/v1/auth/token",
            json={"username": "owner", "password": "correct horse battery staple"},
        ).json()["access_token"]
        with client.websocket_connect(f"/v1/voice?token={token}") as websocket:
            websocket.receive_json()
            websocket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "voice-three",
                    "room": "office",
                    "personality_level": 2,
                }
            )
            websocket.receive_json()
            websocket.send_bytes(b"\x00\x00" * 1600)
            websocket.send_json({"type": "turn.end"})

            events = []
            while True:
                message = websocket.receive()
                if message.get("bytes") is not None:
                    continue
                payload = json.loads(message["text"])
                events.append(payload["type"])
                if payload["type"] == "transcription.final":
                    assert payload["data"]["text"] == "lights on"
                    websocket.send_json({"type": "response.cancel"})
                if payload["type"] in {"response.cancelled", "session.ended", "turn.done"}:
                    break

            assert "transcription.final" in events
            assert "response.started" not in events
            assert "response.text.delta" not in events
            assert llm.requests == []


class DeviceActionLlm:
    def __init__(self) -> None:
        self.calls = 0

    async def ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None

    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        cancel_event: Optional[Any] = None,
        *,
        tool_choice: Any = "auto",
        temperature: float = 0.6,
    ) -> AsyncIterator[LlmDelta]:
        self.calls += 1
        if self.calls == 1:
            yield LlmDelta(
                kind="done",
                turn=LlmTurn(
                    tool_calls=[
                        ToolCall(
                            id="device-call",
                            name="navigate_device_ui",
                            arguments_json='{"destination":"spotify"}',
                        )
                    ]
                ),
            )
            return
        text = "There. Try not to get lost again."
        yield LlmDelta(kind="text", text=text)
        yield LlmDelta(kind="done", turn=LlmTurn(content=text))


class EndSessionLlm(DeviceActionLlm):
    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        cancel_event: Optional[Any] = None,
        *,
        tool_choice: Any = "auto",
        temperature: float = 0.6,
    ) -> AsyncIterator[LlmDelta]:
        yield LlmDelta(
            kind="done",
            turn=LlmTurn(
                tool_calls=[
                    ToolCall(
                        id="end-call",
                        name="end_voice_session",
                        arguments_json="{}",
                    )
                ]
            ),
        )


class SpokenSentinelLlm(DeviceActionLlm):
    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        cancel_event: Optional[Any] = None,
        *,
        tool_choice: Any = "auto",
        temperature: float = 0.6,
    ) -> AsyncIterator[LlmDelta]:
        self.calls += 1
        text = "End voice session."
        yield LlmDelta(kind="text", text=text)
        yield LlmDelta(kind="done", turn=LlmTurn(content=text))


def test_playback_echo_is_recognized_without_matching_short_replies():
    response = "You asked a spectacularly stupid question, but the answer is four."
    assert _looks_like_playback_echo(
        "a spectacularly stupid question but the answer is four", response
    )
    assert not _looks_like_playback_echo("No, that is wrong", response)


async def test_voice_connection_hub_targets_only_selected_connected_devices():
    class Session:
        def __init__(self, device_id):
            self.user = {"id": "owner"}
            self.device_id = device_id
            self.messages = []

        async def announce(self, text):
            self.messages.append(text)

    hub = VoiceConnectionHub()
    office = Session("office")
    playroom = Session("playroom")
    await hub.register(office)
    await hub.register(playroom)

    sent = await hub.announce("owner", {"office"}, "Someone is at the door.")

    assert sent == ["office"]
    assert office.messages == ["Someone is at the door."]
    assert playroom.messages == []


def test_persistent_voice_websocket_turn(settings):
    llm = FakeLlm("Hello there.")
    app = create_app(
        settings,
        llm=llm,
        speech_service=FakeSpeech(),
    )
    with TestClient(app) as client:
        token = client.post(
            "/v1/auth/token",
            json={"username": "owner", "password": "correct horse battery staple"},
        ).json()["access_token"]
        with client.websocket_connect(f"/v1/voice?token={token}") as websocket:
            assert websocket.receive_json()["type"] == "session.ready"
            websocket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "voice-three",
                    "device_name": "Office Jarvis",
                    "room": "office",
                    "conversation_id": "temporary-conversation",
                    "personality_level": 3,
                    "audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
                }
            )
            configured = websocket.receive_json()
            assert configured == {
                "type": "session.configured",
                "data": {
                    "conversation_id": "temporary-conversation",
                    "device_id": "voice-three",
                    "personality_level": 3,
                },
            }
            devices = client.get("/v1/devices", headers={"Authorization": f"Bearer {token}"}).json()
            assert devices[0]["id"] == "voice-three"
            assert devices[0]["name"] == "Office Jarvis"
            assert devices[0]["room"] == "office"
            assert devices[0]["metadata"]["connected"] is True
            websocket.send_json(
                {
                    "type": "session.configure",
                    "conversation_id": None,
                }
            )
            reset = websocket.receive_json()
            assert reset["type"] == "session.configured"
            assert reset["data"] == {
                "conversation_id": None,
                "device_id": "voice-three",
                "personality_level": 3,
            }
            websocket.send_bytes(b"\x00\x00" * 1600)
            websocket.send_json({"type": "turn.end"})

            event_types = []
            audio_chunks = 0
            for _ in range(30):
                event = websocket.receive()
                if event.get("bytes") is not None:
                    audio_chunks += 1
                    continue
                payload = json.loads(event["text"])
                event_types.append(payload["type"])
                if payload["type"] == "turn.done":
                    break

            assert "transcription.final" in event_types
            assert "response.text.delta" in event_types
            assert "response.audio.started" in event_types
            assert "response.audio.done" in event_types
            assert event_types[-1] == "turn.done"
            assert audio_chunks > 0

            websocket.send_json({"type": "ping"})
            assert websocket.receive_json()["type"] == "pong"
    system_prompt = llm.requests[0][0]["content"]
    assert "Personality level 3" in system_prompt
    assert "openly mean" in system_prompt
    assert "Never ask whether the user needs\nanything else" in system_prompt
    assert 'never reply with the phrase "end voice session"' in system_prompt
    assert "plain speech" in system_prompt.casefold()
    assert "markdown" in system_prompt.casefold()


def _voice_client(settings, llm):
    app = create_app(settings, llm=llm, speech_service=FakeSpeech())
    client = TestClient(app)
    client.__enter__()
    token = client.post(
        "/v1/auth/token",
        json={"username": "owner", "password": "correct horse battery staple"},
    ).json()["access_token"]
    return client, token


def test_device_action_round_trip_over_voice_socket(settings):
    llm = DeviceActionLlm()
    client, token = _voice_client(settings, llm)
    try:
        with client.websocket_connect(f"/v1/voice?token={token}") as websocket:
            websocket.receive_json()
            websocket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "voice-three",
                    "personality_level": 3,
                }
            )
            websocket.receive_json()
            websocket.send_bytes(b"\x00\x00" * 1600)
            websocket.send_json({"type": "turn.end"})

            events = []
            while True:
                message = websocket.receive()
                if message.get("bytes") is not None:
                    continue
                payload = json.loads(message["text"])
                events.append(payload["type"])
                if payload["type"] == "device.action":
                    assert payload["data"]["action"] == "navigate_device_ui"
                    assert payload["data"]["arguments"] == {"destination": "spotify"}
                    websocket.send_json(
                        {
                            "type": "device.action.result",
                            "request_id": payload["data"]["request_id"],
                            "result": {"ok": True, "destination": "spotify"},
                        }
                    )
                if payload["type"] == "session.ended":
                    break
            assert "tool.finished" in events
            assert "turn.done" not in events
            assert llm.calls == 1
    finally:
        client.__exit__(None, None, None)


def test_spoken_end_session_sentinel_is_never_synthesized(settings):
    llm = SpokenSentinelLlm()
    client, token = _voice_client(settings, llm)
    try:
        with client.websocket_connect(f"/v1/voice?token={token}") as websocket:
            websocket.receive_json()
            websocket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "voice-three",
                    "personality_level": 2,
                }
            )
            websocket.receive_json()
            websocket.send_bytes(b"\x00\x00" * 1600)
            websocket.send_json({"type": "turn.end"})

            events = []
            while True:
                message = websocket.receive()
                assert message.get("bytes") is None
                payload = json.loads(message["text"])
                events.append(payload["type"])
                if payload["type"] == "session.ended":
                    break
            assert "response.text.delta" not in events
            assert "response.audio.started" not in events
            assert "turn.done" not in events
    finally:
        client.__exit__(None, None, None)


def test_end_voice_session_stops_without_a_followup_turn(settings):
    client, token = _voice_client(settings, EndSessionLlm())
    try:
        with client.websocket_connect(f"/v1/voice?token={token}") as websocket:
            websocket.receive_json()
            websocket.send_json(
                {
                    "type": "session.configure",
                    "device_id": "voice-three",
                    "personality_level": 1,
                }
            )
            websocket.receive_json()
            websocket.send_bytes(b"\x00\x00" * 1600)
            websocket.send_json({"type": "turn.end"})

            events = []
            while True:
                message = websocket.receive()
                assert message.get("bytes") is None
                payload = json.loads(message["text"])
                events.append(payload["type"])
                if payload["type"] == "session.ended":
                    break
            assert "tool.finished" in events
            assert "turn.done" not in events
            assert "response.audio.started" not in events
    finally:
        client.__exit__(None, None, None)
