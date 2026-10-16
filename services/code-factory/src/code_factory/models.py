from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TaskStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    SUCCESS = "success"
    FAILED = "failed"


TERMINAL_STATUSES = {TaskStatus.CANCELLED, TaskStatus.SUCCESS, TaskStatus.FAILED}
TaskType = Literal["code", "research"]
ResearchVerbosity = Literal["concise", "standard", "in_depth"]

# Codex CLI model IDs selectable from the Code Factory UI surfaces.
AGENT_MODELS: tuple[str, ...] = (
    "gpt-6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
)


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(min_length=1, max_length=32_000)
    model: str
    task_type: TaskType = "code"
    verbosity: ResearchVerbosity = "standard"

    @field_validator("prompt")
    @classmethod
    def prompt_must_contain_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("prompt must contain non-whitespace text")
        return stripped

    @field_validator("model")
    @classmethod
    def model_must_be_supported(cls, value: str) -> str:
        if value not in AGENT_MODELS:
            raise ValueError(f"model must be one of: {', '.join(AGENT_MODELS)}")
        return value


class FollowUpRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=32_000)
    model: str | None = None

    _prompt = field_validator("prompt")(CreateTaskRequest.prompt_must_contain_text.__func__)

    @field_validator("model")
    @classmethod
    def supported_model(cls, value: str | None) -> str | None:
        if value is not None and value not in AGENT_MODELS:
            raise ValueError(f"model must be one of: {', '.join(AGENT_MODELS)}")
        return value


class TaskRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    prompt: str
    model: str | None = None
    task_type: TaskType = "code"
    verbosity: ResearchVerbosity = "standard"
    report_available: bool = False
    report_html: str | None = Field(default=None, exclude=True, repr=False)
    repository: str = "workspace"
    status: TaskStatus
    workflow_id: str
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    exit_code: int | None = None
    agent_output: Any | None = None
    stdout: str | None = None
    stderr: str | None = None
    error: str | None = None
    changed_paths: list[str] = Field(default_factory=list)
    self_update_scheduled: bool = False
    parent_task_id: str | None = None
    output_seq: int = 0

    @field_validator("created_at", "updated_at", "started_at", "completed_at")
    @classmethod
    def timestamps_are_utc(cls, value: datetime | None) -> datetime | None:
        # Historical Mongo reads returned naive datetimes, which browsers interpret
        # as local wall time. Mongo dates are UTC; always declare that on the wire.
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


TaskView = Literal["all", "active", "history"]


class TaskPage(BaseModel):
    items: list[TaskRecord]
    next_cursor: str | None = None


class OutputEvent(BaseModel):
    seq: int
    kind: Literal["assistant", "command", "tool", "error", "status"]
    text: str
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def timestamp_is_utc(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class OutputPage(BaseModel):
    items: list[OutputEvent]
    next_after: int
    has_more: bool = False
    truncated: bool = False
    task: TaskRecord


@dataclass(frozen=True, slots=True)
class TaskRunRequest:
    task_id: str
    prompt: str
    repository: str
    model: str | None = None
    parent_task_id: str | None = None
    task_type: TaskType = "code"
    verbosity: ResearchVerbosity = "standard"


def utc_now() -> datetime:
    return datetime.now(UTC)
