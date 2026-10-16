from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from pymongo.errors import PyMongoError

from .config import Settings
from .models import (
    TERMINAL_STATUSES,
    CreateTaskRequest,
    FollowUpRequest,
    OutputPage,
    TaskPage,
    TaskRecord,
    TaskStatus,
    TaskType,
    TaskView,
)
from .repository import InvalidCursorError, TaskNotFoundError
from .runtime import CodeFactoryRuntime, RuntimeProtocol

logger = logging.getLogger(__name__)


def create_app(runtime: RuntimeProtocol | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned_runtime: CodeFactoryRuntime | None = None
        if runtime is None:
            owned_runtime = await CodeFactoryRuntime.start(Settings.from_env())
            app.state.runtime = owned_runtime
        else:
            app.state.runtime = runtime
        yield
        if owned_runtime is not None:
            await owned_runtime.close()

    app = FastAPI(
        title="Jarvis Code Factory",
        version="0.1.0",
        lifespan=lifespan,
    )

    def get_runtime(request: Request) -> RuntimeProtocol:
        return request.app.state.runtime

    @app.exception_handler(PyMongoError)
    async def storage_error(request: Request, exc: PyMongoError) -> JSONResponse:
        # Class and route diagnose storage failures without logging connection strings,
        # task content, or query parameters that may contain credentials.
        logger.error(
            "Task storage failure: %s %s (%s)", request.method, request.url.path, type(exc).__name__
        )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Task storage is temporarily unavailable; try again"},
        )

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready(request: Request, response: Response) -> dict[str, object]:
        checks = await get_runtime(request).ready()
        is_ready = all(checks.values())
        if not is_ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "ready" if is_ready else "not_ready", "checks": checks}

    @app.post("/v1/tasks", response_model=TaskRecord, status_code=status.HTTP_202_ACCEPTED)
    async def create_task(body: CreateTaskRequest, request: Request) -> TaskRecord:
        return await get_runtime(request).create_task(body)

    @app.get("/v1/tasks", response_model=TaskPage)
    async def list_tasks(
        request: Request,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        task_status: Annotated[TaskStatus | None, Query(alias="status")] = None,
        cursor: Annotated[str | None, Query(max_length=1024)] = None,
        view: TaskView = "all",
        task_type: TaskType = "code",
    ) -> TaskPage:
        try:
            return await get_runtime(request).list_tasks(
                limit, task_status, cursor, view, task_type
            )
        except InvalidCursorError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/v1/tasks/{task_id}/report")
    async def get_report(task_id: str, request: Request) -> dict[str, str]:
        try:
            return await get_runtime(request).get_report(task_id)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="report not found") from exc

    @app.get("/v1/tasks/{task_id}", response_model=TaskRecord)
    async def get_task(task_id: str, request: Request) -> TaskRecord:
        try:
            return await get_runtime(request).get_task(task_id)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.post("/v1/tasks/{task_id}/cancel", response_model=TaskRecord)
    async def cancel_task(task_id: str, request: Request) -> TaskRecord:
        try:
            return await get_runtime(request).cancel_task(task_id)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.post("/v1/tasks/{task_id}/follow-up", response_model=TaskRecord, status_code=202)
    async def follow_up(task_id: str, body: FollowUpRequest, request: Request) -> TaskRecord:
        try:
            return await get_runtime(request).follow_up(task_id, body)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.get("/v1/tasks/{task_id}/output", response_model=OutputPage)
    async def task_output(
        task_id: str,
        request: Request,
        after: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
    ) -> OutputPage:
        try:
            return await get_runtime(request).task_output(task_id, after, limit)
        except TaskNotFoundError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.get("/v1/tasks/{task_id}/events")
    async def task_events(
        task_id: str,
        request: Request,
        after: Annotated[int, Query(ge=0)] = 0,
    ) -> StreamingResponse:
        last_id = request.headers.get("last-event-id")
        if last_id:
            try:
                event_id = int(last_id)
                if event_id < 0:
                    raise ValueError
                after = max(after, event_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="Invalid Last-Event-ID") from exc
        initial = await task_output(task_id, request, after, 100)

        async def stream() -> AsyncIterator[str]:
            page = initial
            previous = None
            next_after = after
            idle_polls = 0
            while not await request.is_disconnected():
                signature = (page.task.updated_at, page.task.status, page.next_after)
                if page.items or signature != previous:
                    yield (
                        f"id: {page.next_after}\nevent: output\ndata: {page.model_dump_json()}\n\n"
                    )
                    previous = signature
                    idle_polls = 0
                else:
                    idle_polls += 1
                    if idle_polls >= 10:
                        yield ": heartbeat\n\n"
                        idle_polls = 0
                next_after = page.next_after
                if page.task.status in TERMINAL_STATUSES and not page.has_more:
                    return
                if not page.has_more:
                    await asyncio.sleep(1)
                try:
                    page = await get_runtime(request).task_output(task_id, next_after, 100)
                except PyMongoError:
                    yield (
                        'event: error\ndata: {"detail":"Task storage temporarily unavailable"}\n\n'
                    )
                    return

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


app = create_app()
