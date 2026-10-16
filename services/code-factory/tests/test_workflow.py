from unittest.mock import AsyncMock

from code_factory.models import TaskRunRequest
from code_factory.workflow import CodingTaskWorkflow


async def test_follow_up_waits_for_parent_without_occupying_coding_activity(monkeypatch):
    calls = []
    states = iter([False, False, True])

    async def execute(name, argument, **kwargs):
        calls.append((name, argument))
        if name == "parent_task_finished":
            return next(states)

    sleep = AsyncMock()
    monkeypatch.setattr("code_factory.workflow.workflow.execute_activity", execute)
    monkeypatch.setattr("code_factory.workflow.workflow.sleep", sleep)
    request = TaskRunRequest("child", "Continue", "workspace", "gpt-6-sol", "parent")
    await CodingTaskWorkflow().run(request)
    assert calls == [
        ("parent_task_finished", "parent"),
        ("parent_task_finished", "parent"),
        ("parent_task_finished", "parent"),
        ("run_coding_task", request),
    ]
    assert sleep.await_count == 2


async def test_original_task_keeps_existing_workflow_history(monkeypatch):
    execute = AsyncMock()
    monkeypatch.setattr("code_factory.workflow.workflow.execute_activity", execute)
    request = TaskRunRequest("original", "Do work", "workspace", "gpt-6-sol")
    await CodingTaskWorkflow().run(request)
    execute.assert_awaited_once()
    assert execute.call_args.args == ("run_coding_task", request)
