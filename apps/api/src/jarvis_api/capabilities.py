"""Application services shared by HTTP routes and Jarvis tools."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from jarvis_api.domain import utc_now
from jarvis_api.store import SqliteStore


class Capabilities:
    def __init__(self, store: SqliteStore) -> None:
        self.store = store

    async def list_todos(
        self, user_id: str, include_completed: bool = True
    ) -> List[Dict[str, Any]]:
        rows = await self.store.list_entities("todo", user_id)
        if not include_completed:
            rows = [row for row in rows if not row.get("completed")]
        return rows

    async def create_todo(self, user_id: str, title: str, category: str = "") -> Dict[str, Any]:
        return await self.store.create_entity(
            "todo",
            user_id,
            {"title": title.strip(), "category": category.strip(), "completed": False},
        )

    async def list_shopping_lists(self, user_id: str) -> List[Dict[str, Any]]:
        return await self.store.list_entities("shopping_list", user_id)

    async def create_shopping_list(self, user_id: str, name: str) -> Dict[str, Any]:
        return await self.store.create_entity(
            "shopping_list", user_id, {"name": name.strip(), "items": []}
        )

    async def add_shopping_items(
        self, user_id: str, list_id: str, items: List[str]
    ) -> Optional[Dict[str, Any]]:
        def add(current: Dict[str, Any]) -> Dict[str, Any]:
            current_items = list(current.get("items", []))
            for text in items:
                clean = text.strip()
                if clean:
                    current_items.append({"id": uuid.uuid4().hex, "text": clean, "checked": False})
            current["items"] = current_items
            return current

        return await self.store.mutate_entity("shopping_list", list_id, user_id, add)

    async def list_timers(self, user_id: str) -> List[Dict[str, Any]]:
        timers = await self.store.list_entities("timer", user_id)
        return [self.materialize_timer(timer) for timer in timers]

    async def create_timer(self, user_id: str, label: str, duration_seconds: int) -> Dict[str, Any]:
        now = utc_now()
        return await self.store.create_entity(
            "timer",
            user_id,
            {
                "label": label.strip(),
                "duration_seconds": duration_seconds,
                "remaining_seconds": duration_seconds,
                "status": "running",
                "started_at": now.isoformat(),
                "fire_at": (now + timedelta(seconds=duration_seconds)).isoformat(),
            },
        )

    @staticmethod
    def materialize_timer(timer: Dict[str, Any]) -> Dict[str, Any]:
        if timer.get("status") != "running" or not timer.get("fire_at"):
            return timer
        remaining = 0
        try:
            fire_at = datetime.fromisoformat(timer["fire_at"])
            remaining = max(0, int((fire_at - utc_now()).total_seconds()))
        except (ValueError, TypeError):
            pass
        copy = dict(timer)
        copy["remaining_seconds"] = remaining
        if remaining == 0:
            copy["status"] = "completed"
        return copy

    async def list_projects(self, user_id: str) -> List[Dict[str, Any]]:
        return await self.store.list_entities("project", user_id)

    async def create_project(
        self, user_id: str, title: str, description: str = ""
    ) -> Dict[str, Any]:
        return await self.store.create_entity(
            "project",
            user_id,
            {"title": title.strip(), "description": description, "status": ""},
        )

    async def search_assets(
        self, user_id: str, query: str, project_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        words = [word.lower() for word in query.split() if word]
        rows = await self.store.list_entities("asset", user_id, limit=1000)
        results = []
        for row in rows:
            if project_id and row.get("project_id") != project_id:
                continue
            haystack = " ".join(
                [
                    str(row.get("title", "")),
                    str(row.get("body", "")),
                    " ".join(row.get("keywords", [])),
                ]
            ).lower()
            if all(word in haystack for word in words):
                result = dict(row)
                body = result.get("body", "")
                if len(body) > 500:
                    result["body"] = body[:500] + "…"
                results.append(result)
        return results[:25]

    async def list_memories(self, user_id: str) -> List[Dict[str, Any]]:
        return await self.store.list_entities("memory", user_id, limit=1000)

    async def create_memory(
        self, user_id: str, content: str, category: str = "general"
    ) -> Dict[str, Any]:
        return await self.store.create_entity(
            "memory",
            user_id,
            {"content": content.strip(), "category": category.strip() or "general"},
        )

    async def search_memories(
        self, user_id: str, query: str, limit: int = 8
    ) -> List[Dict[str, Any]]:
        memories = await self.list_memories(user_id)
        words = {word.lower() for word in query.split() if len(word) > 2}
        if not words:
            return memories[:limit]
        scored = []
        for memory in memories:
            haystack = f"{memory.get('category', '')} {memory.get('content', '')}".lower()
            score = sum(1 for word in words if word in haystack)
            if score:
                scored.append((score, memory.get("updated_at", ""), memory))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in scored[:limit]]

    async def memory_context(self, user_id: str, query: str) -> str:
        memories = await self.search_memories(user_id, query)
        if not memories:
            return ""
        compact = [
            {"category": item.get("category", "general"), "content": item.get("content", "")}
            for item in memories
        ]
        return "Relevant owner memories:\n" + json.dumps(compact, ensure_ascii=False)

    async def conversation_context(self, user_id: str, conversation_id: str) -> str:
        conversation = await self.store.get_entity("conversation", conversation_id, user_id)
        if not conversation:
            return ""
        project_id = conversation.get("project_id")
        if not project_id:
            return ""
        project = await self.store.get_entity("project", project_id, user_id)
        if not project:
            return ""
        return f"Active project:\n{json.dumps(project, ensure_ascii=False)}"
