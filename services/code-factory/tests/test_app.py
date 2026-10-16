from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from pymongo.errors import NetworkTimeout

from code_factory.app import create_app
from code_factory.models import CreateTaskRequest, TaskRecord, TaskStatus
from code_factory.repository import TaskNotFoundError


def record(task_id: str = "task-1", status: TaskStatus = TaskStatus.QUEUED) -> TaskRecord:
    now = datetime.now(UTC)
    return TaskRecord(
        id=task_id,
        prompt="Fix the lights",
        repository="jarvis",
        status=status,
        workflow_id=f"code-factory-{task_id}",
        created_at=now,
        updated_at=now,
    )


class FakeRuntime:
    agent_authenticated = True

    def __init__(self) -> None:
        self.tasks = {"task-1": record()}

    async def create_task(self, request: CreateTaskRequest) -> TaskRecord:
        task = record("task-2")
        task.prompt = request.prompt
        task.model = request.model
        task.repository = "workspace"
        self.tasks[task.id] = task
        return task

    async def get_task(self, task_id: str) -> TaskRecord:
        if task_id not in self.tasks:
            raise TaskNotFoundError(task_id)
        return self.tasks[task_id]

    async def list_tasks(self, limit: int, status: TaskStatus | None) -> list[TaskRecord]:
        tasks = list(self.tasks.values())
        if status is not None:
            tasks = [task for task in tasks if task.status is status]
        return tasks[:limit]

    async def cancel_task(self, task_id: str) -> TaskRecord:
        task = await self.get_task(task_id)
        task.status = TaskStatus.CANCEL_REQUESTED
        return task

    async def ready(self) -> dict[str, bool]:
        return {
            "mongo": True,
            "temporal_worker": True,
            "agent_installed": True,
            "agent_authenticated": True,
        }


def test_task_lifecycle_api() -> None:
    with TestClient(create_app(FakeRuntime())) as client:
        response = client.post("/v1/tasks", json={"prompt": "Ship it"})
        assert response.status_code == 202
        assert response.json()["repository"] == "workspace"
        assert "_id" not in response.json()

        ignored = client.post(
            "/v1/tasks",
            json={"prompt": "Also ship sherman", "repository": "sherman"},
        )
        assert ignored.status_code == 202
        assert ignored.json()["repository"] == "workspace"

        assert client.post("/v1/tasks", json={"prompt": "   "}).status_code == 422

        pinned = client.post(
            "/v1/tasks",
            json={"prompt": "Use Sol", "model": "gpt-5.6-sol-medium"},
        )
        assert pinned.status_code == 202
        assert pinned.json()["model"] == "gpt-5.6-sol-medium"

        unknown_model = client.post(
            "/v1/tasks",
            json={"prompt": "Use something else", "model": "gpt-2"},
        )
        assert unknown_model.status_code == 422

        assert client.get("/v1/tasks/task-2").status_code == 200
        assert client.post("/v1/tasks/task-2/cancel").json()["status"] == "cancel_requested"
        assert client.get("/v1/tasks/missing").status_code == 404


def test_health_endpoints() -> None:
    with TestClient(create_app(FakeRuntime())) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json()["status"] == "ready"


def test_database_timeout_returns_retryable_error_without_connection_details() -> None:
    runtime = FakeRuntime()
    runtime.list_tasks = AsyncMock(side_effect=NetworkTimeout("private connection details"))
    with TestClient(create_app(runtime)) as client:
        response = client.get("/v1/tasks")
    assert response.status_code == 503
    assert response.json() == {"detail": "Task storage is temporarily unavailable; try again"}
