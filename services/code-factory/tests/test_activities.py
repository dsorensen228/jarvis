import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from temporalio.testing import ActivityEnvironment

from code_factory.activities import (
    AgentActivities,
    AgentProcessResult,
    _agent_failure_message,
    _parse_agent_output,
    workspace_prompt,
)
from code_factory.config import Settings
from code_factory.git_changes import affects_code_factory
from code_factory.models import TaskRunRequest, TaskStatus


@pytest.mark.parametrize("model", ["gpt-5.6-terra", "gpt-6-sol", "gpt-6-astra"])
def test_codex_command_is_unattended_and_pins_model(model) -> None:
    command = AgentActivities.command(Path("/opt/homebrew/bin/codex"), "--do the work", model)
    assert command[:2] == ("/opt/homebrew/bin/codex", "exec")
    assert command[command.index("--profile") + 1] == "code-factory"
    assert command[command.index("--model") + 1] == model
    assert command[command.index("--sandbox") + 1] == "danger-full-access"
    assert 'approval_policy="never"' in command
    assert 'forced_login_method="chatgpt"' in command
    assert 'cli_auth_credentials_store="file"' in command
    assert 'model_reasoning_effort="medium"' in command
    assert "--skip-git-repo-check" in command
    assert "--json" in command
    assert Path(command[command.index("--output-schema") + 1]).is_file()
    assert command[-2:] == ("--", "--do the work")


@pytest.mark.parametrize("model", [None, "auto", "composer-2.5"])
def test_codex_command_rejects_missing_or_unsupported_model(model) -> None:
    with pytest.raises(ValueError):
        AgentActivities.command(Path("/opt/homebrew/bin/codex"), "task", model)


def test_workspace_prompt_lets_the_agent_choose_repositories() -> None:
    prompt = workspace_prompt("task-9", "Add a health check")
    assert "task-9" in prompt
    assert prompt.endswith("Add a health check")
    assert "Never ask questions" in prompt
    assert "No person can" in prompt
    assert "report failure" in prompt
    assert "Skills supply methods, not extra approval gates" in prompt
    assert "Work in the jarvis repository" not in prompt.lower()
    assert "Work in the sherman repository" not in prompt.lower()
    assert "jarvis" in prompt.lower() and "sherman" in prompt.lower()


def test_prefixed_jarvis_paths_still_trigger_self_update() -> None:
    assert affects_code_factory(["jarvis/services/code-factory/src/code_factory/app.py"])
    assert not affects_code_factory(["sherman/README.md"])


def test_agent_json_output_is_preserved() -> None:
    assert _parse_agent_output('{"result": "done"}') == {"result": "done"}
    assert _parse_agent_output('{"event": 1}\n{"event": 2}') == [
        {"event": 1},
        {"event": 2},
    ]
    assert _parse_agent_output("plain output") is None


def test_agent_failure_message_surfaces_stderr() -> None:
    assert (
        _agent_failure_message(
            1,
            stdout="",
            stderr="ActionRequiredError: usage limit reached\n",
        )
        == "agent exited with status 1\n\nActionRequiredError: usage limit reached"
    )


def test_agent_failure_message_falls_back_to_stdout() -> None:
    assert _agent_failure_message(2, stdout="fatal output\n", stderr="") == (
        "agent exited with status 2\n\nfatal output"
    )


def test_agent_failure_message_is_generic_without_process_output() -> None:
    assert _agent_failure_message(9, stdout="", stderr="") == "agent exited with status 9"


async def test_slow_result_upload_keeps_activity_alive(monkeypatch):
    saving = asyncio.Event()
    saved = asyncio.Event()
    heartbeats = []

    async def persist(task_id, status, **fields):
        if status is TaskStatus.SUCCESS:
            saving.set()
            await saved.wait()
        return SimpleNamespace(status=status)

    environment = ActivityEnvironment()

    def heartbeat(*details):
        if saving.is_set():
            heartbeats.append(details)
            if len(heartbeats) >= 2:
                saved.set()

    environment.on_heartbeat = heartbeat
    monkeypatch.setattr("code_factory.activities.PERSIST_HEARTBEAT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr("code_factory.activities._workspace_revisions", AsyncMock(return_value={}))
    monkeypatch.setattr(
        "code_factory.activities._labeled_changed_paths", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        "code_factory.activities._execute_agent",
        AsyncMock(return_value=AgentProcessResult(0, "raw log", "", {"result": "done"})),
    )
    repository = AsyncMock()
    repository.set_status.side_effect = persist
    activities = AgentActivities(Settings.from_env(), repository)
    await asyncio.wait_for(
        environment.run(
            activities.run_coding_task,
            TaskRunRequest("test-task", "test", "workspace", "gpt-6-sol"),
        ),
        timeout=1,
    )
    assert len(heartbeats) >= 2
    assert repository.set_status.call_args.kwargs["agent_output"] == {"result": "done"}


async def test_usage_limit_fails_without_switching_models_or_prompting(monkeypatch):
    monkeypatch.setattr("code_factory.activities._workspace_revisions", AsyncMock(return_value={}))
    execute = AsyncMock(return_value=AgentProcessResult(1, "", "usage limit reached"))
    monkeypatch.setattr("code_factory.activities._execute_agent", execute)
    monkeypatch.setenv("CODEX_API_KEY", "test-api-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-api-key")
    repository = AsyncMock()
    repository.set_status.return_value = SimpleNamespace(status=TaskStatus.RUNNING)
    await ActivityEnvironment().run(
        AgentActivities(Settings.from_env(), repository).run_coding_task,
        TaskRunRequest("task-1", "ship it", "workspace", "gpt-6-astra"),
    )
    assert execute.await_count == 1
    command, _, environment = execute.call_args.args
    assert command[command.index("--model") + 1] == "gpt-6-astra"
    assert "CODEX_API_KEY" not in environment
    assert "OPENAI_API_KEY" not in environment
    assert repository.set_status.call_args.args[1] == TaskStatus.FAILED
    assert "usage limit" in repository.set_status.call_args.kwargs["error"]


async def test_follow_up_reads_latest_parent_result_when_it_starts(monkeypatch):
    monkeypatch.setattr("code_factory.activities._workspace_revisions", AsyncMock(return_value={}))
    monkeypatch.setattr(
        "code_factory.activities._labeled_changed_paths", AsyncMock(return_value=[])
    )
    execute = AsyncMock(return_value=AgentProcessResult(0, "", "", {"result": "done"}))
    monkeypatch.setattr("code_factory.activities._execute_agent", execute)
    repository = AsyncMock()
    repository.set_status.return_value = SimpleNamespace(status=TaskStatus.RUNNING)
    repository.get.return_value = SimpleNamespace(
        id="parent",
        prompt="Build the page",
        status=TaskStatus.SUCCESS,
        agent_output={"result": "Page completed with new sidebar"},
    )
    await ActivityEnvironment().run(
        AgentActivities(Settings.from_env(), repository).run_coding_task,
        TaskRunRequest("child", "Make the sidebar smaller", "workspace", "gpt-6-sol", "parent"),
    )
    prompt = execute.call_args.args[0][-1]
    assert "Build the page" in prompt
    assert "Page completed with new sidebar" in prompt
    assert prompt.endswith("Make the sidebar smaller")
    repository.get.assert_awaited_once_with("parent")


@pytest.mark.parametrize("status", list(TaskStatus))
async def test_follow_up_dependency_requires_terminal_parent(status):
    repository = AsyncMock()
    repository.get.return_value = SimpleNamespace(status=status)
    finished = await ActivityEnvironment().run(
        AgentActivities(Settings.from_env(), repository).parent_task_finished, "parent"
    )
    assert finished is (status in {TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED})


@pytest.mark.parametrize("model", ["gpt-5.6-terra", "gpt-6-sol", "gpt-6-astra"])
async def test_research_runs_in_own_workspace_and_persists_sanitized_report(
    tmp_path, monkeypatch, model
):
    from dataclasses import replace
    from uuid import uuid4

    settings = replace(
        Settings.from_env(),
        workspace=tmp_path / "engineering",
        research_workspace=tmp_path / "research",
    )
    request = TaskRunRequest(
        str(uuid4()),
        "Compare batteries",
        "research",
        model,
        task_type="research",
        verbosity="in_depth",
    )
    repository = AsyncMock()
    repository.set_status.return_value = SimpleNamespace(status=TaskStatus.RUNNING)

    async def execute(command, workspace, environment, **kwargs):
        assert workspace == settings.research_workspace / request.task_id
        assert (workspace / "AGENTS.md").is_file()
        assert command[command.index("--model") + 1] == model
        assert "in_depth" in command[-1] and "Compare batteries" in command[-1]
        await kwargs["on_progress"]([{"kind": "assistant", "text": "Checking sources"}])
        (workspace / "report.html").write_text(
            "<article><h1>Batteries</h1><p>Verified findings.</p><script>bad()</script></article>"
        )
        return AgentProcessResult(0, "raw stdout", "", {"status": "success", "result": "Ready"})

    monkeypatch.setattr("code_factory.activities._execute_agent", execute)
    revisions = AsyncMock(side_effect=AssertionError("research inspected engineering repositories"))
    monkeypatch.setattr("code_factory.activities._workspace_revisions", revisions)
    paths = AsyncMock(side_effect=AssertionError("research reconciled engineering repositories"))
    monkeypatch.setattr("code_factory.activities._labeled_changed_paths", paths)
    monkeypatch.setattr(
        "code_factory.activities._schedule_self_update",
        lambda *_: pytest.fail("research scheduled a service update"),
    )
    await ActivityEnvironment().run(AgentActivities(settings, repository).run_coding_task, request)
    saved = repository.set_status.call_args
    assert saved.args == (request.task_id, TaskStatus.SUCCESS)
    assert saved.kwargs["report_available"] is True
    assert "Verified findings" in saved.kwargs["report_html"]
    assert "script" not in saved.kwargs["report_html"]
    assert saved.kwargs["changed_paths"] == []
    assert saved.kwargs["self_update_scheduled"] is False
    repository.append_output.assert_awaited_once_with(
        request.task_id, [{"kind": "assistant", "text": "Checking sources"}]
    )


@pytest.mark.parametrize("result", ["missing", "cancel", "agent_failed"])
async def test_research_invalid_result_and_cancellation_never_publish_report(
    tmp_path, monkeypatch, result
):
    from dataclasses import replace
    from uuid import uuid4

    settings = replace(Settings.from_env(), research_workspace=tmp_path / "research")
    request = TaskRunRequest(
        str(uuid4()), "Research", "research", "gpt-6-sol", task_type="research"
    )
    repository = AsyncMock()
    repository.set_status.return_value = SimpleNamespace(status=TaskStatus.RUNNING)

    async def execute(*args, **kwargs):
        if result == "cancel":
            raise asyncio.CancelledError
        if result == "agent_failed":
            return AgentProcessResult(1, "", "Could not verify sources")
        return AgentProcessResult(0, "", "", {"status": "success", "result": "Ready"})

    monkeypatch.setattr("code_factory.activities._execute_agent", execute)
    if result in {"cancel", "missing"}:
        with pytest.raises(asyncio.CancelledError if result == "cancel" else ValueError):
            await ActivityEnvironment().run(
                AgentActivities(settings, repository).run_coding_task, request
            )
    else:
        await ActivityEnvironment().run(
            AgentActivities(settings, repository).run_coding_task, request
        )
    saved = repository.set_status.call_args
    assert saved.args[1] is (TaskStatus.CANCELLED if result == "cancel" else TaskStatus.FAILED)
    assert not saved.kwargs.get("report_available")
    if result == "missing":
        assert "report.html" in saved.kwargs["error"]


async def test_research_follow_up_receives_saved_parent_report(tmp_path, monkeypatch):
    from dataclasses import replace
    from uuid import uuid4

    settings = replace(Settings.from_env(), research_workspace=tmp_path / "research")
    task_id, parent_id = str(uuid4()), str(uuid4())
    repository = AsyncMock()
    repository.set_status.return_value = SimpleNamespace(status=TaskStatus.RUNNING)
    repository.get.return_value = SimpleNamespace(
        id=parent_id,
        task_type="research",
        prompt="Compare batteries",
        status=TaskStatus.SUCCESS,
        report_available=True,
        agent_output={"result": "Report ready"},
        error=None,
    )
    repository.get_report.return_value = {"task_id": parent_id, "html": "<p>Original evidence</p>"}

    async def execute(command, workspace, environment, **kwargs):
        assert (workspace / "previous-report.html").read_text() == "<p>Original evidence</p>"
        assert "previous-report.html" in command[-1]
        (workspace / "report.html").write_text("<p>Updated evidence</p>")
        return AgentProcessResult(0, "", "", {"status": "success", "result": "Updated"})

    monkeypatch.setattr("code_factory.activities._execute_agent", execute)
    await ActivityEnvironment().run(
        AgentActivities(settings, repository).run_coding_task,
        TaskRunRequest(
            task_id, "Update the evidence", "research", "gpt-6-sol", parent_id, task_type="research"
        ),
    )
    assert repository.set_status.call_args.args[1] == TaskStatus.SUCCESS
