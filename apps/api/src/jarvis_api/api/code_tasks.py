"""Manual-only coding task endpoints.

These routes deliberately are not exposed to the Jarvis agent tool registry.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, validator

from jarvis_api.auth import current_user
from jarvis_api.code_factory import CodeFactoryError

router = APIRouter(prefix="/v1/code-tasks", tags=["code-tasks"])

AgentModel = Literal[
    "gpt-5.6-sol-medium",
    "claude-opus-5-thinking-high",
    "claude-fable-5-thinking-high",
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
    prompt: str = Field(..., min_length=1, max_length=50000)
    model: Optional[AgentModel] = None

    class Config:
        extra = "ignore"

    @validator("prompt")
    def prompt_must_contain_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("prompt must contain non-whitespace text")
        return stripped


def _raise_gateway_error(exc: CodeFactoryError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def create_code_task(
    body: CreateCodeTask,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.create_task(body.prompt, body.model)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("")
async def list_code_tasks(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    task_status: Optional[str] = Query(None, alias="status"),
    user: Dict[str, Any] = Depends(current_user),
) -> List[Dict[str, Any]]:
    if task_status is not None and task_status not in TASK_STATUSES:
        raise HTTPException(status_code=422, detail="invalid task status")
    try:
        return await request.app.state.code_factory.list_tasks(limit, task_status)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}")
async def get_code_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.get_task(task_id)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.post("/{task_id}/cancel")
async def cancel_code_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.cancel_task(task_id)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)
