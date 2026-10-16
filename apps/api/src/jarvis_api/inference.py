"""OpenAI-compatible client for the one local model server used by Jarvis."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from jarvis_api.config import Settings

logger = logging.getLogger(__name__)


class InferenceUnavailable(RuntimeError):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments_json: str


@dataclass
class LlmTurn:
    content: str = ""
    reasoning: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)
    timings: Dict[str, Any] = field(default_factory=dict)
    ttft_ms: Optional[float] = None


@dataclass
class LlmDelta:
    kind: str
    text: str = ""
    turn: Optional[LlmTurn] = None


class LocalLlmClient:
    """A narrow client instead of a provider abstraction or model catalog."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.llm_base_url,
            timeout=httpx.Timeout(settings.llm_request_timeout_seconds, connect=5.0),
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def ready(self) -> bool:
        try:
            response = await self._client.get("/models", timeout=2.0)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        cancel_event: Optional[asyncio.Event] = None,
        *,
        tool_choice: Any = "auto",
        temperature: float = 0.6,
    ) -> AsyncIterator[LlmDelta]:
        payload: Dict[str, Any] = {
            "model": self.settings.llm_model,
            "messages": messages,
            "stream": True,
            # llama.cpp already defaults to caching; keep the contract explicit.
            "cache_prompt": True,
            "stream_options": {"include_usage": True},
            "temperature": temperature,
            "top_p": 0.9,
            "max_tokens": self.settings.llm_max_output_tokens,
        }
        if tools:
            # The template renders this array into the prompt. Equivalent tool
            # sets must have identical ordering even after discovery/loading.
            payload["tools"] = sorted(tools, key=lambda tool: tool["function"]["name"])
            payload["tool_choice"] = tool_choice
            payload["parallel_tool_calls"] = False

        content_parts: List[str] = []
        reasoning_parts: List[str] = []
        tool_parts: Dict[int, Dict[str, str]] = {}
        usage: Dict[str, Any] = {}
        timings: Dict[str, Any] = {}
        started_at = time.monotonic()
        ttft_ms: Optional[float] = None
        try:
            async with self._client.stream("POST", "/chat/completions", json=payload) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    raise InferenceUnavailable(
                        f"local model returned HTTP {response.status_code}: {body[:500]}"
                    )
                async for line in response.aiter_lines():
                    if cancel_event is not None and cancel_event.is_set():
                        return
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    # Final usage chunks can have no choices. Read metrics before
                    # skipping them, including llama.cpp's actual reused tokens.
                    if isinstance(event.get("usage"), dict):
                        usage.update(event["usage"])
                    if isinstance(event.get("timings"), dict):
                        timings.update(event["timings"])
                    choices = event.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if ttft_ms is None and (
                        delta.get("content")
                        or delta.get("reasoning_content")
                        or any(
                            (call.get("function") or {}).get("name")
                            or (call.get("function") or {}).get("arguments")
                            for call in delta.get("tool_calls") or []
                        )
                    ):
                        # Ignore the initial role-only SSE chunk; it precedes prefill.
                        ttft_ms = (time.monotonic() - started_at) * 1000
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        content_parts.append(content)
                        yield LlmDelta(kind="text", text=content)
                    reasoning = delta.get("reasoning_content")
                    if isinstance(reasoning, str) and reasoning:
                        reasoning_parts.append(reasoning)
                        yield LlmDelta(kind="reasoning", text=reasoning)
                    for call in delta.get("tool_calls") or []:
                        index = int(call.get("index", 0))
                        part = tool_parts.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        if call.get("id"):
                            part["id"] += str(call["id"])
                        function = call.get("function") or {}
                        if function.get("name"):
                            part["name"] += str(function["name"])
                        if function.get("arguments"):
                            part["arguments"] += str(function["arguments"])
        except httpx.HTTPError as exc:
            raise InferenceUnavailable(f"could not reach local model: {exc}") from exc

        calls = [
            ToolCall(
                id=part["id"] or f"tool-{index}",
                name=part["name"],
                arguments_json=part["arguments"] or "{}",
            )
            for index, part in sorted(tool_parts.items())
        ]
        logger.info(
            "llm request finished tools=%d ttft_ms=%s elapsed_ms=%.1f "
            "prompt_tokens=%s cached_tokens=%s prompt_eval_tokens=%s prompt_ms=%s",
            len(tools),
            round(ttft_ms, 1) if ttft_ms is not None else None,
            (time.monotonic() - started_at) * 1000,
            usage.get("prompt_tokens"),
            timings.get("cache_n"),
            timings.get("prompt_n"),
            timings.get("prompt_ms"),
        )
        yield LlmDelta(
            kind="done",
            turn=LlmTurn(
                content="".join(content_parts),
                reasoning="".join(reasoning_parts),
                tool_calls=calls,
                usage=usage,
                timings=timings,
                ttft_ms=ttft_ms,
            ),
        )
