"""In-memory fan-out for connected clients; durable state remains in SQLite."""

from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from typing import Any, DefaultDict, Dict

from fastapi import WebSocket


class EventHub:
    def __init__(self) -> None:
        self._connections: DefaultDict[str, Dict[str, WebSocket]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: str, websocket: WebSocket) -> str:
        connection_id = uuid.uuid4().hex
        async with self._lock:
            self._connections[user_id][connection_id] = websocket
        return connection_id

    async def disconnect(self, user_id: str, connection_id: str) -> None:
        async with self._lock:
            self._connections[user_id].pop(connection_id, None)
            if not self._connections[user_id]:
                self._connections.pop(user_id, None)

    async def publish(self, user_id: str, event: str, data: Dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._connections.get(user_id, {}).items())
        stale = []
        payload = {"type": event, "data": data}
        for connection_id, websocket in targets:
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(connection_id)
        for connection_id in stale:
            await self.disconnect(user_id, connection_id)
