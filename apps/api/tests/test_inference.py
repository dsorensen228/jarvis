from __future__ import annotations

import json
import logging

import httpx
import pytest

from jarvis_api.config import Settings
from jarvis_api.inference import LocalLlmClient


async def stream_fixture(events, *, tools=None):
    requests = []

    def handle(request):
        requests.append(json.loads(request.content))
        data = "".join("data: " + json.dumps(event) + "\n\n" for event in events)
        return httpx.Response(200, text=data + "data: [DONE]\n\n")

    client = LocalLlmClient(Settings.from_env())
    await client._client.aclose()
    client._client = httpx.AsyncClient(
        base_url="http://llm/v1", transport=httpx.MockTransport(handle)
    )
    try:
        deltas = [
            delta
            async for delta in client.stream_chat(
                [{"role": "system", "content": "Private prompt must not be logged"}], tools or []
            )
        ]
        return requests, deltas
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_requests_enable_cache_and_canonicalize_tool_order_without_mutation():
    tools = [
        {"type": "function", "function": {"name": "zebra", "parameters": {"type": "object"}}},
        {"type": "function", "function": {"name": "alpha", "parameters": {"type": "object"}}},
    ]
    requests, _ = await stream_fixture([], tools=tools)
    request = requests[0]
    assert request["cache_prompt"] is True
    assert request["stream_options"] == {"include_usage": True}
    assert [tool["function"]["name"] for tool in request["tools"]] == ["alpha", "zebra"]
    assert [tool["function"]["name"] for tool in tools] == ["zebra", "alpha"]
    assert request["tool_choice"] == "auto"


@pytest.mark.asyncio
async def test_preserves_usage_only_chunk_and_native_cache_timings(caplog):
    caplog.set_level(logging.INFO, logger="jarvis_api.inference")
    _, deltas = await stream_fixture(
        [
            {"choices": [{"delta": {"role": "assistant", "content": ""}}]},
            {"choices": [{"delta": {"content": "Hello"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {
                "choices": [],
                "usage": {"prompt_tokens": 1020, "completion_tokens": 1, "total_tokens": 1021},
                "timings": {"cache_n": 1000, "prompt_n": 20, "prompt_ms": 42.5},
            },
        ]
    )
    turn = deltas[-1].turn
    assert turn.content == "Hello"
    assert turn.usage["prompt_tokens"] == 1020
    assert turn.timings == {"cache_n": 1000, "prompt_n": 20, "prompt_ms": 42.5}
    assert turn.ttft_ms is not None and turn.ttft_ms >= 0
    assert "cached_tokens=1000" in caplog.text
    assert "prompt_eval_tokens=20" in caplog.text
    assert "Private prompt" not in caplog.text


@pytest.mark.asyncio
async def test_tool_call_deltas_count_as_first_token_and_keep_zero_cache_hits(caplog):
    caplog.set_level(logging.INFO, logger="jarvis_api.inference")
    _, deltas = await stream_fixture(
        [
            {"choices": [{"delta": {"role": "assistant", "content": ""}}]},
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-1",
                                    "function": {"name": "read_clock", "arguments": "{}"},
                                }
                            ]
                        }
                    }
                ]
            },
            {"choices": [], "timings": {"cache_n": 0, "prompt_n": 12, "prompt_ms": 9}},
        ]
    )
    turn = deltas[-1].turn
    assert turn.tool_calls[0].name == "read_clock"
    assert turn.ttft_ms is not None
    assert "cached_tokens=0" in caplog.text


@pytest.mark.asyncio
async def test_missing_metrics_remain_unknown():
    _, deltas = await stream_fixture([{"choices": [{"delta": {"content": "Hi"}}]}])
    assert deltas[-1].turn.usage == {}
    assert deltas[-1].turn.timings == {}


@pytest.mark.asyncio
async def test_role_only_stream_has_no_first_token():
    _, deltas = await stream_fixture([{"choices": [{"delta": {"role": "assistant"}}]}])
    assert deltas[-1].turn.ttft_ms is None


@pytest.mark.asyncio
async def test_tool_metadata_only_stream_has_no_first_token():
    _, deltas = await stream_fixture(
        [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "id": "call-1", "type": "function", "function": {}}
                            ]
                        }
                    }
                ]
            }
        ]
    )
    assert deltas[-1].turn.ttft_ms is None
