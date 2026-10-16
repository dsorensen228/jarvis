"""Local timer scheduler replacing Google Cloud Tasks."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Optional

from jarvis_api.domain import utc_now
from jarvis_api.events import EventHub
from jarvis_api.store import SqliteStore


class TimerScheduler:
    def __init__(self, store: SqliteStore, events: EventHub, poll_seconds: float) -> None:
        self.store = store
        self.events = events
        self.poll_seconds = poll_seconds
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self) -> None:
        while not self._stop.is_set():
            await self._tick()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
            except asyncio.TimeoutError:
                pass

    async def _tick(self) -> None:
        for timer in await self.store.list_all_entities("timer"):
            if timer.get("status") != "running" or not timer.get("fire_at"):
                continue
            try:
                expired = datetime.fromisoformat(timer["fire_at"]) <= utc_now()
            except (TypeError, ValueError):
                continue
            if not expired:
                continue
            owner_id = timer.pop("owner_id")
            updated = await self.store.update_entity(
                "timer",
                timer["id"],
                owner_id,
                {"status": "completed", "remaining_seconds": 0, "fire_at": None},
            )
            if updated:
                await self.events.publish(owner_id, "timer.expired", updated)
