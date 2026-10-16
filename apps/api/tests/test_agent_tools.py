from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, AsyncIterator, Dict, List, Optional

import pytest

from jarvis_api.agent import (
    MAX_HISTORY_CHARACTERS,
    MAX_HISTORY_MESSAGES,
    JarvisAgent,
    _recent_history,
)
from jarvis_api.capabilities import Capabilities
from jarvis_api.inference import LlmDelta, LlmTurn, ToolCall
from jarvis_api.store import SqliteStore
from jarvis_api.tools import ToolContext, ToolRegistry


class ToolCallingLlm:
    def __init__(self):
        self.calls = 0

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
                            id="call-1",
                            name="create_todo",
                            arguments_json='{"title":"Call Mom","category":"personal"}',
                        )
                    ]
                ),
            )
            return
        text = "I added Call Mom to your todos."
        yield LlmDelta(kind="text", text=text)
        yield LlmDelta(kind="done", turn=LlmTurn(content=text))


class FailingVoiceToolLlm:
    def __init__(self):
        self.calls = 0

    async def stream_chat(
        self,
        messages,
        tools,
        cancel_event=None,
        *,
        tool_choice="auto",
        temperature=0.6,
    ):
        self.calls += 1
        yield LlmDelta(
            kind="done",
            turn=LlmTurn(
                tool_calls=[
                    ToolCall(
                        id="bad-call",
                        name="missing_tool",
                        arguments_json="{}",
                    )
                ]
            ),
        )


class ProseOnlyActionLlm:
    def __init__(self):
        self.tool_choice = None
        self.tool_names = []

    async def stream_chat(
        self,
        messages,
        tools,
        cancel_event=None,
        *,
        tool_choice="auto",
        temperature=0.6,
    ):
        self.tool_choice = tool_choice
        self.tool_names = [tool["function"]["name"] for tool in tools]
        yield LlmDelta(kind="text", text="Room lights on.")
        yield LlmDelta(kind="done", turn=LlmTurn(content="Room lights on."))


class SpokenSentinelLlm:
    """Emits the end-session tool name as prose instead of calling the tool."""

    def __init__(self, text: str = "End voice session."):
        self.text = text
        self.calls = 0

    async def stream_chat(
        self,
        messages,
        tools,
        cancel_event=None,
        *,
        tool_choice="auto",
        temperature=0.6,
    ):
        self.calls += 1
        midpoint = max(1, len(self.text) // 2)
        for chunk in (self.text[:midpoint], self.text[midpoint:]):
            if chunk:
                yield LlmDelta(kind="text", text=chunk)
        yield LlmDelta(kind="done", turn=LlmTurn(content=self.text))


class WebSearchLlm:
    def __init__(self):
        self.calls = 0

    async def stream_chat(
        self,
        messages,
        tools,
        cancel_event=None,
        *,
        tool_choice="auto",
        temperature=0.6,
    ):
        self.calls += 1
        yield LlmDelta(
            kind="done",
            turn=LlmTurn(
                tool_calls=[
                    ToolCall(
                        id="web-call",
                        name="search_web",
                        arguments_json='{"query":"What happened today?"}',
                    )
                ]
            ),
        )


def test_recent_history_keeps_the_latest_whole_messages_within_budget():
    messages = [
        {"id": str(index), "content": "x" * 2_000} for index in range(MAX_HISTORY_MESSAGES + 4)
    ]

    result = _recent_history(messages)

    assert len(result) == MAX_HISTORY_CHARACTERS // 2_000
    assert [message["id"] for message in result] == [
        str(index) for index in range(len(messages) - len(result), len(messages))
    ]


def test_recent_history_always_keeps_an_oversized_latest_message():
    latest = {"id": "latest", "content": "x" * (MAX_HISTORY_CHARACTERS + 1)}

    assert _recent_history([{"id": "old", "content": "old"}, latest]) == [latest]


@pytest.mark.asyncio
async def test_agent_executes_tool_then_returns_final_answer(tmp_path):
    store = SqliteStore(str(tmp_path / "agent.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities)
        agent = JarvisAgent(store, ToolCallingLlm(), capabilities, registry)
        events = []

        async def emit(event, payload):
            events.append((event, payload))

        result = await agent.run("user-1", "Remind me to call Mom", emit=emit)
        assert result.text == "I added Call Mom to your todos."
        todos = await capabilities.list_todos("user-1")
        assert todos[0]["title"] == "Call Mom"
        finished = next(payload for event, payload in events if event == "tool.finished")
        assert finished["name"] == "create_todo"
        assert finished["result"]["title"] == "Call Mom"
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_voice_tool_failure_is_spoken_once_and_ends_session(tmp_path):
    store = SqliteStore(str(tmp_path / "failure.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities)
        llm = FailingVoiceToolLlm()
        agent = JarvisAgent(store, llm, capabilities, registry)
        events = []

        async def emit(event, payload):
            events.append((event, payload))

        result = await agent.run(
            "user-1",
            "Do the thing",
            emit=emit,
            voice_session=True,
        )
        assert result.session_ended is True
        assert result.text == "I couldn't complete that request: unknown tool."
        assert llm.calls == 1
        assert ("response.text.delta", {"text": result.text}) in events
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_action_prose_is_suppressed_when_required_tool_call_is_missing(tmp_path):
    store = SqliteStore(str(tmp_path / "prose-action.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        llm = ProseOnlyActionLlm()
        agent = JarvisAgent(store, llm, capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run(
            "user-1",
            "Turn the office lights on.",
            emit=emit,
            device_id="voice-three",
            device_room="Office",
            voice_session=True,
        )
        assert result.session_ended is True
        assert "failed to issue the required tool call" in result.text
        assert deltas == [result.text]
        assert llm.tool_choice == "required"
        assert llm.tool_names == ["room_lights_on"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_conversation_passes_only_web_search_and_the_exit_to_the_model(tmp_path):
    store = SqliteStore(str(tmp_path / "conversation.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        llm = ProseOnlyActionLlm()
        agent = JarvisAgent(store, llm, capabilities, registry)

        await agent.run(
            "user-1",
            "Tell me a joke.",
            voice_session=True,
        )

        assert sorted(llm.tool_names) == ["end_voice_session", "search_web"]
        assert llm.tool_choice == "auto"
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "spoken",
    [
        "End voice session.",
        "end_voice_session",
        "End the voice session",
        "  END VOICE SESSION!  ",
    ],
)
async def test_spoken_end_session_sentinel_ends_the_session_silently(tmp_path, spoken):
    store = SqliteStore(str(tmp_path / "sentinel.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        llm = SpokenSentinelLlm(spoken)
        agent = JarvisAgent(store, llm, capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run(
            "user-1",
            "Tell me a joke.",
            emit=emit,
            voice_session=True,
        )

        assert result.session_ended is True
        assert result.text == ""
        assert deltas == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_dismissal_ends_quietly_when_the_model_skips_the_required_tool(tmp_path):
    store = SqliteStore(str(tmp_path / "dismissal.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        llm = SpokenSentinelLlm("Very good.")
        agent = JarvisAgent(store, llm, capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run(
            "user-1",
            "That's all for now.",
            emit=emit,
            voice_session=True,
        )

        assert result.session_ended is True
        assert "failed to issue the required tool call" not in result.text
        assert deltas == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_reply_that_merely_starts_like_the_sentinel_is_still_spoken(tmp_path):
    store = SqliteStore(str(tmp_path / "sentinel-prefix.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        spoken = "End of the Roman Republic came in 27 BC."
        llm = SpokenSentinelLlm(spoken)
        agent = JarvisAgent(store, llm, capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run(
            "user-1",
            "When did the Roman Republic end?",
            emit=emit,
            voice_session=True,
        )

        assert result.session_ended is False
        assert result.text == spoken
        assert "".join(deltas) == spoken
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_sentinel_text_is_only_intercepted_in_a_voice_session(tmp_path):
    store = SqliteStore(str(tmp_path / "sentinel-text.sqlite3"))
    await store.start()
    try:
        capabilities = Capabilities(store)
        registry = ToolRegistry(capabilities, integrations=object())
        agent = JarvisAgent(store, SpokenSentinelLlm(), capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run("user-1", "Say something odd.", emit=emit)

        assert result.session_ended is False
        assert result.text == "End voice session."
        assert "".join(deltas) == "End voice session."
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_web_search_answer_bypasses_a_second_local_model_turn(tmp_path):
    store = SqliteStore(str(tmp_path / "web-search.sqlite3"))
    await store.start()

    class KnowledgeStub:
        async def search_web(self, query, limit):
            assert query == "What happened today?"
            assert limit == 5
            return {
                "answer": "This is the raw provider answer. It remains exactly as returned.",
                "results": [],
                "provider": "openai",
            }

    try:
        capabilities = Capabilities(store)
        integrations = SimpleNamespace(knowledge=KnowledgeStub())
        registry = ToolRegistry(capabilities, integrations=integrations)
        llm = WebSearchLlm()
        agent = JarvisAgent(store, llm, capabilities, registry)
        deltas = []

        async def emit(event, payload):
            if event == "response.text.delta":
                deltas.append(payload["text"])

        result = await agent.run(
            "user-1",
            "What happened today?",
            emit=emit,
            voice_session=True,
        )

        assert result.text == "This is the raw provider answer. It remains exactly as returned."
        assert deltas == [result.text]
        assert result.session_ended is False
        assert llm.calls == 1
    finally:
        await store.close()


def test_voice_tool_surface_keeps_legacy_device_capabilities():
    class CapabilitiesStub:
        pass

    registry = ToolRegistry(CapabilitiesStub(), integrations=object())
    names = {schema["function"]["name"] for schema in registry.schemas()}
    assert {
        "end_voice_session",
        "control_lights",
        "room_lights_off",
        "room_lights_on",
        "navigate_device_ui",
        "spotify_play_best_match",
        "spotify_search",
        "spotify_start_playback",
        "spotify_resume_playback",
        "spotify_pause",
        "spotify_skip_next",
        "spotify_skip_previous",
        "set_system_volume",
        "control_device_clock",
        "show_wikipedia",
        "open_patreon",
        "close_browser",
        "put_on_title",
        "schedule_tool_call",
        "list_scheduled_tool_calls",
        "cancel_scheduled_tool_calls",
        "describe_scene",
    } <= names
    assert not any("code" in name and "task" in name for name in names)


@pytest.mark.asyncio
async def test_room_light_tools_use_calling_device_id_and_compact_discovery():
    class CapabilitiesStub:
        pass

    class SmartHomeStub:
        def __init__(self):
            self.calls = []

        async def control_room_lights_for_device(self, user_id, device_id, action):
            self.calls.append((user_id, device_id, action))
            return {"action": action, "succeeded": 2, "failed": 0}

        async def list_devices(self, user_id):
            assert user_id == "owner"
            return [
                {
                    "id": "light-1",
                    "name": "Office 1",
                    "source_name": "Office 1",
                    "room": "Office",
                    "capabilities": ["power", "brightness"],
                    "available": True,
                    "components": [
                        {"key": "main", "name": "", "entity_id": "light.office_1"},
                    ],
                    "external_id": "secret-vendor-id",
                    "entity_id": "light.office_1",
                }
            ]

    class IntegrationsStub:
        def __init__(self):
            self.smart_home = SmartHomeStub()

    integrations = IntegrationsStub()
    registry = ToolRegistry(CapabilitiesStub(), integrations=integrations)
    context = ToolContext(
        "owner",
        "conversation-1",
        device_id="voice-three",
        device_room="untrusted-client-room",
        voice_session=True,
    )
    try:
        off = json.loads(await registry.execute("room_lights_off", context, "{}"))
        on = json.loads(await registry.execute("room_lights_on", context, "{}"))
        devices = json.loads(await registry.execute("list_smart_devices", context, "{}"))
    finally:
        await registry.close()

    assert off["action"] == "turn_off"
    assert on["action"] == "turn_on"
    assert integrations.smart_home.calls == [
        ("owner", "voice-three", "turn_off"),
        ("owner", "voice-three", "turn_on"),
    ]
    # Discovery stays compact: neutral capabilities are useful to the model, but
    # the vendor id and the raw entity plumbing are not.
    assert devices == [
        {
            "id": "light-1",
            "name": "Office 1",
            "source_name": "Office 1",
            "room": "Office",
            "capabilities": ["power", "brightness"],
        }
    ]


@pytest.mark.asyncio
async def test_describe_scene_uses_local_vision_for_image_asset(tmp_path):
    store = SqliteStore(str(tmp_path / "vision.sqlite3"))
    await store.start()

    class FakeVision:
        def __init__(self):
            self.settings = SimpleNamespace(asset_dir=tmp_path / "assets")
            self.calls = []

        async def describe(self, image, media_type, prompt):
            self.calls.append((image, media_type, prompt))
            return "A workbench with a brass lamp."

    vision = FakeVision()
    try:
        image_path = vision.settings.asset_dir / "user-1" / "photo.jpg"
        image_path.parent.mkdir(parents=True)
        image_path.write_bytes(b"fake-jpeg")
        await store.create_entity(
            "asset",
            "user-1",
            {
                "kind": "file",
                "title": "Workshop",
                "path": "user-1/photo.jpg",
                "mime_type": "image/jpeg",
            },
            entity_id="photo",
        )
        registry = ToolRegistry(Capabilities(store), vision=vision)
        result = json.loads(
            await registry.execute(
                "describe_scene",
                ToolContext("user-1", "conversation-1"),
                '{"image_asset_id":"photo","user_question":"What is on the bench?"}',
            )
        )
        assert result["description"] == "A workbench with a brass lamp."
        assert vision.calls[0][0] == b"fake-jpeg"
        assert "What is on the bench?" in vision.calls[0][2]
        await registry.close()
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_describe_scene_authenticates_live_camera_callback(tmp_path, monkeypatch):
    store = SqliteStore(str(tmp_path / "camera-vision.sqlite3"))
    await store.start()

    class FakeVision:
        def __init__(self):
            self.settings = SimpleNamespace(asset_dir=tmp_path / "assets")

        async def describe(self, image, media_type, prompt):
            assert image == b"camera-jpeg"
            assert media_type == "image/jpeg"
            return "An empty desk."

    class FakeVault:
        async def get(self, namespace, key, owner_id):
            assert (namespace, key, owner_id) == (
                "device_callback",
                "camera-two",
                "user-1",
            )
            return {"token": "camera-secret"}

    class FakeResponse:
        content = b"camera-jpeg"
        headers = {"content-type": "image/jpeg"}

        def raise_for_status(self):
            return None

    class FakeClient:
        def __init__(self, **kwargs):
            assert kwargs["timeout"] == 20.0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, headers):
            assert url == "http://camera-two.local:8089/v1/camera/snapshot"
            assert headers == {"Authorization": "Bearer camera-secret"}
            return FakeResponse()

    monkeypatch.setattr("jarvis_api.tools.httpx.AsyncClient", FakeClient)
    try:
        await store.create_entity(
            "device",
            "user-1",
            {
                "name": "Side Camera",
                "kind": "camera",
                "room": "Side Door",
                "base_url": "http://camera-two.local:8089",
                "metadata": {},
            },
            entity_id="camera-two",
        )
        registry = ToolRegistry(Capabilities(store), vision=FakeVision(), vault=FakeVault())
        result = json.loads(
            await registry.execute(
                "describe_scene",
                ToolContext("user-1", "conversation-1"),
                '{"camera_device_id":"camera-two"}',
            )
        )
        assert result == {
            "description": "An empty desk.",
            "source": {"kind": "camera", "id": "camera-two", "name": "Side Camera"},
        }
        await registry.close()
    finally:
        await store.close()
