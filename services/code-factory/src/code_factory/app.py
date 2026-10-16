from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pymongo.errors import PyMongoError

from .config import Settings
from .models import CreateTaskRequest, TaskRecord, TaskStatus
from .repository import TaskNotFoundError
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

    @app.get("/v1/tasks", response_model=list[TaskRecord])
    async def list_tasks(
        request: Request,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        task_status: Annotated[TaskStatus | None, Query(alias="status")] = None,
    ) -> list[TaskRecord]:
        return await get_runtime(request).list_tasks(limit, task_status)

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

    return app


app = create_app()
