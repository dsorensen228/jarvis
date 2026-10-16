"""Fresh, bounded robot dialogue; the model supplies content, never actions."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, conint, conlist, constr

from jarvis_api.banter_prompts import BANTER_PROMPTS, BanterPrompt
from jarvis_api.banter_triggers import (
    BanterTriggers,
    BanterUnavailable,
    PollResponse,
    RobotPoll,
    TriggerId,
)
from jarvis_api.inference import InferenceUnavailable

logger = logging.getLogger(__name__)


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class Exchange(StrictModel):
    sherman: constr(strict=True, strip_whitespace=True, min_length=1, max_length=180)
    emotion: Literal["curious", "pleased", "skeptical", "indignant", "conspiratorial"]
    jarvis: constr(strict=True, strip_whitespace=True, min_length=1, max_length=240)


class ScriptContent(StrictModel):
    schema_version: conint(strict=True, ge=1, le=1)
    exchanges: conlist(Exchange, min_items=1, max_items=2)


class ScriptRequest(StrictModel):
    source_device_id: constr(strict=True, regex=r"^[a-zA-Z0-9_-]{1,100}$")
    response_device_id: constr(strict=True, regex=r"^[a-zA-Z0-9_-]{1,100}$")
    recent_exchanges: conlist(Exchange, max_items=8) = Field(default_factory=list)
    trigger_id: Optional[TriggerId] = None


class ScriptResponse(ScriptContent):
    script_id: str
    source_device_id: str
    response_device_id: str
    expires_in_seconds: int
    initiator: Literal["sherman", "jarvis"] = "sherman"


@dataclass
class PendingScript:
    attempted_at: float
    script: Optional[ScriptResponse] = None
    expires_at: float = 0.0
    next_index: int = 0
    generating: bool = True
    finished: bool = False
    trigger_id: Optional[str] = None


# Observational premises the local model keeps inventing despite the prompt.
# Match actions/scenes only — "he's ugly/stupid" must still be allowed.
_INVENTED_OWNER_ACTION = re.compile(
    r"\b(?:"
    r"he(?:'s|’s| is| was) (?:watching|typing|humming|turning|leaving|playing|using|"
    r"eating|drinking|sitting|standing|walking|talking|looking|pretending|"
    r"doing|making|opening|closing|moving|holding|thinking)|"
    r"he (?:left|turned|opened|closed|put|took|thinks|thought|believes|said|says)\b"
    r")",
    re.IGNORECASE,
)
_FORMULA_CAN_WE = re.compile(r"^\s*can we\b", re.IGNORECASE)
_FORMULA_ONLY_IF = re.compile(r"\bonly if\b", re.IGNORECASE)


def _norm_line(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def usable_recent(recent: Optional[list] = None) -> list:
    """Drop history that already violates style so it cannot steer the next turn."""
    if not recent:
        return []
    kept = []
    for line in recent:
        try:
            content = ScriptContent(schema_version=1, exchanges=[line])
        except Exception:
            continue
        if style_error(content) is None:
            kept.append(line)
    return kept


def style_error(content: ScriptContent, recent: Optional[list] = None) -> Optional[str]:
    """Reject the repetitive invented-action gag the local model defaults to."""
    lines = content.exchanges
    joined = " ".join(f"{line.sherman} {line.jarvis}" for line in lines)
    if _INVENTED_OWNER_ACTION.search(joined):
        return "invented owner action or scene"
    if (
        len(lines) == 2
        and _FORMULA_CAN_WE.search(lines[1].sherman)
        and any(_FORMULA_ONLY_IF.search(line.jarvis) for line in lines)
        and re.search(r"\bagain\b", lines[0].sherman, re.IGNORECASE)
    ):
        return "stale again / can-we / only-if formula"
    if recent:
        prior = {
            _norm_line(f"{line.sherman} {line.jarvis}")
            for line in recent
            if getattr(line, "sherman", None) and getattr(line, "jarvis", None)
        }
        prior_sherman = {
            _norm_line(line.sherman) for line in recent if getattr(line, "sherman", None)
        }
        prior.update(_norm_line(line.jarvis) for line in recent if getattr(line, "jarvis", None))
        for line in lines:
            if _norm_line(f"{line.sherman} {line.jarvis}") in prior:
                return "repeats recent exchange"
            if _norm_line(line.jarvis) in prior:
                return "repeats recent jarvis line"
            if _norm_line(line.sherman) in prior_sherman:
                return "repeats recent sherman line"
    return None


class BanterService:
    TTL_SECONDS = 180
    COOLDOWN_SECONDS = 300
    MAX_OWNERS = 128
    MAX_GENERATION_ATTEMPTS = 5

    def __init__(
        self, llm: Any, voices: Any, clock: Any = time.monotonic, *, rng: Any = None
    ) -> None:
        self.llm = llm
        self.voices = voices
        self.clock = clock
        self.rng = random.Random() if rng is None else rng
        # One pending generation/script per authenticated owner, bounded globally.
        self.pending: Dict[str, PendingScript] = {}
        self.triggers = BanterTriggers(self.active, clock)

    def active(self, owner: str) -> bool:
        pending = self.pending.get(owner)
        return bool(
            pending
            and not pending.finished
            and (pending.generating or (pending.script and self.clock() < pending.expires_at))
        )

    def poll(self, owner: str, request: RobotPoll) -> PollResponse:
        response = self.triggers.poll(owner, request)
        pending = self.pending.get(owner)
        if (
            request.result
            and pending
            and pending.script
            and pending.trigger_id == request.result.trigger_id
            and pending.script.source_device_id == request.source_device_id
            and pending.script.response_device_id == request.response_device_id
        ):
            # A local robot abort must release the demo and reject any delayed reply.
            pending.finished = True
        return response

    async def create(self, owner: str, request: ScriptRequest) -> ScriptResponse:
        now = self.clock()
        self.pending = {
            key: value
            for key, value in self.pending.items()
            if now - value.attempted_at < self.COOLDOWN_SECONDS
        }
        if self.active(owner):
            raise BanterUnavailable("banter is already running")
        if request.trigger_id:
            self.triggers.consume(
                owner, request.source_device_id, request.response_device_id, request.trigger_id
            )
        elif owner in self.pending or self.triggers.reserved(owner):
            raise BanterUnavailable("banter cooldown active")
        if owner not in self.pending and len(self.pending) >= self.MAX_OWNERS:
            raise BanterUnavailable("banter capacity reached")
        pending = PendingScript(attempted_at=now, trigger_id=request.trigger_id)
        self.pending[owner] = pending
        try:
            await self.voices.scripted_speech_ready(owner, request.response_device_id)
            content, prompt = await asyncio.wait_for(self._generate(request), timeout=45.0)
            # Generation can take time. Check again before Sherman starts beeping.
            await self.voices.scripted_speech_ready(owner, request.response_device_id)
        except (RuntimeError, asyncio.TimeoutError, ValueError) as exc:
            self.pending.pop(owner, None)
            raise BanterUnavailable("generation or response speaker unavailable") from exc
        finally:
            pending.generating = False
        pending.script = ScriptResponse(
            **content.dict(),
            script_id=uuid.uuid4().hex,
            source_device_id=request.source_device_id,
            response_device_id=request.response_device_id,
            expires_in_seconds=self.TTL_SECONDS,
            initiator=prompt.initiator,
        )
        pending.expires_at = self.clock() + self.TTL_SECONDS
        logger.info(
            "banter script ready source=%s response=%s exchanges=%s",
            request.source_device_id,
            request.response_device_id,
            json.dumps([line.dict() for line in content.exchanges]),
        )
        return pending.script

    def _user_payload(
        self, request: ScriptRequest, attempt: int, prompt: BanterPrompt
    ) -> Dict[str, Any]:
        recent = usable_recent(request.recent_exchanges)
        return {
            "request": "Write a fresh conversation using the selected dialogue brief.",
            "dialogue_style": prompt.name,
            "requested_exchanges": prompt.exchanges,
            "initiator": prompt.initiator,
            "freshness_token": uuid.uuid4().hex,
            "recent_exchanges_to_avoid": [line.dict() for line in recent],
            "rules": [
                "Do not reuse or lightly rephrase any recent exchange.",
                "Do not invent owner actions or scenes.",
            ],
            "variation_id": uuid.uuid4().hex,
            "attempt": attempt + 1,
        }

    async def _generate_once(
        self, request: ScriptRequest, attempt: int, prompt: BanterPrompt
    ) -> ScriptContent:
        messages = [
            {"role": "system", "content": prompt.system_prompt},
            {"role": "user", "content": json.dumps(self._user_payload(request, attempt, prompt))},
        ]
        output = ""
        async for delta in self.llm.stream_chat(messages, [], temperature=0.95):
            if delta.kind == "text":
                output += delta.text
                if len(output.encode("utf-8")) > 4096:
                    raise InferenceUnavailable("script exceeds content limit")
        # No repair request, canned fallback, Markdown stripping, or executable output.
        parsed = ScriptContent.parse_raw(output)
        if any(len(line.jarvis.split()) > 30 for line in parsed.exchanges):
            raise ValueError("response exceeds 30 words")
        return parsed

    async def _generate(
        self, request: ScriptRequest, prompt: Optional[BanterPrompt] = None
    ) -> tuple[ScriptContent, BanterPrompt]:
        # Choose once per interaction, including manual requests. Retries keep its
        # voice and length brief rather than selecting whichever style passes first.
        if prompt is None:
            prompt = self.rng.choice(BANTER_PROMPTS)
        logger.info(
            "banter prompt selected style=%s initiator=%s requested_exchanges=%s "
            "source=%s response=%s",
            prompt.name,
            prompt.initiator,
            prompt.exchanges,
            request.source_device_id,
            request.response_device_id,
        )
        last_error = "empty generation"
        for attempt in range(self.MAX_GENERATION_ATTEMPTS):
            try:
                parsed = await self._generate_once(request, attempt, prompt)
            except InferenceUnavailable:
                raise
            except Exception as exc:
                last_error = str(exc)
                logger.info(
                    "banter generation rejected attempt=%s reason=%s",
                    attempt + 1,
                    last_error,
                )
                continue
            problem = style_error(parsed, usable_recent(request.recent_exchanges))
            if problem is None:
                return parsed, prompt
            last_error = problem
            logger.info(
                "banter style rejected attempt=%s reason=%s exchanges=%s",
                attempt + 1,
                problem,
                json.dumps([line.dict() for line in parsed.exchanges]),
            )
        raise ValueError(f"banter style rejected: {last_error}")

    async def reply(self, owner: str, script_id: str, index: int) -> Dict[str, Any]:
        pending = self.pending.get(owner)
        if (
            pending is None
            or pending.finished
            or pending.script is None
            or pending.script.script_id != script_id
            or self.clock() >= pending.expires_at
            or index != pending.next_index
            or not 0 <= index < len(pending.script.exchanges)
        ):
            raise BanterUnavailable("script expired, unknown, consumed, or out of order")
        # Consume before I/O: a lost HTTP reply must never replay spoken audio.
        pending.next_index = -1
        try:
            await asyncio.wait_for(
                self.voices.speak_scripted(
                    owner,
                    pending.script.response_device_id,
                    pending.script.exchanges[index].jarvis,
                ),
                timeout=45.0,
            )
        except (RuntimeError, asyncio.TimeoutError) as exc:
            pending.finished = True
            raise BanterUnavailable("response speaker busy, interrupted, or unavailable") from exc
        pending.next_index = index + 1
        pending.finished = pending.finished or pending.next_index == len(pending.script.exchanges)
        return {"status": "played", "script_id": script_id, "exchange_index": index}
