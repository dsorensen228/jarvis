import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from temporalio.client import WorkflowExecutionStatus, WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError, RPCStatusCode

from code_factory.config import Settings
from code_factory.models import FollowUpRequest, TaskPage, TaskRecord, TaskStatus
from code_factory.runtime import CodeFactoryRuntime


def runtime_task(status=TaskStatus.RUNNING):
    now = datetime.now(UTC)
    task = TaskRecord(
        id="task-1",
        prompt="Fix the UI",
        status=status,
        workflow_id="code-factory-task-1",
        created_at=now - timedelta(hours=1),
        updated_at=now,
    )
    repository = AsyncMock()
    repository.get.return_value = task
    repository.list_active.return_value = [task]
    handle = AsyncMock()
    temporal = MagicMock()
    temporal.get_workflow_handle.return_value = handle
    worker_task = MagicMock()
    worker_task.done.return_value = False
    runtime = CodeFactoryRuntime(
        Settings.from_env(), repository, temporal, AsyncMock(), worker_task
    )
    return runtime, task, handle


@pytest.mark.parametrize(
    "state",
    [
        WorkflowExecutionStatus.FAILED,
        WorkflowExecutionStatus.TIMED_OUT,
        WorkflowExecutionStatus.TERMINATED,
    ],
)
async def test_reconciliation_persists_closed_workflow_failure(state):
    runtime, task, handle = runtime_task()
    closed = datetime.now(UTC)
    handle.describe.return_value = SimpleNamespace(status=state, close_time=closed)
    handle.result.side_effect = WorkflowFailureError(cause=ApplicationError("heartbeat timed out"))
    await runtime.reconcile_active_tasks()
    args = runtime.repository.set_status.call_args
    assert args.args == (task.id, TaskStatus.FAILED)
    assert args.kwargs["at"] == closed
    assert "heartbeat timed out" in args.kwargs["error"]


async def test_reconciliation_does_not_infer_success_without_saved_result():
    runtime, task, handle = runtime_task()
    handle.describe.return_value = SimpleNamespace(
        status=WorkflowExecutionStatus.COMPLETED, close_time=datetime.now(UTC)
    )
    await runtime._reconcile_task(task)
    assert runtime.repository.set_status.call_args.args[1] == TaskStatus.FAILED
    assert (
        "without a persisted task result" in runtime.repository.set_status.call_args.kwargs["error"]
    )


async def test_reconciliation_leaves_running_and_terminal_records_alone():
    runtime, task, handle = runtime_task()
    handle.describe.return_value = SimpleNamespace(status=WorkflowExecutionStatus.RUNNING)
    await runtime._reconcile_task(task)
    task.status = TaskStatus.SUCCESS
    await runtime._reconcile_task(task)
    runtime.repository.set_status.assert_not_called()
    assert handle.describe.await_count == 1


async def test_reconciliation_does_not_fail_jobs_during_temporal_outage():
    runtime, task, handle = runtime_task()
    handle.describe.side_effect = RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
    assert await runtime._reconcile_task(task) == task
    runtime.repository.set_status.assert_not_called()


async def test_missing_workflow_gets_submission_grace_period():
    runtime, task, handle = runtime_task()
    handle.describe.side_effect = RPCError("missing", RPCStatusCode.NOT_FOUND, b"")
    task.created_at = datetime.now(UTC)
    await runtime._reconcile_task(task)
    runtime.repository.set_status.assert_not_called()
    task.created_at -= timedelta(minutes=2)
    await runtime._reconcile_task(task)
    assert runtime.repository.set_status.call_args.args[1] == TaskStatus.FAILED


async def test_cancel_closed_failed_workflow_returns_failure():
    runtime, task, handle = runtime_task()
    handle.describe.return_value = SimpleNamespace(
        status=WorkflowExecutionStatus.FAILED, close_time=datetime.now(UTC)
    )
    handle.result.side_effect = WorkflowFailureError(cause=ApplicationError("worker died"))
    runtime.repository.set_status.return_value = task.model_copy(
        update={"status": TaskStatus.FAILED}
    )
    result = await runtime.cancel_task(task.id)
    assert result.status == TaskStatus.FAILED
    handle.cancel.assert_not_called()


async def test_background_reconciliation_runs_without_api_polling():
    runtime, _, _ = runtime_task()
    reconciled = asyncio.Event()
    runtime.reconcile_active_tasks = AsyncMock(side_effect=lambda: reconciled.set())
    running = asyncio.create_task(runtime._reconcile_loop())
    try:
        await asyncio.wait_for(reconciled.wait(), 1)
    finally:
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running


async def test_listing_does_not_wait_for_workflow_reconciliation():
    runtime, task, _ = runtime_task()
    page = TaskPage(items=[task])
    runtime.repository.list_page.return_value = page
    runtime.reconcile_active_tasks = AsyncMock(side_effect=asyncio.Event().wait)

    result = await asyncio.wait_for(runtime.list_tasks(50, TaskStatus.RUNNING), timeout=0.1)

    assert result == page
    runtime.repository.list_page.assert_awaited_once_with(
        limit=50, status=TaskStatus.RUNNING, cursor=None, view="all", task_type="code"
    )
    runtime.reconcile_active_tasks.assert_not_awaited()


async def test_follow_up_creates_a_separate_linked_job_and_inherits_model():
    runtime, parent, _ = runtime_task()
    parent.model = "gpt-6-astra"
    runtime.repository.create.return_value = parent.model_copy(
        update={
            "id": "child",
            "workflow_id": "code-factory-child",
            "prompt": "Add keyboard shortcuts",
        }
    )
    await runtime.follow_up(parent.id, FollowUpRequest(prompt="  Add keyboard shortcuts  "))
    runtime.repository.create.assert_awaited_once_with(
        prompt="Add keyboard shortcuts",
        repository="workspace",
        model="gpt-6-astra",
        parent_task_id=parent.id,
        task_type="code",
        verbosity="standard",
    )
    request = runtime.temporal.start_workflow.call_args.args[1]
    assert request.parent_task_id == parent.id
    assert request.prompt == "Add keyboard shortcuts"


async def test_output_reads_do_not_wait_for_temporal():
    runtime, _, handle = runtime_task()
    await runtime.task_output("task-1", 7, 20)
    runtime.repository.output.assert_awaited_once_with("task-1", after=7, limit=20)
    handle.describe.assert_not_awaited()


@pytest.mark.parametrize("model", [None, "retired-model"])
async def test_follow_up_to_historical_job_uses_supported_default(model):
    runtime, parent, _ = runtime_task()
    parent.model = model
    runtime._start_task = AsyncMock()
    await runtime.follow_up(parent.id, FollowUpRequest(prompt="Continue"))
    assert runtime._start_task.call_args.args[0].model == "gpt-6-sol"


async def test_shutdown_cannot_hang_after_a_terminated_activity(monkeypatch):
    runtime, _, _ = runtime_task()
    never = asyncio.Event()
    runtime.worker.shutdown.side_effect = never.wait
    runtime.worker_task = asyncio.create_task(never.wait())
    monkeypatch.setattr("code_factory.runtime.WORKER_SHUTDOWN_TIMEOUT_SECONDS", 0.01)
    await asyncio.wait_for(runtime.close(), timeout=1)
    assert runtime.worker_task.cancelled()
    runtime.repository.close.assert_awaited_once()


@pytest.mark.parametrize(
    ("message", "exit_code", "authenticated"),
    [
        ("Logged in using ChatGPT", 0, True),
        ("Logged in using an API key", 0, False),
        ("Not logged in", 1, False),
    ],
)
async def test_auth_check_requires_saved_chatgpt_login(
    tmp_path, monkeypatch, message, exit_code, authenticated
):
    from dataclasses import replace

    from code_factory.runtime import _agent_is_authenticated

    executable = tmp_path / "codex"
    executable.write_text("#!/bin/sh\n")
    process = AsyncMock()
    process.communicate.return_value = (message.encode(), None)
    process.returncode = exit_code
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr("code_factory.runtime.asyncio.create_subprocess_exec", spawn)
    monkeypatch.setenv("CODEX_API_KEY", "test-api-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-api-key")
    settings = replace(Settings.from_env(), agent_path=executable)
    assert await _agent_is_authenticated(settings) is authenticated
    assert spawn.call_args.args[-2:] == ("login", "status")
    assert 'cli_auth_credentials_store="file"' in spawn.call_args.args
    assert "CODEX_API_KEY" not in spawn.call_args.kwargs["env"]
    assert "OPENAI_API_KEY" not in spawn.call_args.kwargs["env"]
    assert spawn.call_args.kwargs["stdin"] == asyncio.subprocess.DEVNULL


async def test_research_follow_up_inherits_task_type_depth_and_model():
    runtime, parent, _ = runtime_task()
    parent.task_type = "research"
    parent.verbosity = "in_depth"
    parent.model = "gpt-6-astra"
    runtime.repository.create.return_value = parent.model_copy(
        update={"id": "child", "workflow_id": "wf-child", "prompt": "Expand the evidence"}
    )
    await runtime.follow_up(parent.id, FollowUpRequest(prompt="Expand the evidence"))
    assert runtime.repository.create.call_args.kwargs["task_type"] == "research"
    assert runtime.repository.create.call_args.kwargs["verbosity"] == "in_depth"
    assert runtime.repository.create.call_args.kwargs["repository"] == "research"
    request = runtime.temporal.start_workflow.call_args.args[1]
    assert request.task_type == "research"
    assert request.verbosity == "in_depth"
    assert request.model == "gpt-6-astra"
    assert request.parent_task_id == parent.id
