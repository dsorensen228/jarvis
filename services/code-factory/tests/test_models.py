from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from code_factory.models import AGENT_MODELS, CreateTaskRequest, OutputEvent, TaskRecord, TaskStatus


def test_supported_agent_models_are_the_three_ui_choices() -> None:
    assert AGENT_MODELS == (
        "gpt-6-sol",
        "gpt-5.6-terra",
        "gpt-6-astra",
    )


@pytest.mark.parametrize("model", AGENT_MODELS)
def test_create_request_accepts_each_supported_model(model: str) -> None:
    request = CreateTaskRequest(prompt="Ship it", model=model)
    assert request.model == model


def test_create_request_requires_model() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(prompt="Ship it")


@pytest.mark.parametrize("model", [None, "", "auto", "gpt-5.6-sol-medium"])
def test_create_request_rejects_missing_or_old_model(model) -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(prompt="Ship it", model=model)


def test_create_request_rejects_unknown_models() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(prompt="Ship it", model="gpt-2")


@pytest.mark.parametrize(
    "timestamp",
    [
        datetime(2026, 9, 27, 20, 22, 56),
        datetime(2026, 9, 27, 16, 22, 56, tzinfo=timezone(timedelta(hours=-4))),
    ],
)
def test_task_timestamps_declare_utc_for_browser_elapsed_time(timestamp):
    task = TaskRecord(
        id="historical",
        prompt="test",
        status=TaskStatus.RUNNING,
        workflow_id="workflow",
        created_at=timestamp,
        updated_at=timestamp,
        started_at=timestamp,
    )
    encoded = task.model_dump(mode="json")
    for field in ("created_at", "updated_at", "started_at"):
        assert encoded[field] == "2026-09-27T20:22:56Z"
        assert getattr(task, field).tzinfo == UTC
    assert encoded["completed_at"] is None
    event = OutputEvent(seq=1, kind="status", text="Started", created_at=timestamp)
    assert event.model_dump(mode="json")["created_at"] == "2026-09-27T20:22:56Z"


@pytest.mark.parametrize("verbosity", ["concise", "standard", "in_depth"])
def test_research_request_preserves_type_and_verbosity(verbosity: str) -> None:
    request = CreateTaskRequest(
        prompt="Compare heat pumps", model="gpt-6-sol", task_type="research", verbosity=verbosity
    )
    assert request.task_type == "research"
    assert request.verbosity == verbosity


@pytest.mark.parametrize("fields", [{"task_type": "other"}, {"verbosity": "long"}])
def test_create_request_rejects_invalid_task_options(fields: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(prompt="Research this", model="gpt-6-sol", **fields)


def test_historical_tasks_default_to_code_and_report_content_is_excluded():
    from code_factory.models import TaskRecord

    task = TaskRecord.model_validate(
        {
            "id": "old-task",
            "prompt": "Ship it",
            "status": "success",
            "workflow_id": "wf-old",
            "created_at": "2026-10-14T00:00:00Z",
            "updated_at": "2026-10-14T00:00:00Z",
            "report_html": "<p>Separate report</p>",
        }
    )
    assert task.task_type == "code"
    assert task.verbosity == "standard"
    assert not task.report_available
    assert "report_html" not in task.model_dump()
