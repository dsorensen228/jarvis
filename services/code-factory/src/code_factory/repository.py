from __future__ import annotations

import asyncio
import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument, timeout
from pymongo.collection import Collection

from .models import (
    TERMINAL_STATUSES,
    OutputPage,
    ResearchVerbosity,
    TaskPage,
    TaskRecord,
    TaskStatus,
    TaskType,
    TaskView,
    utc_now,
)

DATABASE_TIMEOUT_SECONDS = 10
WRITE_TIMEOUT_SECONDS = 60
LOG_PREVIEW_CHARS = 4_000
RESULT_PREVIEW_BYTES = 32_000
MAX_OUTPUT_EVENTS = 300
MAX_EVENT_TEXT = 2_000


class InvalidCursorError(ValueError):
    pass


def _encode_cursor(
    task: TaskRecord, status: TaskStatus | None, view: TaskView, task_type: TaskType = "code"
) -> str:
    value = [task.created_at.isoformat(), task.id, status, view, task_type]
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def _decode_cursor(
    cursor: str, status: TaskStatus | None, view: TaskView, task_type: TaskType = "code"
) -> tuple[datetime, str]:
    try:
        if len(cursor) > 1024:
            raise ValueError
        value = json.loads(
            base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        )
        if not isinstance(value, list) or len(value) != 5 or value[2:] != [status, view, task_type]:
            raise ValueError
        created = datetime.fromisoformat(value[0])
        created = created.replace(tzinfo=UTC) if created.tzinfo is None else created.astimezone(UTC)
        if not isinstance(value[1], str) or not 1 <= len(value[1]) <= 100:
            raise ValueError
        return created, value[1]
    except (ValueError, TypeError, binascii.Error) as exc:
        raise InvalidCursorError("Invalid cursor for this task filter") from exc


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
    projection: dict[str, Any] = {
        field: 1 for field in TaskRecord.model_fields if field != "report_html"
    }
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


def _task_type_query(task_type: TaskType) -> dict[str, Any]:
    if task_type == "code":
        return {"$or": [{"task_type": "code"}, {"task_type": {"$exists": False}}]}
    return {"task_type": task_type}


class TaskRepository:
    def __init__(self, mongo_uri: str, database: str, collection: str) -> None:
        self._client: MongoClient[dict[str, Any]] = MongoClient(
            mongo_uri,
            appname="jarvis-code-factory",
            serverSelectionTimeoutMS=3_000,
            timeoutMS=DATABASE_TIMEOUT_SECONDS * 1_000,
            tz_aware=True,
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
        await asyncio.to_thread(
            self._tasks.create_index,
            [("created_at", DESCENDING), ("_id", DESCENDING)],
            name="task_pages",
        )
        await asyncio.to_thread(
            self._tasks.create_index,
            [("status", ASCENDING), ("created_at", DESCENDING), ("_id", DESCENDING)],
            name="status_task_pages",
        )

    async def ping(self) -> None:
        await asyncio.to_thread(self._client.admin.command, "ping")
        await asyncio.to_thread(self._tasks.find_one, {}, {"_id": 1})

    async def close(self) -> None:
        await asyncio.to_thread(self._client.close)

    async def create(
        self,
        *,
        prompt: str,
        repository: str,
        model: str | None = None,
        parent_task_id: str | None = None,
        task_type: TaskType = "code",
        verbosity: ResearchVerbosity = "standard",
    ) -> TaskRecord:
        task_id = str(uuid4())
        now = utc_now()
        document: dict[str, Any] = {
            "_id": task_id,
            "id": task_id,
            "prompt": prompt,
            "model": model,
            "task_type": task_type,
            "verbosity": verbosity,
            "report_available": False,
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
            "parent_task_id": parent_task_id,
            "output_seq": 0,
            "output_events": [],
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

    async def get_report(self, task_id: str) -> dict[str, str]:
        document = await asyncio.to_thread(
            self._tasks.find_one,
            {
                "_id": task_id,
                "task_type": "research",
                "status": TaskStatus.SUCCESS.value,
                "report_available": True,
            },
            {"report_html": 1},
        )
        html = document.get("report_html") if document else None
        if not isinstance(html, str) or not html.strip():
            raise TaskNotFoundError(task_id)
        return {"task_id": task_id, "html": html}

    async def list(
        self, *, limit: int, status: TaskStatus | None, task_type: TaskType = "code"
    ) -> list[TaskRecord]:
        query = _task_type_query(task_type)
        if status is not None:
            query["status"] = status.value

        def fetch() -> list[dict[str, Any]]:
            with timeout(DATABASE_TIMEOUT_SECONDS):
                cursor = (
                    self._tasks.find(query, _task_projection())
                    .sort("created_at", DESCENDING)
                    .limit(limit)
                )
                return list(cursor)

        return [TaskRecord.model_validate(item) for item in await asyncio.to_thread(fetch)]

    async def list_page(
        self,
        *,
        limit: int,
        status: TaskStatus | None,
        cursor: str | None = None,
        view: TaskView = "all",
        task_type: TaskType = "code",
    ) -> TaskPage:
        query = _task_type_query(task_type)
        if status is not None:
            query["status"] = status.value
        if view != "all" and status is not None:
            raise InvalidCursorError("Use either status or view, not both")
        if view != "all":
            query["status"] = {"$in" if view == "history" else "$nin": list(TERMINAL_STATUSES)}
        if cursor is not None:
            created, task_id = _decode_cursor(cursor, status, view, task_type)
            query = {
                "$and": [
                    query,
                    {
                        "$or": [
                            {"created_at": {"$lt": created}},
                            {"created_at": created, "_id": {"$lt": task_id}},
                        ]
                    },
                ]
            }

        def fetch() -> list[dict[str, Any]]:
            with timeout(DATABASE_TIMEOUT_SECONDS):
                return list(
                    self._tasks.find(query, _task_projection())
                    .sort([("created_at", DESCENDING), ("_id", DESCENDING)])
                    .limit(limit + 1)
                )

        records = [TaskRecord.model_validate(item) for item in await asyncio.to_thread(fetch)]
        items = records[:limit]
        return TaskPage(
            items=items,
            next_cursor=(
                _encode_cursor(items[-1], status, view, task_type) if len(records) > limit else None
            ),
        )

    async def append_output(self, task_id: str, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        # A single Mongo update allocates sequence IDs and trims retention atomically.
        # Separate arrays avoid exposing raw CLI events or chain-of-thought in the API.
        now = utc_now()
        safe_events = [
            {"kind": event["kind"], "text": str(event["text"])[-MAX_EVENT_TEXT:], "created_at": now}
            for event in events[-MAX_OUTPUT_EVENTS:]
        ]
        previous = {"$ifNull": ["$output_seq", 0]}
        numbered = {
            "$map": {
                "input": {"$range": [0, len(safe_events)]},
                "as": "index",
                "in": {
                    "$mergeObjects": [
                        {"$arrayElemAt": [{"$literal": safe_events}, "$$index"]},
                        {"seq": {"$add": [previous, "$$index", 1]}},
                    ]
                },
            }
        }
        result = await asyncio.to_thread(
            self._tasks.update_one,
            {"_id": task_id},
            [
                {
                    "$set": {
                        "output_seq": {"$add": [previous, len(safe_events)]},
                        "output_events": {
                            "$slice": [
                                {"$concatArrays": [{"$ifNull": ["$output_events", []]}, numbered]},
                                -MAX_OUTPUT_EVENTS,
                            ]
                        },
                        "updated_at": now,
                    }
                }
            ],
        )
        if not result.matched_count:
            raise TaskNotFoundError(task_id)

    async def output(self, task_id: str, *, after: int, limit: int) -> OutputPage:
        projection = _task_projection()
        # Apply the cursor and page bound in MongoDB. Idle subscribers should not
        # download the entire retained transcript on every one-second stream poll.
        projection["output_events"] = {
            "$let": {
                "vars": {
                    "fresh": {
                        "$filter": {
                            "input": {"$ifNull": ["$output_events", []]},
                            "as": "event",
                            "cond": {"$gt": ["$$event.seq", min(after, 2**63 - 1)]},
                        }
                    }
                },
                "in": {"$slice": ["$$fresh", limit + 1]},
            }
        }
        projection["_output_first_seq"] = {
            "$ifNull": [{"$arrayElemAt": ["$output_events.seq", 0]}, None]
        }
        document = await asyncio.to_thread(self._tasks.find_one, {"_id": task_id}, projection)
        if document is None:
            raise TaskNotFoundError(task_id)
        task = TaskRecord.model_validate(document)
        fresh = document["output_events"]
        first_seq = document["_output_first_seq"]
        items = fresh[:limit]
        return OutputPage(
            items=items,
            next_after=items[-1]["seq"] if items else task.output_seq,
            has_more=len(fresh) > limit,
            truncated=first_seq is not None and after < first_seq - 1,
            task=task,
        )

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
