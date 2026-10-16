from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument, timeout
from pymongo.collection import Collection

from .models import TERMINAL_STATUSES, TaskRecord, TaskStatus, utc_now

DATABASE_TIMEOUT_SECONDS = 10
WRITE_TIMEOUT_SECONDS = 60
LOG_PREVIEW_CHARS = 4_000
RESULT_PREVIEW_BYTES = 32_000


def _text_preview(value: Any) -> dict[str, Any]:
    length = {"$strLenCP": value}
    return {
        "$cond": [
            {"$gt": [length, LOG_PREVIEW_CHARS]},
            {
                "$concat": [
                    "[earlier output omitted]\n",
                    {
                        "$substrCP": [
                            value,
                            {"$subtract": [length, LOG_PREVIEW_CHARS]},
                            LOG_PREVIEW_CHARS,
                        ]
                    },
                ]
            },
            value,
        ]
    }


def _agent_output_projection() -> dict[str, Any]:
    # Failed/interrupted agents can leave an array of *all* stream events here,
    # including tool output and thinking. Trimming stdout alone does not bound it.
    events = {"$cond": [{"$isArray": "$agent_output"}, "$agent_output", []]}
    results = {
        "$filter": {"input": events, "as": "event", "cond": {"$eq": ["$$event.type", "result"]}}
    }
    content = {"$cond": [{"$isArray": "$$this.message.content"}, "$$this.message.content", []]}
    message_text = {
        "$reduce": {
            "input": content,
            "initialValue": "",
            "in": {
                "$concat": [
                    "$$value",
                    {
                        "$cond": [
                            {"$eq": [{"$type": "$$this.text"}, "string"]},
                            "$$this.text",
                            "",
                        ]
                    },
                ]
            },
        }
    }
    text_tail = {
        "$substrCP": [
            "$$text",
            {"$max": [0, {"$subtract": [{"$strLenCP": "$$text"}, LOG_PREVIEW_CHARS]}]},
            LOG_PREVIEW_CHARS,
        ]
    }
    assistant_text = {
        "$reduce": {
            "input": events,
            "initialValue": "",
            "in": {
                "$cond": [
                    {"$eq": ["$$this.type", "assistant"]},
                    {
                        "$let": {
                            "vars": {"text": {"$concat": ["$$value", message_text]}},
                            "in": text_tail,
                        }
                    },
                    "$$value",
                ]
            },
        }
    }
    candidate = {
        "$cond": [
            {"$isArray": "$agent_output"},
            {
                "$cond": [
                    {"$gt": [{"$size": results}, 0]},
                    {"$arrayElemAt": [results, -1]},
                    {
                        "type": "transcript_preview",
                        "result": {
                            "$concat": [
                                "[Transcript preview; complete output retained in storage]\n",
                                assistant_text,
                            ]
                        },
                    },
                ]
            },
            {"$ifNull": ["$agent_output", None]},
        ]
    }
    return {
        "$let": {
            "vars": {"output": candidate},
            "in": {
                "$cond": [
                    {"$lte": [{"$bsonSize": {"value": "$$output"}}, RESULT_PREVIEW_BYTES]},
                    "$$output",
                    {
                        "type": "result_preview",
                        "result": _text_preview(
                            {
                                "$switch": {
                                    "branches": [
                                        {
                                            "case": {"$eq": [{"$type": "$$output"}, "string"]},
                                            "then": "$$output",
                                        },
                                        {
                                            "case": {
                                                "$eq": [{"$type": "$$output.result"}, "string"]
                                            },
                                            "then": "$$output.result",
                                        },
                                    ],
                                    "default": (
                                        "[Large structured output omitted; "
                                        "complete output retained in storage]"
                                    ),
                                }
                            }
                        ),
                    },
                ]
            },
        }
    }


def _task_projection() -> dict[str, Any]:
    # Bound transfers in MongoDB, before multi-megabyte transcripts cross the network.
    # Keep ordinary final results and metadata; never change stored transcripts.
    projection: dict[str, Any] = {field: 1 for field in TaskRecord.model_fields}
    projection["agent_output"] = _agent_output_projection()
    for field in ("stdout", "stderr"):
        value = {"$ifNull": [f"${field}", ""]}
        projection[field] = {
            "$cond": [
                {"$eq": [{"$ifNull": [f"${field}", None]}, None]},
                None,
                _text_preview(value),
            ]
        }
    return projection


class TaskNotFoundError(KeyError):
    pass


class TaskRepository:
    def __init__(self, mongo_uri: str, database: str, collection: str) -> None:
        self._client: MongoClient[dict[str, Any]] = MongoClient(
            mongo_uri,
            appname="jarvis-code-factory",
            serverSelectionTimeoutMS=3_000,
            timeoutMS=DATABASE_TIMEOUT_SECONDS * 1_000,
        )
        self._tasks: Collection[dict[str, Any]] = self._client[database][collection]

    async def initialize(self) -> None:
        await self.ping()
        await asyncio.to_thread(
            self._tasks.create_index,
            [("created_at", DESCENDING)],
            name="created_at_desc",
        )
        await asyncio.to_thread(
            self._tasks.create_index,
            [("status", ASCENDING), ("updated_at", DESCENDING)],
            name="status_updated_at",
        )
        await asyncio.to_thread(
            self._tasks.create_index,
            [("status", ASCENDING), ("created_at", DESCENDING)],
            name="status_created_at",
        )

    async def ping(self) -> None:
        await asyncio.to_thread(self._client.admin.command, "ping")
        await asyncio.to_thread(self._tasks.find_one, {}, {"_id": 1})

    async def close(self) -> None:
        await asyncio.to_thread(self._client.close)

    async def create(self, *, prompt: str, repository: str, model: str | None = None) -> TaskRecord:
        task_id = str(uuid4())
        now = utc_now()
        document: dict[str, Any] = {
            "_id": task_id,
            "id": task_id,
            "prompt": prompt,
            "model": model,
            "repository": repository,
            "status": TaskStatus.PENDING.value,
            "workflow_id": f"code-factory-{task_id}",
            "created_at": now,
            "updated_at": now,
            "started_at": None,
            "completed_at": None,
            "exit_code": None,
            "agent_output": None,
            "stdout": None,
            "stderr": None,
            "error": None,
            "changed_paths": [],
            "self_update_scheduled": False,
        }
        await asyncio.to_thread(self._tasks.insert_one, document)
        return TaskRecord.model_validate(document)

    async def get(self, task_id: str) -> TaskRecord:
        document = await asyncio.to_thread(
            self._tasks.find_one, {"_id": task_id}, _task_projection()
        )
        if document is None:
            raise TaskNotFoundError(task_id)
        return TaskRecord.model_validate(document)

    async def list(self, *, limit: int, status: TaskStatus | None) -> list[TaskRecord]:
        query = {} if status is None else {"status": status.value}

        def fetch() -> list[dict[str, Any]]:
            with timeout(DATABASE_TIMEOUT_SECONDS):
                cursor = (
                    self._tasks.find(query, _task_projection())
                    .sort("created_at", DESCENDING)
                    .limit(limit)
                )
                return list(cursor)

        return [TaskRecord.model_validate(item) for item in await asyncio.to_thread(fetch)]

    async def list_active(self) -> list[TaskRecord]:
        def fetch() -> list[dict[str, Any]]:
            with timeout(DATABASE_TIMEOUT_SECONDS):
                return list(
                    self._tasks.find(
                        {"status": {"$nin": list(TERMINAL_STATUSES)}}, _task_projection()
                    )
                )

        return [TaskRecord.model_validate(item) for item in await asyncio.to_thread(fetch)]

    async def update(self, task_id: str, **fields: Any) -> TaskRecord:
        fields["updated_at"] = utc_now()

        def persist() -> dict[str, Any] | None:
            with timeout(WRITE_TIMEOUT_SECONDS):
                return self._tasks.find_one_and_update(
                    {"_id": task_id},
                    {"$set": fields},
                    return_document=ReturnDocument.AFTER,
                    projection=_task_projection(),
                )

        result = await asyncio.to_thread(persist)
        if result is None:
            raise TaskNotFoundError(task_id)
        return TaskRecord.model_validate(result)

    async def set_status(
        self,
        task_id: str,
        status: TaskStatus,
        *,
        at: datetime | None = None,
        **fields: Any,
    ) -> TaskRecord:
        now = at or utc_now()
        fields["status"] = status.value
        if status is TaskStatus.RUNNING:
            fields["started_at"] = now
        if status in {TaskStatus.CANCELLED, TaskStatus.SUCCESS, TaskStatus.FAILED}:
            fields["completed_at"] = now
        # Terminal records must survive late activity writes, cancellation races,
        # and startup reconciliation. Queue acknowledgments cannot regress RUNNING.
        allowed = {
            TaskStatus.QUEUED: [TaskStatus.PENDING],
            TaskStatus.RUNNING: [TaskStatus.PENDING, TaskStatus.QUEUED],
        }.get(status, [s for s in TaskStatus if s not in TERMINAL_STATUSES])
        fields["updated_at"] = now

        def persist() -> dict[str, Any] | None:
            with timeout(WRITE_TIMEOUT_SECONDS):
                return self._tasks.find_one_and_update(
                    {"_id": task_id, "status": {"$in": allowed}},
                    {"$set": fields},
                    return_document=ReturnDocument.AFTER,
                    projection=_task_projection(),
                )

        result = await asyncio.to_thread(persist)
        return TaskRecord.model_validate(result) if result else await self.get(task_id)
