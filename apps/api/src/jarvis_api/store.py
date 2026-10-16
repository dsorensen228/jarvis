"""Small async SQLite store for Jarvis domain entities and conversation messages."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Callable, Dict, List, Optional

import aiosqlite

from jarvis_api.domain import utc_now_iso


class StoreNotStarted(RuntimeError):
    pass


class SqliteStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._db: Optional[aiosqlite.Connection] = None
        self._write_lock = asyncio.Lock()

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise StoreNotStarted("store has not been started")
        return self._db

    async def start(self) -> None:
        self._db = await aiosqlite.connect(self.path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS entities (
                kind TEXT NOT NULL,
                id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            );
            CREATE INDEX IF NOT EXISTS idx_entities_owner_kind
                ON entities(owner_id, kind, updated_at DESC);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(owner_id, conversation_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS secrets (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                value TEXT NOT NULL,
                expires_at TEXT,
                PRIMARY KEY (namespace, key)
            );
            CREATE INDEX IF NOT EXISTS idx_secrets_owner
                ON secrets(owner_id, namespace);
            """
        )
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @staticmethod
    def _entity(row: aiosqlite.Row) -> Dict[str, Any]:
        data = json.loads(row["data"])
        data.update(
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
        return data

    async def create_entity(
        self,
        kind: str,
        owner_id: str,
        data: Dict[str, Any],
        entity_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = utc_now_iso()
        entity_id = entity_id or uuid.uuid4().hex
        reserved = {"id", "created_at", "updated_at"}
        clean = {key: value for key, value in data.items() if key not in reserved}
        async with self._write_lock:
            await self.db.execute(
                """INSERT INTO entities(kind,id,owner_id,data,created_at,updated_at)
                   VALUES(?,?,?,?,?,?)""",
                (kind, entity_id, owner_id, json.dumps(clean), now, now),
            )
            await self.db.commit()
        return {**clean, "id": entity_id, "created_at": now, "updated_at": now}

    async def get_entity(
        self, kind: str, entity_id: str, owner_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        sql = "SELECT * FROM entities WHERE kind=? AND id=?"
        values: List[Any] = [kind, entity_id]
        if owner_id is not None:
            sql += " AND owner_id=?"
            values.append(owner_id)
        cursor = await self.db.execute(sql, values)
        row = await cursor.fetchone()
        await cursor.close()
        return self._entity(row) if row else None

    async def list_entities(
        self, kind: str, owner_id: str, limit: int = 200
    ) -> List[Dict[str, Any]]:
        cursor = await self.db.execute(
            "SELECT * FROM entities WHERE kind=? AND owner_id=? ORDER BY updated_at DESC LIMIT ?",
            (kind, owner_id, limit),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [self._entity(row) for row in rows]

    async def list_all_entities(self, kind: str, limit: int = 1000) -> List[Dict[str, Any]]:
        cursor = await self.db.execute(
            "SELECT * FROM entities WHERE kind=? ORDER BY updated_at DESC LIMIT ?", (kind, limit)
        )
        rows = await cursor.fetchall()
        await cursor.close()
        result = []
        for row in rows:
            item = self._entity(row)
            item["owner_id"] = row["owner_id"]
            result.append(item)
        return result

    async def update_entity(
        self, kind: str, entity_id: str, owner_id: str, patch: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        async with self._write_lock:
            current = await self.get_entity(kind, entity_id, owner_id)
            if current is None:
                return None
            created_at = current.pop("created_at")
            current.pop("updated_at", None)
            current.pop("id", None)
            for key, value in patch.items():
                if value is not None:
                    current[key] = value
            now = utc_now_iso()
            await self.db.execute(
                "UPDATE entities SET data=?,updated_at=? WHERE kind=? AND id=? AND owner_id=?",
                (json.dumps(current), now, kind, entity_id, owner_id),
            )
            await self.db.commit()
        return {**current, "id": entity_id, "created_at": created_at, "updated_at": now}

    async def mutate_entity(
        self,
        kind: str,
        entity_id: str,
        owner_id: str,
        mutator: Callable[[Dict[str, Any]], Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        async with self._write_lock:
            current = await self.get_entity(kind, entity_id, owner_id)
            if current is None:
                return None
            created_at = current.pop("created_at")
            current.pop("updated_at", None)
            current.pop("id", None)
            updated = mutator(current)
            now = utc_now_iso()
            await self.db.execute(
                "UPDATE entities SET data=?,updated_at=? WHERE kind=? AND id=? AND owner_id=?",
                (json.dumps(updated), now, kind, entity_id, owner_id),
            )
            await self.db.commit()
        return {**updated, "id": entity_id, "created_at": created_at, "updated_at": now}

    async def delete_entity(self, kind: str, entity_id: str, owner_id: str) -> bool:
        async with self._write_lock:
            cursor = await self.db.execute(
                "DELETE FROM entities WHERE kind=? AND id=? AND owner_id=?",
                (kind, entity_id, owner_id),
            )
            await self.db.commit()
            deleted = cursor.rowcount > 0
            await cursor.close()
        return deleted

    async def add_message(
        self,
        owner_id: str,
        conversation_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        message_id = uuid.uuid4().hex
        created_at = utc_now_iso()
        metadata = metadata or {}
        async with self._write_lock:
            await self.db.execute(
                "INSERT INTO messages VALUES(?,?,?,?,?,?,?)",
                (
                    message_id,
                    conversation_id,
                    owner_id,
                    role,
                    content,
                    json.dumps(metadata),
                    created_at,
                ),
            )
            await self.db.commit()
        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "metadata": metadata,
            "created_at": created_at,
        }

    async def list_messages(
        self, owner_id: str, conversation_id: str, limit: int = 100
    ) -> List[Dict[str, Any]]:
        cursor = await self.db.execute(
            """
            SELECT * FROM (
              SELECT * FROM messages WHERE owner_id=? AND conversation_id=?
              ORDER BY created_at DESC LIMIT ?
            ) ORDER BY created_at ASC
            """,
            (owner_id, conversation_id, limit),
        )
        rows = await cursor.fetchall()
        await cursor.close()
        return [
            {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "role": row["role"],
                "content": row["content"],
                "metadata": json.loads(row["metadata"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    async def delete_messages(self, owner_id: str, conversation_id: str) -> None:
        async with self._write_lock:
            await self.db.execute(
                "DELETE FROM messages WHERE owner_id=? AND conversation_id=?",
                (owner_id, conversation_id),
            )
            await self.db.commit()

    async def put_secret(
        self,
        namespace: str,
        key: str,
        owner_id: str,
        value: str,
        expires_at: Optional[str] = None,
    ) -> None:
        async with self._write_lock:
            await self.db.execute(
                """
                INSERT INTO secrets(namespace,key,owner_id,value,expires_at) VALUES(?,?,?,?,?)
                ON CONFLICT(namespace,key) DO UPDATE SET
                  owner_id=excluded.owner_id,value=excluded.value,expires_at=excluded.expires_at
                """,
                (namespace, key, owner_id, value, expires_at),
            )
            await self.db.commit()

    async def get_secret(self, namespace: str, key: str) -> Optional[Dict[str, Any]]:
        cursor = await self.db.execute(
            "SELECT * FROM secrets WHERE namespace=? AND key=?", (namespace, key)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return dict(row) if row else None

    async def delete_secret(self, namespace: str, key: str) -> None:
        async with self._write_lock:
            await self.db.execute(
                "DELETE FROM secrets WHERE namespace=? AND key=?", (namespace, key)
            )
            await self.db.commit()
