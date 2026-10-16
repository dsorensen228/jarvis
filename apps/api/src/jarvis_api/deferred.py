"""Process-local deferred tool actions for persistent voice-device connections."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, List, Optional

from dateutil import tz

logger = logging.getLogger(__name__)

Invoke = Callable[[], Awaitable[Any]]


@dataclass
class DeferredAction:
    action_id: str
    user_id: str
    device_id: str
    target_tool: str
    arguments: Dict[str, Any]
    created_at: datetime
    fire_at: datetime
    task: Optional[asyncio.Task] = None

    def public(self) -> Dict[str, Any]:
        return {
            "action_id": self.action_id,
            "target_tool": self.target_tool,
            "arguments": self.arguments,
            "created_at": self.created_at.isoformat(),
            "fire_at": self.fire_at.isoformat(),
        }


class DeferredActionRegistry:
    """Schedules one-shot actions while the API and device socket remain online."""

    def __init__(self, timezone: str) -> None:
        self.timezone = tz.gettz(timezone)
        if self.timezone is None:
            raise ValueError(f"unknown timezone: {timezone}")
        self._actions: Dict[str, DeferredAction] = {}
        self._lock = asyncio.Lock()

    def _now(self) -> datetime:
        return datetime.now(self.timezone)

    def _fire_at(self, delay_seconds: Optional[float], run_at: Optional[str]) -> datetime:
        has_delay = delay_seconds is not None
        has_run_at = bool((run_at or "").strip())
        if has_delay == has_run_at:
            raise ValueError("provide exactly one of delay_seconds or run_at")
        now = self._now()
        if delay_seconds is not None:
            delay = float(delay_seconds)
            if delay <= 0:
                raise ValueError("delay_seconds must be positive")
            return now + timedelta(seconds=delay)

        raw = str(run_at).strip()
        try:
            if ":" in raw and "T" not in raw and " " not in raw:
                parts = raw.split(":")
                if len(parts) not in {2, 3}:
                    raise ValueError
                hour, minute = int(parts[0]), int(parts[1])
                second = int(parts[2]) if len(parts) == 3 else 0
                candidate = now.replace(hour=hour, minute=minute, second=second, microsecond=0)
                if candidate <= now:
                    candidate += timedelta(days=1)
                return candidate
            candidate = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except (TypeError, ValueError) as exc:
            raise ValueError("run_at must be local HH:MM[:SS] or an ISO datetime") from exc
        if candidate.tzinfo is None:
            candidate = candidate.replace(tzinfo=self.timezone)
        candidate = candidate.astimezone(self.timezone)
        if candidate <= now:
            raise ValueError("run_at is in the past")
        return candidate

    async def schedule(
        self,
        *,
        user_id: str,
        device_id: str,
        target_tool: str,
        arguments: Dict[str, Any],
        delay_seconds: Optional[float],
        run_at: Optional[str],
        invoke: Invoke,
    ) -> Dict[str, Any]:
        created_at = self._now()
        fire_at = self._fire_at(delay_seconds, run_at)
        action = DeferredAction(
            action_id=uuid.uuid4().hex[:10],
            user_id=user_id,
            device_id=device_id,
            target_tool=target_tool,
            arguments=dict(arguments),
            created_at=created_at,
            fire_at=fire_at,
        )

        async def runner() -> None:
            try:
                await asyncio.sleep(max(0.0, (fire_at - self._now()).total_seconds()))
                await invoke()
                logger.info(
                    "deferred action completed id=%s tool=%s device=%s",
                    action.action_id,
                    target_tool,
                    device_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "deferred action failed id=%s tool=%s device=%s",
                    action.action_id,
                    target_tool,
                    device_id,
                )
            finally:
                async with self._lock:
                    self._actions.pop(action.action_id, None)

        async with self._lock:
            action.task = asyncio.create_task(runner(), name=f"deferred-action-{action.action_id}")
            self._actions[action.action_id] = action
        return action.public()

    async def list(self, user_id: str, device_id: str) -> List[Dict[str, Any]]:
        async with self._lock:
            actions = [
                action
                for action in self._actions.values()
                if action.user_id == user_id and action.device_id == device_id
            ]
        return [action.public() for action in sorted(actions, key=lambda value: value.fire_at)]

    async def cancel(
        self,
        user_id: str,
        device_id: str,
        action_id: Optional[str],
        query: Optional[str],
        cancel_all_matches: bool,
    ) -> Dict[str, Any]:
        exact = (action_id or "").strip()
        needle = (query or "").strip().casefold()
        if bool(exact) == bool(needle):
            raise ValueError("provide exactly one of action_id or query")
        async with self._lock:
            scoped = [
                action
                for action in self._actions.values()
                if action.user_id == user_id and action.device_id == device_id
            ]
            if exact:
                matches = [action for action in scoped if action.action_id == exact]
            else:
                matches = [
                    action
                    for action in scoped
                    if needle in action.target_tool.casefold()
                    or needle in str(action.arguments).casefold()
                ]
            if not matches:
                return {"cancelled": [], "error": "no matching deferred actions"}
            if len(matches) > 1 and not cancel_all_matches:
                return {
                    "cancelled": [],
                    "error": "multiple actions match; use an id or cancel_all_matches",
                    "matches": [action.public() for action in matches],
                }
            cancelled = [action.public() for action in matches]
            for action in matches:
                if action.task is not None:
                    action.task.cancel()
                self._actions.pop(action.action_id, None)
        return {"cancelled": cancelled}

    async def close(self) -> None:
        async with self._lock:
            tasks = [action.task for action in self._actions.values() if action.task]
            self._actions.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
