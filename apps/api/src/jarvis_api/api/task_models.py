"""Public schemas for manual coding and research tasks."""

from __future__ import annotations

from datetime import datetime
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field, validator

AgentModel = Literal[
    "gpt-6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
]

TASK_STATUSES = {
    "pending",
    "queued",
    "running",
    "cancel_requested",
    "cancelled",
    "success",
    "failed",
}


class CreateCodeTask(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=32000)
    model: AgentModel

    class Config:
        extra = "ignore"

    @validator("prompt")
    def prompt_must_contain_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("prompt must contain non-whitespace text")
        return stripped


class FollowUpCodeTask(CreateCodeTask):
    model: Optional[AgentModel] = None


class CodeTask(BaseModel):
    id: str
    prompt: str
    model: Optional[str] = None
    repository: str = "workspace"
    status: str
    workflow_id: str
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    exit_code: Optional[int] = None
    agent_output: Any = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None
    changed_paths: List[str] = Field(default_factory=list)
    self_update_scheduled: bool = False
    parent_task_id: Optional[str] = None
    output_seq: int = 0


class CodeTaskPage(BaseModel):
    items: List[CodeTask]
    next_cursor: Optional[str] = None


class CodeTaskOutputItem(BaseModel):
    seq: int
    kind: Literal["assistant", "command", "tool", "error", "status"]
    text: str
    created_at: datetime


class CodeTaskOutputPage(BaseModel):
    items: List[CodeTaskOutputItem]
    next_after: int
    has_more: bool
    truncated: bool
    task: CodeTask


ResearchVerbosity = Literal["concise", "standard", "in_depth"]


class CreateResearchTask(CreateCodeTask):
    verbosity: ResearchVerbosity = Field(
        "standard",
        description=(
            "Depth of treatment across the full requested scope: concise uses minimal detail "
            "per item, standard balances explanation and evidence, and in_depth includes "
            "thorough reasoning, context, and evidence. This does not cap report length."
        ),
    )


class ResearchTask(CodeTask):
    task_type: Literal["research"]
    verbosity: ResearchVerbosity = "standard"
    report_available: bool = False


class ResearchTaskPage(BaseModel):
    items: List[ResearchTask]
    next_cursor: Optional[str] = None


class ResearchTaskOutputPage(CodeTaskOutputPage):
    task: ResearchTask


class ResearchReport(BaseModel):
    task_id: str
    html: str
