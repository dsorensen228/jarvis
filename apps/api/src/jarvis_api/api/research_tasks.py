"""Authenticated, manual-only research tasks and their HTML reports."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from jarvis_api.api.task_models import (
    TASK_STATUSES,
    CreateResearchTask,
    ResearchReport,
    ResearchTask,
    ResearchTaskOutputPage,
    ResearchTaskPage,
)
from jarvis_api.auth import current_user
from jarvis_api.code_factory import CodeFactoryError

router = APIRouter(prefix="/v1/research-tasks", tags=["research-tasks"])


def _raise_gateway_error(exc: CodeFactoryError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("", status_code=status.HTTP_202_ACCEPTED, response_model=ResearchTask)
async def create_research_task(
    body: CreateResearchTask,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        task = await request.app.state.code_factory.create_research_task(
            body.prompt, body.model, body.verbosity
        )
        await request.app.state.task_notifications.track(user["id"], task, "research", created=True)
        return task
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("", response_model=ResearchTaskPage)
async def list_research_tasks(
    request: Request,
    limit: int = Query(30, ge=1, le=200),
    task_status: Optional[str] = Query(None, alias="status"),
    cursor: Optional[str] = Query(None, max_length=1024),
    view: Literal["all", "active", "history"] = "all",
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    if task_status is not None and task_status not in TASK_STATUSES:
        raise HTTPException(status_code=422, detail="invalid task status")
    if task_status is not None and view != "all":
        raise HTTPException(status_code=422, detail="choose either a status or a view")
    try:
        page = await request.app.state.code_factory.list_research_tasks(
            limit, task_status, cursor, view
        )
        for task in page["items"]:
            await request.app.state.task_notifications.track(user["id"], task, "research")
        return page
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}", response_model=ResearchTask)
async def get_research_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        task = await request.app.state.code_factory.get_research_task(task_id)
        await request.app.state.task_notifications.track(user["id"], task, "research")
        return task
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.post("/{task_id}/cancel", response_model=ResearchTask)
async def cancel_research_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.cancel_research_task(task_id)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}/report", response_model=ResearchReport)
async def research_report(
    task_id: str,
    request: Request,
    response: Response,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        report = await request.app.state.code_factory.research_report(task_id)
        response.headers["Cache-Control"] = "no-store"
        return report
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}/output", response_model=ResearchTaskOutputPage)
async def research_task_output(
    task_id: str,
    request: Request,
    after: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.research_task_output(task_id, after, limit)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)
