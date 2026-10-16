from __future__ import annotations

import asyncio
import base64
import json
from types import SimpleNamespace

import pytest
from conftest import FakeLlm, FakeSpeech
from test_api import authenticated_client
from test_chat_stream import read_events

from jarvis_api.api.wear import wearable_chat
from jarvis_api.domain import WearChatRequest
from jarvis_api.inference import LlmDelta, LlmTurn, ToolCall
from jarvis_api.speech import SpeechUnavailable


def test_wear_stream_returns_text_conversation_and_audio(settings):
    with authenticated_client(settings) as client:
        response = client.post(
            "/v1/wear/chat", json={"message": "Hello"}, headers={"Accept": "text/event-stream"}
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
        events = read_events(response)
        assert [name for name, _ in events] == [
            "response.text.delta",
            "response.text.delta",
            "response.completed",
            "response.audio",
            "turn.done",
        ]
        completed = events[2][1]
        assert "".join(data["text"] for event, data in events[:2]) == completed["response"]
        assert completed["response"] == "Hello from Jarvis."
        audio = events[3][1]
        assert base64.b64decode(audio["audio_base64"]) == b"\x01\x00" * 100
        assert audio["audio_encoding"] == "pcm_s16le"
        assert audio["sample_rate"] == 24000
        saved = client.get("/v1/conversations/" + completed["conversation_id"]).json()
        assert saved["messages"][-1]["content"] == completed["response"]


@pytest.mark.asyncio
async def test_wear_sends_text_while_model_and_speech_are_still_running():
    text_sent = asyncio.Event()
    completed_sent = asyncio.Event()

    class SlowAgent:
        async def run(self, *args, emit, **kwargs):
            await emit("response.text.delta", {"text": "Hello"})
            # The client must see this token before the model finishes its turn.
            await asyncio.wait_for(text_sent.wait(), 1)
            return SimpleNamespace(conversation_id="conversation-1", text="Hello")

    class SlowSpeech(FakeSpeech):
        async def synthesize_pcm16(self, text):
            # The final text must reach the client while synthesis is pending.
            await asyncio.wait_for(completed_sent.wait(), 1)
            return await super().synthesize_pcm16(text)

    response = await wearable_chat(
        WearChatRequest(message="Hello"),
        SimpleNamespace(
            headers={"accept": "text/event-stream"},
            app=SimpleNamespace(state=SimpleNamespace(agent=SlowAgent(), speech=SlowSpeech())),
        ),
        {"id": "owner"},
    )
    sent = []

    async def receive():
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message.get("body", b""))
        if b"event: response.text.delta" in message.get("body", b""):
            text_sent.set()
        if b"event: response.completed" in message.get("body", b""):
            completed_sent.set()

    await asyncio.wait_for(response({"type": "http"}, receive, send), 2)
    assert text_sent.is_set()
    assert completed_sent.is_set()
    assert b"event: response.audio" in b"".join(sent)
    assert b"event: error" not in b"".join(sent)


def test_wear_stream_keeps_completed_text_when_speech_fails(settings):
    class FailedSpeech(FakeSpeech):
        async def synthesize_pcm16(self, text):
            raise SpeechUnavailable("Speech service unavailable")

    with authenticated_client(settings) as client:
        client.app.state.speech = FailedSpeech()
        response = client.post(
            "/v1/wear/chat", json={"message": "Hello"}, headers={"Accept": "text/event-stream"}
        )
        events = read_events(response)
        completed = next(data for name, data in events if name == "response.completed")
        assert completed["response"] == "Hello from Jarvis."
        assert events[-2:] == [
            ("error", {"message": "Speech service unavailable"}),
            ("turn.done", {}),
        ]
        assert not any(name == "response.audio" for name, _ in events)


def test_wear_stream_reports_agent_failure_without_audio(settings):
    class FailedLlm(FakeLlm):
        async def stream_chat(self, *args, **kwargs):
            raise RuntimeError("Model unavailable")
            yield  # pragma: no cover

    with authenticated_client(settings) as client:
        client.app.state.agent.llm = FailedLlm()
        response = client.post(
            "/v1/wear/chat", json={"message": "Hello"}, headers={"Accept": "text/event-stream"}
        )
        assert read_events(response) == [
            ("error", {"message": "Model unavailable"}),
            ("turn.done", {}),
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["model", "speech"])
async def test_wear_disconnect_closes_inflight_upstream_work(phase):
    disconnected = asyncio.Event()
    upstream_closed = asyncio.Event()
    synthesizing = asyncio.Event()

    class ResourceAgent:
        async def run(self, *args, emit, **kwargs):
            if phase == "speech":
                return SimpleNamespace(conversation_id="conversation-1", text="Hello")
            try:
                await emit("response.text.delta", {"text": "Partial answer"})
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.01)
                upstream_closed.set()

    class ResourceSpeech(FakeSpeech):
        async def synthesize_pcm16(self, text):
            synthesizing.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0.01)
                upstream_closed.set()

    response = await wearable_chat(
        WearChatRequest(message="Hello"),
        SimpleNamespace(
            headers={"accept": "text/event-stream"},
            app=SimpleNamespace(
                state=SimpleNamespace(agent=ResourceAgent(), speech=ResourceSpeech())
            ),
        ),
        {"id": "owner"},
    )

    async def receive():
        await disconnected.wait()
        if phase == "speech":
            await synthesizing.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if b"event: response." in message.get("body", b""):
            disconnected.set()

    await asyncio.wait_for(response({"type": "http"}, receive, send), 2)
    assert upstream_closed.is_set()


@pytest.mark.parametrize("accept", ["application/json", "text/event-stream"])
@pytest.mark.parametrize("target", ["lights", "television"])
def test_wear_requests_execute_light_and_tv_tools(settings, home_assistant, accept, target):
    class ControlLlm(FakeLlm):
        async def stream_chat(self, messages, tools, *args, **kwargs):
            names = {tool["function"]["name"] for tool in tools}
            if messages[-1]["role"] == "user":
                if target == "lights":
                    name = "control_lights"
                    arguments = {"scope": "room", "selector": "Kitchen", "action": "turn_off"}
                else:
                    name, arguments = "list_smart_devices", {}
            elif messages[-1].get("name") == "list_smart_devices":
                devices = json.loads(messages[-1]["content"])
                television = next(device for device in devices if device["name"] == "Demo TV")
                name = "control_smart_device"
                arguments = {"device_id": television["id"], "action": "turn_off"}
            else:
                async for delta in super().stream_chat(messages, tools, *args, **kwargs):
                    yield delta
                return
            assert name in names, "Wear must receive the required smart-home tool schema"
            yield LlmDelta(
                kind="done", turn=LlmTurn(tool_calls=[ToolCall(name, name, json.dumps(arguments))])
            )

    with authenticated_client(settings) as client:
        client.app.state.smart_home.client = home_assistant
        assert client.post("/v1/smart-home/sync").status_code == 200
        client.app.state.agent.llm = ControlLlm()
        message = (
            "Turn off the Kitchen lights." if target == "lights" else "Turn off the office TV."
        )
        response = client.post(
            "/v1/wear/chat", json={"message": message}, headers={"Accept": accept}
        )
        assert response.status_code == 200, response.text
        if accept == "text/event-stream":
            events = read_events(response)
            completed = next(data for name, data in events if name == "response.completed")
        else:
            completed = response.json()
        saved = client.get("/v1/conversations/" + completed["conversation_id"]).json()
        results = saved["messages"][-1]["metadata"]["tool_calls"]
        expected_tool = "control_lights" if target == "lights" else "control_smart_device"
        assert results[-1]["name"] == expected_tool
        assert results[-1]["status"] == "completed"
        expected_entity = (
            "light.kitchen_table_1" if target == "lights" else "media_player.demo_tv"
        )
        expected_domain = "light" if target == "lights" else "media_player"
        assert home_assistant.calls == [
            (expected_domain, "turn_off", {"entity_id": expected_entity})
        ]
