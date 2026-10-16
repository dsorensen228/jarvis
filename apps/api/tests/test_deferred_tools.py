from __future__ import annotations

import asyncio
import json

import pytest

from jarvis_api.tools import ToolContext, ToolRegistry


class CapabilitiesStub:
    pass


@pytest.mark.asyncio
async def test_deferred_device_action_fires_without_blocking_voice_turn():
    registry = ToolRegistry(CapabilitiesStub())
    calls = []

    async def device_action(name, arguments):
        calls.append((name, arguments))
        return {"ok": True}

    context = ToolContext(
        user_id="user-1",
        conversation_id="conversation-1",
        device_id="office",
        device_action=device_action,
        voice_session=True,
    )
    try:
        result = json.loads(
            await registry.execute(
                "schedule_tool_call",
                context,
                json.dumps(
                    {
                        "target_tool": "spotify_pause",
                        "arguments": {},
                        "delay_seconds": 0.01,
                    }
                ),
            )
        )
        assert result["target_tool"] == "spotify_pause"
        await asyncio.sleep(0.03)
        assert calls == [("spotify_pause", {})]
        assert json.loads(await registry.execute("list_scheduled_tool_calls", context, "{}")) == []
    finally:
        await registry.close()


@pytest.mark.asyncio
async def test_deferred_device_action_can_be_cancelled():
    registry = ToolRegistry(CapabilitiesStub())

    async def device_action(name, arguments):
        raise AssertionError("cancelled action fired")

    context = ToolContext(
        user_id="user-1",
        conversation_id="conversation-1",
        device_id="playroom",
        device_action=device_action,
        voice_session=True,
    )
    try:
        created = json.loads(
            await registry.execute(
                "schedule_tool_call",
                context,
                json.dumps(
                    {
                        "target_tool": "navigate_device_ui",
                        "arguments": {"destination": "spotify"},
                        "delay_seconds": 60,
                    }
                ),
            )
        )
        cancelled = json.loads(
            await registry.execute(
                "cancel_scheduled_tool_calls",
                context,
                json.dumps({"action_id": created["action_id"]}),
            )
        )
        assert [row["action_id"] for row in cancelled["cancelled"]] == [created["action_id"]]
    finally:
        await registry.close()
