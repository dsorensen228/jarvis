from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

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

# Agent CLI model slugs selectable from the Code Factory UI surfaces.
AGENT_MODELS: tuple[str, ...] = (
    "gpt-5.6-sol-medium",
    "claude-opus-5-thinking-high",
    "claude-fable-5-thinking-high",
)


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(min_length=1)
    model: str | None = None

    @field_validator("prompt")
    @classmethod
    def prompt_must_contain_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("prompt must contain non-whitespace text")
        return stripped

    @field_validator("model")
    @classmethod
    def model_must_be_supported(cls, value: str | None) -> str | None:
        if value is not None and value not in AGENT_MODELS:
            raise ValueError(f"model must be one of: {', '.join(AGENT_MODELS)}")
        return value


class TaskRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    prompt: str
    model: str | None = None
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


@dataclass(frozen=True, slots=True)
class TaskRunRequest:
    task_id: str
    prompt: str
    repository: str
    model: str | None = None


def utc_now() -> datetime:
    return datetime.now(UTC)
