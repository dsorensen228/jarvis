#!/usr/bin/env python3
r"""Compare llama.cpp prefix reuse with synthetic Jarvis context and real schemas.

Run in the API Python environment (no database or tool execution is used):
  ssh example-api-host 'docker exec -i jarvis-api-1 python - --cases chat' \
      < scripts/benchmark-prefix-cache.py

Each case makes six sequential, short inference requests: cold-prefix, identical
warm request, and changed-context request, for each message layout. A unique
synthetic marker before the system prompt isolates each layout's cold prefix;
the server's slots/settings are never cleared or changed. Background traffic,
slot assignment, and model/template changes can affect results. TTFT is time to
the first nonempty content, reasoning, or tool delta, not the initial role event.
An output cap can prevent any parsed delta, in which case TTFT is null.
The final timings.cache_n is reused prompt tokens; timings.prompt_n counts newly
evaluated prompt tokens, and timings.prompt_ms measures their evaluation time.
usage.prompt_tokens includes both reused and newly evaluated prompt tokens.
full-chat is a catalog stress case; ordinary chat currently routes fewer tools.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from typing import Any, Dict, Iterable, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

CASES = {
    "chat": ("What is two plus two?", "What is three plus three?", False),
    "todo": (
        "Add a todo to check the synthetic sample.",
        "Add a todo to inspect the synthetic sample.",
        False,
    ),
    "voice-lights": ("Turn off the office lights.", "Turn on the office lights.", True),
    "full-chat": ("What is two plus two?", "What is three plus three?", False),
}


def load_fixture(case: str, personality: int) -> Dict[str, Any]:
    # Import only code/schema definitions. The inert dependencies are never
    # invoked, so no store, credentials, user history, or external tools are read.
    from jarvis_api.agent import PERSONALITY_PROMPTS, SYSTEM_PROMPT, VOICE_SESSION_PROMPT
    from jarvis_api.tool_policy import select_tool_policy
    from jarvis_api.tools import ToolRegistry

    original, changed, voice = CASES[case]
    registry = ToolRegistry(capabilities=None, integrations=object())
    policy = select_tool_policy(
        original,
        voice_session=voice,
        device_id="synthetic-benchmark" if voice else None,
        device_room="office" if voice else "",
    )
    catalog = {schema["function"]["name"]: schema for schema in registry.chat_schemas()}
    if voice:
        schemas = registry.schemas(policy.names)
    elif case == "full-chat":
        schemas = list(catalog.values())
    else:
        schemas = [catalog[name] for name in policy.names if name in catalog]
        # Match the agent's deferred schema discovery tool, including enum order.
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": "load_chat_tools",
                    "description": (
                        "Load tools to read or change owner data or use other capabilities. "
                        "Choose catalog names; their parameter schemas become available "
                        "on your next turn. Then call the loaded tools to do the work. "
                        "Do not load tools for ordinary conversation."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "names": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 8,
                                "items": {"type": "string", "enum": sorted(catalog)},
                            }
                        },
                        "required": ["names"],
                        "additionalProperties": False,
                    },
                },
            }
        )
    system = SYSTEM_PROMPT + "\n\n" + PERSONALITY_PROMPTS[personality]
    if voice:
        system += "\n\n" + VOICE_SESSION_PROMPT
    schemas.sort(key=lambda schema: schema["function"]["name"])
    return {
        "system": system,
        "tools": schemas,
        "original": original,
        "changed": changed,
        "tool_choice": "required" if policy.requires_tool else "auto",
    }


def make_payload(
    fixture: Dict[str, Any], layout: str, marker: str, changed: bool, model: str, max_tokens: int
) -> Dict[str, Any]:
    system = "Synthetic benchmark " + marker + ".\n\n" + fixture["system"]
    memory = (
        "Relevant memories:\n- Synthetic sample label: "
        + ("cobalt" if changed else "amber")
        + ". This fixture is invented and contains no owner information."
    )
    if layout == "legacy":
        messages = [{"role": "system", "content": system + "\n\n" + memory}]
    else:
        messages = [{"role": "system", "content": system}, {"role": "system", "content": memory}]
    messages.append({"role": "user", "content": fixture["changed" if changed else "original"]})
    return {
        "model": model,
        "messages": messages,
        "tools": fixture["tools"],
        "tool_choice": fixture["tool_choice"],
        "parallel_tool_calls": False,
        "stream": True,
        "stream_options": {"include_usage": True},
        "cache_prompt": True,
        "temperature": 0,
        "seed": 1,
        "max_tokens": max_tokens,
    }


def first_delta_kind(event: Dict[str, Any]) -> Optional[str]:
    for choice in event.get("choices") or []:
        delta = choice.get("delta") or {}
        for key in ("content", "reasoning_content", "reasoning"):
            if isinstance(delta.get(key), str) and delta[key]:
                return key
        for call in delta.get("tool_calls") or []:
            function = call.get("function") or {}
            if function.get("name") or function.get("arguments"):
                return "tool_calls"
    return None


def consume_sse(lines: Iterable[bytes], started: float) -> Dict[str, Any]:
    result = {"ttft_ms": None, "first_delta_kind": None, "timings": {}, "usage": {}}
    finish_reasons = []
    saw_done = False
    for line in lines:
        if not line.startswith(b"data:"):
            continue
        raw = line[5:].strip()
        if raw == b"[DONE]":
            saw_done = True
            break
        if not raw:
            continue
        event = json.loads(raw)
        if event.get("error"):
            raise RuntimeError("model stream returned an error")
        kind = first_delta_kind(event)
        if result["ttft_ms"] is None and kind:
            result["ttft_ms"] = round((time.perf_counter() - started) * 1000, 2)
            result["first_delta_kind"] = kind
        if event.get("timings"):
            result["timings"].update(event["timings"])
        if event.get("usage"):
            result["usage"].update(event["usage"])
        for choice in event.get("choices") or []:
            if choice.get("finish_reason"):
                finish_reasons.append(choice["finish_reason"])
    if not saw_done:
        raise RuntimeError("model stream ended without [DONE]")
    result.update(
        elapsed_ms=round((time.perf_counter() - started) * 1000, 2), finish_reasons=finish_reasons
    )
    return result


def run_request(
    base_url: str, api_key: str, payload: Dict[str, Any], timeout: float
) -> Dict[str, Any]:
    request = Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            return consume_sse(response, started)
    except HTTPError as exc:
        # Do not echo response bodies or request headers, which may hold secrets.
        raise RuntimeError("model returned HTTP " + str(exc.code)) from exc


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--cases", nargs="+", choices=tuple(CASES), default=["chat"])
    parser.add_argument(
        "--layouts", nargs="+", choices=("legacy", "split"), default=["legacy", "split"]
    )
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--max-tokens", type=int, choices=range(1, 9), default=8)
    parser.add_argument("--personality", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument(
        "--base-url", default=os.getenv("JARVIS_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    )
    parser.add_argument("--model", default=os.getenv("JARVIS_LLM_MODEL", "local"))
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument(
        "--dry-run", action="store_true", help="Print schema counts; do not call model"
    )
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    fixtures = {case: load_fixture(case, args.personality) for case in args.cases}
    print(
        json.dumps(
            {
                "type": "benchmark",
                "requests": 0
                if args.dry_run
                else len(fixtures) * len(args.layouts) * args.repeats * 3,
                "synthetic_only": True,
                "max_tokens": args.max_tokens,
                "note": "Cold-prefix uses unique synthetic markers; no server cache reset. "
                "TTFT includes model queueing and local HTTP; tool output is never executed.",
                "cases": {
                    name: {
                        "tool_count": len(fixture["tools"]),
                        "schema_sha256": hashlib.sha256(
                            json.dumps(fixture["tools"], sort_keys=True).encode()
                        ).hexdigest(),
                    }
                    for name, fixture in fixtures.items()
                },
            }
        ),
        flush=True,
    )
    if args.dry_run:
        return
    api_key = os.getenv("JARVIS_LLM_API_KEY", "local")
    for repeat in range(args.repeats):
        # Alternate order on repetitions to expose time/order bias.
        layouts = args.layouts if repeat % 2 == 0 else list(reversed(args.layouts))
        for case, fixture in fixtures.items():
            for layout in layouts:
                marker = str(uuid.uuid4())
                for phase in ("cold-prefix", "warm-identical", "changed-context"):
                    payload = make_payload(
                        fixture,
                        layout,
                        marker,
                        phase == "changed-context",
                        args.model,
                        args.max_tokens,
                    )
                    row = run_request(args.base_url, api_key, payload, args.timeout)
                    print(
                        json.dumps(
                            {
                                "type": "measurement",
                                "repeat": repeat + 1,
                                "case": case,
                                "layout": layout,
                                "phase": phase,
                                **row,
                            },
                            sort_keys=True,
                        ),
                        flush=True,
                    )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as exc:
        print("benchmark failed: " + str(exc), file=sys.stderr)
        sys.exit(1)
