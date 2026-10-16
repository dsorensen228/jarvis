from __future__ import annotations

import asyncio
import json

import pytest

from jarvis_api.agent import JarvisAgent
from jarvis_api.capabilities import Capabilities
from jarvis_api.inference import LlmDelta, LlmTurn, ToolCall
from jarvis_api.store import SqliteStore


class TaskTools:
    def __init__(self):
        self.result = {
            "id": "task-1",
            "status": "running",
            "prompt": "Review code",
            "stdout": "log " * 30000,
        }

    def chat_schemas(self):
        return []

    def schemas(self, names):
        return []

    async def execute(self, name, context, arguments):
        return json.dumps(self.result)


class TaskLlm:
    def __init__(self, outcome="success"):
        self.outcome = outcome
        self.requests = []
        self.followup_started = asyncio.Event()

    async def stream_chat(self, messages, *args, **kwargs):
        self.requests.append(messages)
        if len(self.requests) == 1:
            yield LlmDelta(
                kind="done",
                turn=LlmTurn(
                    tool_calls=[ToolCall("call-1", "create_code_task", '{"prompt":"Review code"}')]
                ),
            )
        else:
            self.followup_started.set()
            yield LlmDelta(kind="text", text="The task is running.")
            if self.outcome == "error":
                raise RuntimeError("inference failed")
            if self.outcome == "cancel":
                await asyncio.Event().wait()
            yield LlmDelta(kind="done", turn=LlmTurn(content="The task is running."))


@pytest.mark.asyncio
async def test_model_tool_budget_preserves_full_public_results_and_one_final_message(tmp_path):
    store = SqliteStore(str(tmp_path / "bounded.sqlite"))
    await store.start()
    tools = TaskTools()
    llm = TaskLlm()
    events = []

    async def emit(event, data):
        events.append((event, data))

    try:
        agent = JarvisAgent(store, llm, Capabilities(store), tools)
        result = await agent.run("owner", "Create a code task", emit=emit)
        model_result = json.loads(llm.requests[1][-1]["content"])
        assert model_result["id"] == "task-1"
        assert model_result["status"] == "running"
        assert len(llm.requests[1][-1]["content"]) <= 8000
        assert model_result.get("_truncated") is True
        finished = next(data for name, data in events if name == "tool.finished")
        assert finished["result"] == tools.result
        saved = await store.list_messages("owner", result.conversation_id)
        assert [message["role"] for message in saved] == ["user", "assistant"]
        assert saved[-1]["metadata"]["tool_calls"][0]["result"] == tools.result
        assert not saved[-1]["metadata"].get("interrupted")
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["error", "cancel"])
async def test_created_task_and_partial_answer_survive_interrupted_inference(tmp_path, outcome):
    store = SqliteStore(str(tmp_path / "interrupted.sqlite"))
    await store.start()
    tools = TaskTools()
    llm = TaskLlm(outcome)
    try:
        agent = JarvisAgent(store, llm, Capabilities(store), tools)
        run = asyncio.create_task(agent.run("owner", "Create a code task"))
        await asyncio.wait_for(llm.followup_started.wait(), 2)
        if outcome == "cancel":
            run.cancel()
        with pytest.raises(RuntimeError if outcome == "error" else asyncio.CancelledError):
            await run
        conversation = (await store.list_entities("conversation", "owner"))[0]
        saved = await store.list_messages("owner", conversation["id"])
        assert [message["role"] for message in saved] == ["user", "assistant"]
        assert "The task is running." in saved[-1]["content"]
        assert "interrupted" in saved[-1]["content"].lower()
        assert saved[-1]["metadata"]["interrupted"] is True
        assert saved[-1]["metadata"]["tool_calls"][0]["result"] == tools.result
        assert conversation["message_count"] == 2
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_failure_delivering_saved_final_message_does_not_duplicate_it(tmp_path):
    store = SqliteStore(str(tmp_path / "final.sqlite"))
    await store.start()

    async def emit(event, data):
        if event == "message.created" and data["role"] == "assistant":
            raise RuntimeError("connection lost")

    try:
        agent = JarvisAgent(store, TaskLlm(), Capabilities(store), TaskTools())
        with pytest.raises(RuntimeError):
            await agent.run("owner", "Create a code task", emit=emit)
        conversation = (await store.list_entities("conversation", "owner"))[0]
        saved = await store.list_messages("owner", conversation["id"])
        assert [message["role"] for message in saved] == ["user", "assistant"]
        assert saved[-1]["content"] == "The task is running."
        assert not saved[-1]["metadata"].get("interrupted")
    finally:
        await store.close()


def test_multiple_tool_results_share_budget_with_history_and_arguments():
    from jarvis_api.agent import MAX_CHAT_MODEL_CHARACTERS, _chat_model_messages

    messages = [
        {"role": "system", "content": "System " * 400},
        {"role": "user", "content": "Previous history " * 1200},
        {"role": "user", "content": "Latest request " * 400},
    ]
    for index in range(3):
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": str(index),
                            "type": "function",
                            "function": {
                                "name": "get_code_task",
                                "arguments": json.dumps(
                                    {"task_id": str(index), "prompt": "x" * 20000}
                                ),
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": str(index),
                    "content": json.dumps(
                        {"id": str(index), "status": "success", "stdout": "log" * 20000}
                    ),
                },
            ]
        )
    original = json.dumps(messages)
    bounded = _chat_model_messages(messages)
    used = sum(
        len(message.get("content") or "")
        + sum(len(call["function"]["arguments"]) for call in message.get("tool_calls", []))
        for message in bounded
    )
    assert used <= MAX_CHAT_MODEL_CHARACTERS
    assert json.dumps(messages) == original
    for message in bounded:
        if message["role"] == "tool":
            result = json.loads(message["content"])
            assert result["id"] == message["tool_call_id"]
            assert result["status"] == "success"
    assert bounded[2]["content"] == messages[2]["content"]


@pytest.mark.asyncio
async def test_cancellation_during_final_commit_does_not_duplicate_assistant(tmp_path):
    store = SqliteStore(str(tmp_path / "commit.sqlite"))
    await store.start()
    committed = asyncio.Event()
    release = asyncio.Event()
    original_add = store.add_message

    async def delayed_add(owner_id, conversation_id, role, content, metadata=None):
        result = await original_add(owner_id, conversation_id, role, content, metadata)
        if role == "assistant":
            committed.set()
            await release.wait()
        return result

    store.add_message = delayed_add
    try:
        agent = JarvisAgent(store, TaskLlm(), Capabilities(store), TaskTools())
        run = asyncio.create_task(agent.run("owner", "Create a code task"))
        await asyncio.wait_for(committed.wait(), 2)
        run.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await run
        conversation = (await store.list_entities("conversation", "owner"))[0]
        saved = await store.list_messages("owner", conversation["id"])
        assert [message["role"] for message in saved] == ["user", "assistant"]
        assert not saved[-1]["metadata"].get("interrupted")
    finally:
        release.set()
        await store.close()


@pytest.mark.asyncio
async def test_voice_keeps_existing_inference_and_failure_behavior(tmp_path):
    store = SqliteStore(str(tmp_path / "voice.sqlite"))
    await store.start()
    llm = TaskLlm("error")
    try:
        agent = JarvisAgent(store, llm, Capabilities(store), TaskTools())
        with pytest.raises(RuntimeError):
            await agent.run("owner", "Create a code task", voice_session=True)
        assert len(llm.requests[1][-1]["content"]) > 100000
        conversation = (await store.list_entities("conversation", "owner"))[0]
        assert [
            message["role"] for message in await store.list_messages("owner", conversation["id"])
        ] == ["user"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_interrupted_text_without_tools_is_saved(tmp_path):
    class PartialLlm:
        async def stream_chat(self, *args, **kwargs):
            yield LlmDelta(kind="text", text="First part of the answer.")
            raise RuntimeError("inference failed")

    store = SqliteStore(str(tmp_path / "partial.sqlite"))
    await store.start()
    try:
        agent = JarvisAgent(store, PartialLlm(), Capabilities(store), TaskTools())
        with pytest.raises(RuntimeError):
            await agent.run("owner", "Explain this")
        conversation = (await store.list_entities("conversation", "owner"))[0]
        saved = await store.list_messages("owner", conversation["id"])
        assert "First part of the answer." in saved[-1]["content"]
        assert saved[-1]["metadata"] == {"interrupted": True}
    finally:
        await store.close()


def test_model_budget_retains_system_and_user_instructions_before_large_reference_material():
    from jarvis_api.agent import MAX_CHAT_MODEL_CHARACTERS, _chat_model_messages

    result = _chat_model_messages(
        [
            {"role": "system", "content": "System instructions. " + "Project data. " * 4000},
            {
                "role": "user",
                "content": "Compare the attached reports. " + "File evidence. " * 3000,
            },
        ]
    )
    assert result[0]["content"].startswith("System instructions.")
    assert sum(len(message["content"]) for message in result) <= MAX_CHAT_MODEL_CHARACTERS
    result = _chat_model_messages(
        [
            {"role": "system", "content": "System instructions."},
            {
                "role": "user",
                "content": "Compare the attached reports. " + "File evidence. " * 3000,
            },
        ]
    )
    assert result[-1]["content"].startswith("Compare the attached reports.")
