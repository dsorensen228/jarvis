from __future__ import annotations

import json

import httpx
import pytest
from conftest import FakeLlm
from test_chat_stream import read_events
from test_code_factory import TASK, authenticated_client, gateway
from test_research_tasks import RESEARCH

from jarvis_api.api.task_models import CreateCodeTask, CreateResearchTask
from jarvis_api.capabilities import Capabilities
from jarvis_api.inference import LlmDelta, LlmTurn, ToolCall
from jarvis_api.tools import ToolContext, ToolRegistry


async def invoke(factory, name, args):
    registry = ToolRegistry(Capabilities(None), code_factory=factory)
    try:
        return json.loads(
            await registry.execute(name, ToolContext("owner", "chat"), json.dumps(args))
        )
    finally:
        await registry.close()


def test_chat_catalog_contains_task_capabilities_without_device_session_tools():
    registry = ToolRegistry(Capabilities(None), integrations=object())
    names = {tool["function"]["name"] for tool in registry.chat_schemas()}
    assert {
        "create_code_task",
        "get_code_task",
        "list_code_tasks",
        "cancel_code_task",
        "create_research_task",
        "get_research_task",
        "list_research_tasks",
        "cancel_research_task",
        "control_smart_device",
        "control_lights",
        "create_project",
        "search_gmail",
        "search_web",
    } <= names
    assert not {"end_voice_session", "spotify_play_best_match", "navigate_device_ui"} & names


def test_creation_schemas_derive_models_without_mutating_public_api_requirements():
    for _ in range(2):
        schemas = {
            tool["function"]["name"]: tool["function"]["parameters"]
            for tool in ToolRegistry(Capabilities(None)).chat_schemas()
        }
        for name, public_model in (
            ("create_code_task", CreateCodeTask),
            ("create_research_task", CreateResearchTask),
        ):
            schema = schemas[name]
            assert (
                schema["properties"]["model"]["enum"]
                == public_model.schema()["properties"]["model"]["enum"]
            )
            assert schema["properties"]["model"]["default"] == "gpt-6-sol"
            assert "model" not in schema["required"]
            assert "model" in public_model.schema()["required"]
        assert schemas["create_research_task"]["properties"]["verbosity"]["enum"] == [
            "concise",
            "standard",
            "in_depth",
        ]
        assert "queries" not in schemas["create_research_task"]["properties"]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["code", "research"])
@pytest.mark.parametrize("model", [None, "gpt-6-astra", "gpt-5.6-terra"])
async def test_creation_calls_existing_worker_with_current_defaults(kind, model):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            202, json={**(RESEARCH if kind == "research" else TASK), **json.loads(request.content)}
        )

    factory = gateway(handler)
    args = {"prompt": "  Compare alternatives  "}
    if model:
        args["model"] = model
    if kind == "research":
        args["verbosity"] = "in_depth"
    try:
        result = await invoke(factory, f"create_{kind}_task", args)
    finally:
        await factory.close()
    assert result["id"] == (RESEARCH if kind == "research" else TASK)["id"]
    expected = {"prompt": "Compare alternatives", "model": model or "gpt-6-sol"}
    if kind == "research":
        expected.update(task_type="research", verbosity="in_depth")
    assert len(calls) == 1
    assert calls[0].method == "POST"
    assert calls[0].url.path == "/v1/tasks"
    assert json.loads(calls[0].content) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["code", "research"])
@pytest.mark.parametrize(
    "args",
    [
        {"limit": 0},
        {"limit": 201},
        {"limit": True},
        {"limit": "4"},
        {"status": "made-up"},
        {"view": "bogus"},
        {"view": "active", "status": "running"},
        {"cursor": "x" * 1025},
        {"cursor": 4},
    ],
)
async def test_invalid_list_arguments_never_call_worker(kind, args):
    calls = []
    factory = gateway(
        lambda request: calls.append(request) or httpx.Response(200, json={"items": []})
    )
    try:
        result = await invoke(factory, f"list_{kind}_tasks", args)
    finally:
        await factory.close()
    assert "error" in result
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["code", "research"])
async def test_list_preserves_pagination_and_worker_filters(kind):
    calls = []
    page = {"items": [RESEARCH if kind == "research" else TASK], "next_cursor": "next"}
    factory = gateway(lambda request: calls.append(request) or httpx.Response(200, json=page))
    try:
        assert (
            await invoke(
                factory, f"list_{kind}_tasks", {"limit": 2, "cursor": "opaque", "view": "history"}
            )
            == page
        )
        expected = {"limit": "2", "cursor": "opaque", "view": "history"}
        if kind == "research":
            expected["task_type"] = "research"
        assert dict(calls[-1].url.params) == expected
        await invoke(factory, f"list_{kind}_tasks", {"status": "running"})
        assert calls[-1].url.params["limit"] == "30"
        assert calls[-1].url.params["status"] == "running"
    finally:
        await factory.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args",
    [
        ("create_code_task", {"prompt": " "}),
        ("create_code_task", {"prompt": "Fix it", "model": "unknown"}),
        ("create_research_task", {"prompt": "Investigate", "verbosity": "brief"}),
        ("get_code_task", {"task_id": " "}),
        ("cancel_research_task", {"task_id": 42}),
    ],
)
async def test_invalid_task_arguments_do_not_reach_worker(name, args):
    calls = []
    factory = gateway(lambda request: calls.append(request) or httpx.Response(200, json=TASK))
    try:
        assert "error" in await invoke(factory, name, args)
    finally:
        await factory.close()
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["code", "research"])
async def test_cancellation_preserves_type_guard_and_requested_state(kind):
    calls = []
    task = RESEARCH if kind == "research" else TASK

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={**task, "status": "cancel_requested" if request.method == "POST" else "running"},
        )

    factory = gateway(handler)
    try:
        result = await invoke(factory, f"cancel_{kind}_task", {"task_id": task["id"]})
        assert result["status"] == "cancel_requested"
        other = "code" if kind == "research" else "research"
        assert "error" in await invoke(factory, f"cancel_{other}_task", {"task_id": task["id"]})
    finally:
        await factory.close()
    assert [call.method for call in calls] == ["GET", "POST", "GET"]
    assert calls[1].url.path == f"/v1/tasks/{task['id']}/cancel"


@pytest.mark.asyncio
async def test_worker_failure_is_model_visible():
    factory = gateway(lambda request: httpx.Response(503, json={"detail": "Worker unavailable"}))
    try:
        result = await invoke(factory, "create_research_task", {"prompt": "Investigate"})
    finally:
        await factory.close()
    assert result == {"error": "CodeFactoryError", "detail": "Worker unavailable"}


@pytest.mark.parametrize("kind", ["code", "research"])
def test_authenticated_chat_creation_can_be_polled_through_existing_task_api(settings, kind):
    calls = []
    task = {**(RESEARCH if kind == "research" else TASK), "status": "pending"}
    tool_name = f"create_{kind}_task"

    class TaskLlm(FakeLlm):
        async def stream_chat(self, messages, tools, *args, **kwargs):
            if messages[-1]["role"] != "tool":
                names = {tool["function"]["name"] for tool in tools}
                assert tool_name in names
                yield LlmDelta(
                    kind="done",
                    turn=LlmTurn(
                        content="",
                        tool_calls=[
                            ToolCall("call-1", tool_name, '{"prompt":"Compare alternatives"}')
                        ],
                    ),
                )
            else:
                yield LlmDelta(kind="done", turn=LlmTurn(content="The task is queued."))

    def handler(request):
        calls.append(request)
        return httpx.Response(202 if request.method == "POST" else 200, json=task)

    with authenticated_client(settings, gateway(handler)) as client:
        client.app.state.agent.llm = TaskLlm()
        response = client.post(
            "/v1/chat/stream", json={"message": f"Create a {kind} task comparing alternatives."}
        )
        events = read_events(response)
        finished = next(data for event, data in events if event == "tool.finished")
        assert finished["name"] == tool_name
        assert finished["result"]["id"] == task["id"]
        assert finished["status"] == "completed"
        poll = client.get(f"/v1/{kind}-tasks/{task['id']}")
        assert poll.status_code == 200, poll.text
        assert poll.json()["status"] == "pending"
        count = len(calls)
        client.headers.pop("Authorization")
        assert (
            client.post("/v1/chat/stream", json={"message": "Create another task"}).status_code
            == 401
        )
        assert len(calls) == count
    assert json.loads(calls[0].content)["model"] == "gpt-6-sol"
