from __future__ import annotations

import pytest
from conftest import FakeLlm

from jarvis_api.agent import MAX_CHAT_MODEL_CHARACTERS, JarvisAgent, _chat_model_messages
from jarvis_api.capabilities import Capabilities
from jarvis_api.store import SqliteStore
from jarvis_api.tools import ToolRegistry


@pytest.mark.asyncio
@pytest.mark.parametrize("voice_session", [False, True])
async def test_changed_owner_context_keeps_instruction_prefix_and_uses_fresh_data(
    tmp_path, voice_session
):
    store = SqliteStore(str(tmp_path / "cache.sqlite3"))
    await store.start()
    capabilities = Capabilities(store)
    registry = ToolRegistry(capabilities)
    llm = FakeLlm()
    agent = JarvisAgent(store, llm, capabilities, registry)
    try:
        first = await agent.run("owner", "Tell me about coffee", voice_session=voice_session)
        initial_prefix = llm.requests[-1][0]
        assert llm.requests[-1][1]["role"] == "user"

        project = await capabilities.create_project("owner", "Coffee notes", "Old project detail")
        await store.mutate_entity(
            "conversation",
            first.conversation_id,
            "owner",
            lambda current: {**current, "project_id": project["id"]},
        )
        memory = await capabilities.create_memory("owner", "Coffee preference: black")
        await agent.run(
            "owner",
            "Tell me about coffee",
            conversation_id=first.conversation_id,
            voice_session=voice_session,
        )
        previous = llm.requests[-1]
        assert previous[0] == initial_prefix
        assert previous[1]["role"] == "system"
        assert "Old project detail" in previous[1]["content"]
        assert "Coffee preference: black" in previous[1]["content"]

        await store.mutate_entity(
            "project",
            project["id"],
            "owner",
            lambda current: {**current, "description": "Current project detail"},
        )
        await store.mutate_entity(
            "memory",
            memory["id"],
            "owner",
            lambda current: {**current, "content": "Coffee preference: oat milk"},
        )
        await agent.run(
            "owner",
            "Tell me about coffee",
            conversation_id=first.conversation_id,
            voice_session=voice_session,
        )
        current = llm.requests[-1]
        assert current[0] == initial_prefix
        assert current[1]["role"] == "system"
        assert "Current project detail" in current[1]["content"]
        assert "Coffee preference: oat milk" in current[1]["content"]
        assert "Old project detail" not in current[1]["content"]
        assert "Coffee preference: black" not in current[1]["content"]
        assert current[2]["role"] == "user"
        assert all(
            item["role"] in {"user", "assistant"}
            for item in await store.list_messages("owner", first.conversation_id)
        )
    finally:
        await registry.close()
        await store.close()


def test_dynamic_system_context_is_bounded_without_losing_instructions_or_latest_question():
    messages = [
        {"role": "system", "content": "Follow the owner's instructions."},
        {"role": "system", "content": "Active project:\n" + "Reference data. " * 4000},
        {"role": "user", "content": "What is the project about?"},
    ]

    result = _chat_model_messages(messages)

    assert sum(len(message["content"]) for message in result) <= MAX_CHAT_MODEL_CHARACTERS
    assert result[0] == messages[0]
    assert result[-1] == messages[-1]
    assert result[1]["content"].startswith("Active project:\n")
    assert len(result[1]["content"]) < len(messages[1]["content"])
