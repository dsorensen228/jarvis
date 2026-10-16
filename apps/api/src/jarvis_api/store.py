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

    async def save_device(
        self,
        owner_id: str,
        data: Dict[str, Any],
        *,
        device_id: Optional[str] = None,
        create: bool = False,
        reported: bool = False,
        encrypted_callback_token: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Save settings and an optional sealed callback credential in one transaction."""
        new_id = device_id is None
        device_id = device_id or uuid.uuid4().hex
        async with self._write_lock:
            current = await self.get_entity("device", device_id, owner_id)
            if current is None and (
                not (new_id or create) or await self.get_entity("device", device_id) is not None
            ):
                return None
            now = utc_now_iso()
            created_at = current["created_at"] if current else now
            value = {
                key: item
                for key, item in (current or {}).items()
                if key not in {"id", "created_at", "updated_at"}
            }
            metadata = dict(value.get("metadata") or {})
            overrides = dict(metadata.get("settings_overrides") or {})
            incoming = dict(data.get("metadata") or {})
            if reported:
                # Device reports own telemetry, not the owner's saved preferences.
                for key in (
                    "settings_overrides",
                    "describe_scene_prompt",
                    "is_main_describe_camera",
                    "doorbell_alerts_enabled",
                    "acting_user_id",
                    "most_recent_conversation",
                ):
                    incoming.pop(key, None)
            metadata.update(incoming)
            for key, item in data.items():
                if key in {"id", "created_at", "updated_at", "metadata", "callback_token"}:
                    continue
                if reported and key in {"name", "room", "base_url"} and overrides.get(key):
                    continue
                value[key] = item
                if not reported and key in {"name", "room", "base_url"}:
                    overrides[key] = True
            if encrypted_callback_token is not None and not reported:
                overrides["callback_token"] = True
            if overrides:
                metadata["settings_overrides"] = overrides
            if value.get("kind") != "camera":
                metadata["is_main_describe_camera"] = False
            value["metadata"] = metadata
            try:
                if metadata.get("is_main_describe_camera") is True:
                    await self.db.execute(
                        "UPDATE entities SET data=json_set(data, "
                        "'$.metadata.is_main_describe_camera', "
                        "json('false')), updated_at=? WHERE kind='device' AND owner_id=? AND id!=? "
                        "AND json_extract(data, '$.kind')='camera' "
                        "AND json_extract(data, '$.metadata.is_main_describe_camera')=1",
                        (now, owner_id, device_id),
                    )
                await self.db.execute(
                    "INSERT INTO entities(kind,id,owner_id,data,created_at,updated_at) "
                    "VALUES('device',?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET "
                    "data=excluded.data,updated_at=excluded.updated_at "
                    "WHERE entities.owner_id=excluded.owner_id",
                    (device_id, owner_id, json.dumps(value), created_at, now),
                )
                if encrypted_callback_token is not None and not (
                    reported and overrides.get("callback_token")
                ):
                    await self.db.execute(
                        "INSERT INTO secrets(namespace,key,owner_id,value,expires_at) "
                        "VALUES('device_callback',?,?,?,NULL) "
                        "ON CONFLICT(namespace,key) DO UPDATE SET "
                        "value=excluded.value,expires_at=NULL "
                        "WHERE secrets.owner_id=excluded.owner_id",
                        (device_id, owner_id, encrypted_callback_token),
                    )
                await self.db.commit()
            except BaseException:
                await self.db.rollback()
                raise
            return {**value, "id": device_id, "created_at": created_at, "updated_at": now}

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
        self, kind: str, owner_id: str, limit: int = 200, *, exclude_source: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM entities WHERE kind=? AND owner_id=?"
        values: List[Any] = [kind, owner_id]
        if exclude_source is not None:
            sql += " AND COALESCE(json_extract(data, '$.source'), '') != ?"
            values.append(exclude_source)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        values.append(limit)
        cursor = await self.db.execute(sql, values)
        rows = await cursor.fetchall()
        await cursor.close()
        return [self._entity(row) for row in rows]

    async def list_all_entities(
        self, kind: str, limit: int = 1000, *, status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM entities WHERE kind=?"
        values: List[Any] = [kind]
        if status is not None:
            sql += " AND json_extract(data, '$.status')=?"
            values.append(status)
        sql += " ORDER BY updated_at " + ("ASC" if status is not None else "DESC") + " LIMIT ?"
        values.append(limit)
        cursor = await self.db.execute(sql, values)
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
            # Commit the transcript and its sidebar metadata together. Failed or
            # interrupted turns still have a durable user message to account for.
            conversation = await self.get_entity("conversation", conversation_id, owner_id)
            if conversation is not None:
                cursor = await self.db.execute(
                    "SELECT COUNT(*) FROM messages WHERE owner_id=? AND conversation_id=?",
                    (owner_id, conversation_id),
                )
                row = await cursor.fetchone()
                await cursor.close()
                data = {
                    key: value
                    for key, value in conversation.items()
                    if key not in {"id", "created_at", "updated_at"}
                }
                data.update(message_count=row[0], last_message=content[:300])
                await self.db.execute(
                    "UPDATE entities SET data=?,updated_at=? WHERE kind=? AND id=? AND owner_id=?",
                    (json.dumps(data), created_at, "conversation", conversation_id, owner_id),
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

    async def delete_all_conversations(
        self, owner_id: str, *, exclude_source: Optional[str] = None
    ) -> int:
        """Clear matching transcripts atomically, preserving any excluded source."""
        selection = "kind='conversation' AND owner_id=?"
        values: List[Any] = [owner_id]
        if exclude_source is not None:
            selection += " AND COALESCE(json_extract(data, '$.source'), '') != ?"
            values.append(exclude_source)
        async with self._write_lock:
            try:
                if exclude_source is None:
                    await self.db.execute("DELETE FROM messages WHERE owner_id=?", (owner_id,))
                else:
                    await self.db.execute(
                        "DELETE FROM messages WHERE owner_id=? AND conversation_id IN "
                        f"(SELECT id FROM entities WHERE {selection})",
                        [owner_id, *values],
                    )
                cursor = await self.db.execute(f"DELETE FROM entities WHERE {selection}", values)
                deleted = cursor.rowcount
                await cursor.close()
                await self.db.commit()
            except BaseException:
                await self.db.rollback()
                raise
        return deleted

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
