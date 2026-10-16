from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from pymongo.errors import NetworkTimeout

from code_factory.app import create_app
from code_factory.models import (
    CreateTaskRequest,
    FollowUpRequest,
    OutputPage,
    TaskPage,
    TaskRecord,
    TaskStatus,
    TaskView,
)
from code_factory.repository import InvalidCursorError, TaskNotFoundError


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
        task.task_type = request.task_type
        task.verbosity = request.verbosity
        task.repository = "workspace"
        self.tasks[task.id] = task
        return task

    async def get_task(self, task_id: str) -> TaskRecord:
        if task_id not in self.tasks:
            raise TaskNotFoundError(task_id)
        return self.tasks[task_id]

    async def list_tasks(
        self,
        limit: int,
        status: TaskStatus | None,
        cursor: str | None = None,
        view: TaskView = "all",
        task_type: str = "code",
    ) -> TaskPage:
        tasks = [task for task in self.tasks.values() if task.task_type == task_type]
        if status is not None:
            tasks = [task for task in tasks if task.status is status]
        return TaskPage(items=tasks[:limit])

    async def task_output(self, task_id: str, after: int, limit: int) -> OutputPage:
        return OutputPage(task=await self.get_task(task_id), items=[], next_after=after)

    async def follow_up(self, task_id: str, request: FollowUpRequest) -> TaskRecord:
        parent = await self.get_task(task_id)
        task = await self.create_task(
            CreateTaskRequest(prompt=request.prompt, model=request.model or "gpt-6-sol")
        )
        task.parent_task_id = parent.id
        return task

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
        response = client.post("/v1/tasks", json={"prompt": "Ship it", "model": "gpt-6-sol"})
        assert response.status_code == 202
        assert response.json()["repository"] == "workspace"
        assert "_id" not in response.json()

        ignored = client.post(
            "/v1/tasks",
            json={"prompt": "Also ship sherman", "repository": "sherman", "model": "gpt-6-sol"},
        )
        assert ignored.status_code == 202
        assert ignored.json()["repository"] == "workspace"

        assert client.post("/v1/tasks", json={"prompt": "   "}).status_code == 422

        pinned = client.post(
            "/v1/tasks",
            json={"prompt": "Use Sol", "model": "gpt-6-sol"},
        )
        assert pinned.status_code == 202
        assert pinned.json()["model"] == "gpt-6-sol"

        assert client.post("/v1/tasks", json={"prompt": "Missing model"}).status_code == 422

        unknown_model = client.post(
            "/v1/tasks",
            json={"prompt": "Use something else", "model": "gpt-2"},
        )
        assert unknown_model.status_code == 422

        assert client.get("/v1/tasks/task-2").status_code == 200
        assert client.post("/v1/tasks/task-2/cancel").json()["status"] == "cancel_requested"
        assert client.get("/v1/tasks/missing").status_code == 404


def test_page_contract_and_validation():
    runtime = FakeRuntime()
    with TestClient(create_app(runtime)) as client:
        page = client.get("/v1/tasks?view=active&limit=1").json()
        assert page["items"][0]["id"] == "task-1"
        assert page["next_cursor"] is None
        assert client.get("/v1/tasks?limit=201").status_code == 422
        assert client.get("/v1/tasks?view=unknown").status_code == 422
        runtime.list_tasks = AsyncMock(side_effect=InvalidCursorError("Invalid cursor"))
        assert client.get("/v1/tasks?cursor=broken").status_code == 400


def test_follow_up_and_output_contract():
    with TestClient(create_app(FakeRuntime())) as client:
        result = client.post("/v1/tasks/task-1/follow-up", json={"prompt": "Add tests"})
        assert result.status_code == 202
        assert result.json()["parent_task_id"] == "task-1"
        assert result.json()["prompt"] == "Add tests"
        assert (
            client.post("/v1/tasks/missing/follow-up", json={"prompt": "Test"}).status_code == 404
        )
        assert client.post("/v1/tasks/task-1/follow-up", json={"prompt": "  "}).status_code == 422
        output = client.get("/v1/tasks/task-1/output?after=3&limit=10").json()
        assert output["next_after"] == 3
        assert output["task"]["id"] == "task-1"
        assert client.get("/v1/tasks/task-1/output?after=-1").status_code == 422
        assert client.get("/v1/tasks/missing/output").status_code == 404


def test_terminal_stream_reconnects_from_last_event_id_and_closes():
    runtime = FakeRuntime()
    runtime.tasks["task-1"].status = TaskStatus.SUCCESS
    runtime.task_output = AsyncMock(wraps=runtime.task_output)
    with TestClient(create_app(runtime)) as client:
        response = client.get("/v1/tasks/task-1/events?after=2", headers={"Last-Event-ID": "8"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert "id: 8\nevent: output\n" in response.text
        assert '"status":"success"' in response.text
        runtime.task_output.assert_awaited_once_with("task-1", 8, 100)
        for last_id in ("broken", "-1"):
            assert (
                client.get(
                    "/v1/tasks/task-1/events", headers={"Last-Event-ID": last_id}
                ).status_code
                == 400
            )


def test_stream_drains_remaining_pages_before_finishing():
    runtime = FakeRuntime()
    task = runtime.tasks["task-1"]
    task.status = TaskStatus.SUCCESS
    runtime.task_output = AsyncMock(
        side_effect=[
            OutputPage(task=task, items=[], next_after=100, has_more=True),
            OutputPage(task=task, items=[], next_after=130),
        ]
    )
    with TestClient(create_app(runtime)) as client:
        response = client.get("/v1/tasks/task-1/events")
    assert "id: 100" in response.text
    assert "id: 130" in response.text
    assert runtime.task_output.await_args_list[1].args == ("task-1", 100, 100)


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


def test_research_api_creation_listing_and_report_are_separate():
    runtime = FakeRuntime()
    runtime.get_report = AsyncMock(side_effect=TaskNotFoundError("unavailable"))
    with TestClient(create_app(runtime)) as client:
        response = client.post(
            "/v1/tasks",
            json={
                "prompt": "Compare batteries",
                "model": "gpt-6-astra",
                "task_type": "research",
                "verbosity": "concise",
            },
        )
        assert response.status_code == 202
        assert response.json()["task_type"] == "research"
        assert response.json()["verbosity"] == "concise"
        assert not response.json()["report_available"]
        assert [task["id"] for task in client.get("/v1/tasks").json()["items"]] == ["task-1"]
        assert [
            task["id"] for task in client.get("/v1/tasks?task_type=research").json()["items"]
        ] == ["task-2"]
        assert client.get("/v1/tasks?task_type=invalid").status_code == 422
        assert client.get("/v1/tasks/task-2/report").status_code == 404
        runtime.get_report.side_effect = None
        runtime.get_report.return_value = {"task_id": "task-2", "html": "<p>Findings</p>"}
        assert client.get("/v1/tasks/task-2/report").json() == runtime.get_report.return_value
        task = runtime.tasks["task-2"]
        task.status = TaskStatus.SUCCESS
        task.report_available = True
        task.report_html = "<p>Findings</p>"
        assert "report_html" not in client.get("/v1/tasks/task-2").json()
        assert "report_html" not in client.get("/v1/tasks/task-2/output").json()["task"]
        assert "report_html" not in client.get("/v1/tasks/task-2/events").text
