from __future__ import annotations

import asyncio
import logging
import os
from contextlib import suppress
from datetime import timedelta
from typing import Protocol

from temporalio.client import Client, WorkflowExecutionStatus, WorkflowFailureError
from temporalio.exceptions import CancelledError
from temporalio.service import RPCError, RPCStatusCode
from temporalio.worker import Worker

from .activities import AgentActivities
from .config import Settings
from .models import (
    TERMINAL_STATUSES,
    CreateTaskRequest,
    TaskRecord,
    TaskRunRequest,
    TaskStatus,
    utc_now,
)
from .repository import TaskRepository
from .workflow import CodingTaskWorkflow

logger = logging.getLogger(__name__)
WORKER_SHUTDOWN_TIMEOUT_SECONDS = 20


class RuntimeProtocol(Protocol):
    agent_authenticated: bool

    async def create_task(self, request: CreateTaskRequest) -> TaskRecord: ...

    async def get_task(self, task_id: str) -> TaskRecord: ...

    async def list_tasks(self, limit: int, status: TaskStatus | None) -> list[TaskRecord]: ...

    async def cancel_task(self, task_id: str) -> TaskRecord: ...

    async def ready(self) -> dict[str, bool]: ...


class CodeFactoryRuntime:
    def __init__(
        self,
        settings: Settings,
        repository: TaskRepository,
        temporal: Client,
        worker: Worker,
        worker_task: asyncio.Task[None],
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.temporal = temporal
        self.worker = worker
        self.worker_task = worker_task
        self.agent_authenticated = False
        self.reconcile_task: asyncio.Task[None] | None = None

    @classmethod
    async def start(cls, settings: Settings) -> CodeFactoryRuntime:
        repository = TaskRepository(
            settings.mongo_uri,
            settings.mongo_database,
            settings.mongo_collection,
        )
        await repository.initialize()
        temporal = await Client.connect(
            settings.temporal_address,
            namespace=settings.temporal_namespace,
        )
        activities = AgentActivities(settings, repository)
        worker = Worker(
            temporal,
            task_queue=settings.temporal_task_queue,
            workflows=[CodingTaskWorkflow],
            activities=[activities.run_coding_task],
            max_concurrent_activities=1,
        )
        worker_task = asyncio.create_task(worker.run(), name="code-factory-temporal-worker")
        runtime = cls(settings, repository, temporal, worker, worker_task)
        runtime.agent_authenticated = await _agent_is_authenticated(settings)
        runtime.reconcile_task = asyncio.create_task(
            runtime._reconcile_loop(), name="code-factory-reconciliation"
        )
        return runtime

    async def close(self) -> None:
        if self.reconcile_task is not None:
            self.reconcile_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.reconcile_task
        try:
            await asyncio.wait_for(self.worker.shutdown(), timeout=WORKER_SHUTDOWN_TIMEOUT_SECONDS)
        except TimeoutError:
            logger.warning("Temporal worker shutdown timed out; cancelling worker")
            self.worker_task.cancel()
        try:
            with suppress(asyncio.CancelledError):
                await self.worker_task
        finally:
            await self.repository.close()

    async def create_task(self, request: CreateTaskRequest) -> TaskRecord:
        task = await self.repository.create(
            prompt=request.prompt.strip(),
            repository="workspace",
            model=request.model,
        )
        try:
            await self.temporal.start_workflow(
                CodingTaskWorkflow.run,
                TaskRunRequest(
                    task_id=task.id,
                    prompt=task.prompt,
                    repository=task.repository,
                    model=task.model,
                ),
                id=task.workflow_id,
                task_queue=self.settings.temporal_task_queue,
            )
        except Exception as exc:
            return await self.repository.set_status(
                task.id,
                TaskStatus.FAILED,
                error=f"could not start Temporal workflow: {type(exc).__name__}: {exc}",
            )
        return await self.repository.set_status(task.id, TaskStatus.QUEUED)

    async def get_task(self, task_id: str) -> TaskRecord:
        return await self._reconcile_task(await self.repository.get(task_id))

    async def list_tasks(self, limit: int, status: TaskStatus | None) -> list[TaskRecord]:
        # Background reconciliation owns status repair. Listing must not wait for one
        # Temporal RPC per active task, particularly during a Temporal outage.
        return await self.repository.list(limit=limit, status=status)

    async def cancel_task(self, task_id: str) -> TaskRecord:
        task = await self.get_task(task_id)
        if task.status in TERMINAL_STATUSES:
            return task
        await self.repository.set_status(task.id, TaskStatus.CANCEL_REQUESTED)
        handle = self.temporal.get_workflow_handle(task.workflow_id)
        await handle.cancel()
        try:
            await asyncio.wait_for(handle.result(), timeout=20)
        except WorkflowFailureError as exc:
            if not isinstance(exc.cause, CancelledError):
                return await self._reconcile_task(task)
        except TimeoutError:
            # Temporal accepted cancellation. A running activity may still be terminating its
            # process group, but the task must not remain non-terminal forever.
            pass
        return await self.repository.set_status(task.id, TaskStatus.CANCELLED)

    async def _reconcile_loop(self) -> None:
        while True:
            try:
                await self.reconcile_active_tasks()
            except Exception:
                logger.exception("Could not reconcile Code Factory tasks")
            await asyncio.sleep(15)

    async def reconcile_active_tasks(self) -> None:
        for task in await self.repository.list_active():
            await self._reconcile_task(task)

    async def _reconcile_task(self, task: TaskRecord) -> TaskRecord:
        if task.status in TERMINAL_STATUSES:
            return task
        try:
            async with asyncio.timeout(5):
                handle = self.temporal.get_workflow_handle(task.workflow_id)
                description = await handle.describe()
                if description.status in {
                    WorkflowExecutionStatus.RUNNING,
                    WorkflowExecutionStatus.CONTINUED_AS_NEW,
                }:
                    return await self.repository.get(task.id)
                status = TaskStatus.FAILED
                error = f"Temporal workflow {description.status.name.lower()}"
                if description.status == WorkflowExecutionStatus.CANCELED:
                    status = TaskStatus.CANCELLED
                elif description.status == WorkflowExecutionStatus.COMPLETED:
                    error += " without a persisted task result"
                else:
                    try:
                        await handle.result()
                    except WorkflowFailureError as exc:
                        causes = []
                        cause = exc.cause
                        while cause is not None:
                            causes.append(f"{type(cause).__name__}: {cause}")
                            cause = getattr(cause, "cause", None)
                        error += ": " + "; ".join(causes)
                return await self.repository.set_status(
                    task.id,
                    status,
                    at=description.close_time,
                    error=error,
                )
        except RPCError as exc:
            # A submission can be between the Mongo insert and Temporal start.
            created = task.created_at.replace(tzinfo=utc_now().tzinfo)
            if exc.status == RPCStatusCode.NOT_FOUND and utc_now() - created > timedelta(minutes=1):
                return await self.repository.set_status(
                    task.id,
                    TaskStatus.FAILED,
                    error="Temporal workflow not found for this task",
                )
            logger.warning("Could not inspect workflow for task %s: %s", task.id, exc)
        except Exception:
            # Loss of Temporal connectivity is not evidence that a task failed.
            logger.exception("Could not reconcile task %s", task.id)
        return task

    async def ready(self) -> dict[str, bool]:
        try:
            await self.repository.ping()
            mongo = True
        except Exception:
            mongo = False
        return {
            "mongo": mongo,
            "temporal_worker": not self.worker_task.done(),
            "task_reconciliation": self.reconcile_task is not None
            and not self.reconcile_task.done(),
            "agent_installed": self.settings.agent_path.is_file(),
            "agent_authenticated": self.agent_authenticated,
        }


async def _agent_is_authenticated(settings: Settings) -> bool:
    if not settings.agent_path.is_file():
        return False
    if os.environ.get("CURSOR_API_KEY"):
        return True
    process = await asyncio.create_subprocess_exec(
        str(settings.agent_path),
        "status",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "AGENT_CLI_CREDENTIAL_STORE": "file"},
    )
    output, _ = await process.communicate()
    return process.returncode == 0 and b"not logged in" not in output.lower()
