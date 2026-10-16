import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from temporalio.testing import ActivityEnvironment

from code_factory.activities import (
    AgentActivities,
    AgentProcessResult,
    _agent_failure_message,
    _parse_agent_output,
    _usage_limit_fallback_model,
    workspace_prompt,
)
from code_factory.config import Settings
from code_factory.git_changes import affects_code_factory
from code_factory.models import TaskRunRequest, TaskStatus


def test_agent_command_explicitly_uses_auto_without_an_override() -> None:
    command = AgentActivities.command(Path("/usr/local/bin/agent"), "do the work")
    assert command == (
        "/usr/local/bin/agent",
        "-p",
        "--force",
        "--trust",
        "--approve-mcps",
        "--model",
        "auto",
        "do the work",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
    )


def test_agent_command_pins_the_requested_model() -> None:
    command = AgentActivities.command(
        Path("/usr/local/bin/agent"),
        "do the work",
        model="gpt-5.6-sol-medium",
    )
    assert command == (
        "/usr/local/bin/agent",
        "-p",
        "--force",
        "--trust",
        "--approve-mcps",
        "--model",
        "gpt-5.6-sol-medium",
        "do the work",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
    )


def test_workspace_prompt_lets_the_agent_choose_repositories() -> None:
    prompt = workspace_prompt("task-9", "Add a health check")
    assert "task-9" in prompt
    assert prompt.endswith("Add a health check")
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


def test_usage_limit_uses_included_fallback_model() -> None:
    assert (
        _usage_limit_fallback_model(
            "claude-fable-5-thinking-high",
            "ActionRequiredError: You've hit your usage limit. Switch to a different model.",
        )
        == "composer-2.5"
    )


def test_usage_limit_does_not_retry_the_fallback_or_unrelated_errors() -> None:
    usage_error = "ActionRequiredError: You've hit your usage limit"
    assert _usage_limit_fallback_model("composer-2.5", usage_error) is None
    assert _usage_limit_fallback_model("gpt-5.6-sol-medium", "network failed") is None


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
            activities.run_coding_task, TaskRunRequest("test-task", "test", "workspace")
        ),
        timeout=1,
    )
    assert len(heartbeats) >= 2
    assert repository.set_status.call_args.kwargs["agent_output"] == {"result": "done"}
