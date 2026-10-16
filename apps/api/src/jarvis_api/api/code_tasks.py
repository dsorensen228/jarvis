"""Manual-only coding task endpoints.

These routes deliberately are not exposed to the Jarvis agent tool registry.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Literal, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from jarvis_api.api.task_models import (
    TASK_STATUSES,
    CodeTask,
    CodeTaskOutputPage,
    CodeTaskPage,
    CreateCodeTask,
    FollowUpCodeTask,
)
from jarvis_api.auth import current_user
from jarvis_api.code_factory import CodeFactoryError

router = APIRouter(prefix="/v1/code-tasks", tags=["code-tasks"])


def _raise_gateway_error(exc: CodeFactoryError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("", status_code=status.HTTP_202_ACCEPTED, response_model=CodeTask)
async def create_code_task(
    body: CreateCodeTask,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        task = await request.app.state.code_factory.create_task(body.prompt, body.model)
        await request.app.state.task_notifications.track(user["id"], task, "code", created=True)
        return task
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("", response_model=CodeTaskPage)
async def list_code_tasks(
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
        page = await request.app.state.code_factory.list_tasks(limit, task_status, cursor, view)
        for task in page["items"]:
            await request.app.state.task_notifications.track(user["id"], task, "code")
        return page
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}", response_model=CodeTask)
async def get_code_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        task = await request.app.state.code_factory.get_task(task_id)
        await request.app.state.task_notifications.track(user["id"], task, "code")
        return task
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.post("/{task_id}/cancel", response_model=CodeTask)
async def cancel_code_task(
    task_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.cancel_task(task_id)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get("/{task_id}/output", response_model=CodeTaskOutputPage)
async def code_task_output(
    task_id: str,
    request: Request,
    after: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.code_factory.task_output(task_id, after, limit)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.post("/{task_id}/follow-up", status_code=202, response_model=CodeTask)
async def follow_up_code_task(
    task_id: str,
    body: FollowUpCodeTask,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        task = await request.app.state.code_factory.follow_up(task_id, body.prompt, body.model)
        await request.app.state.task_notifications.track(user["id"], task, "code", created=True)
        return task
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)


@router.get(
    "/{task_id}/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def code_task_events(
    task_id: str,
    request: Request,
    after: int = Query(0, ge=0),
    last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
    user: Dict[str, Any] = Depends(current_user),
) -> StreamingResponse:
    if last_event_id is not None:
        try:
            resumed_after = int(last_event_id)
            if resumed_after < 0:
                raise ValueError
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid Last-Event-ID")
        after = max(after, resumed_after)
    try:
        upstream = await request.app.state.code_factory.open_task_events(task_id, after)
    except CodeFactoryError as exc:
        _raise_gateway_error(exc)

    async def chunks():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except httpx.HTTPError:
            detail = json.dumps({"detail": "Live output disconnected; reconnect to resume"})
            yield f"event: error\ndata: {detail}\n\n".encode()
        finally:
            await upstream.aclose()

    return StreamingResponse(
        chunks(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        background=BackgroundTask(upstream.aclose),
    )
