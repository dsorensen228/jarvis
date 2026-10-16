import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from code_factory.models import TaskStatus
from code_factory.repository import TaskRepository


@pytest.fixture
async def mongo_repository():
    uri = os.environ.get("CODE_FACTORY_TEST_MONGO_URI")
    if not uri:
        pytest.skip("requires explicitly configured Atlas integration access")
    repository = TaskRepository(uri, "jarvis", f"factory_preview_test_{uuid4().hex}")
    try:
        await repository.initialize()
        yield repository
    finally:
        repository._tasks.drop()
        await repository.close()


def test_database_operations_have_a_deadline():
    with patch("code_factory.repository.MongoClient") as client:
        TaskRepository("mongodb://localhost", "jarvis", "code_factory_tasks")
    assert 0 < client.call_args.kwargs["timeoutMS"] < 30_000


async def test_readiness_checks_storage_without_recreating_indexes():
    repository = TaskRepository.__new__(TaskRepository)
    repository._client = MagicMock()
    repository._tasks = MagicMock()
    await repository.ping()
    repository._client.admin.command.assert_called_once_with("ping")
    repository._tasks.find_one.assert_called_once_with({}, {"_id": 1})
    repository._tasks.create_index.assert_not_called()


async def test_large_logs_stay_in_storage_but_reads_and_writes_return_previews(mongo_repository):
    repository = mongo_repository
    task_id = None
    try:
        task = await repository.create(
            prompt="factory-log-preview-regression", repository="workspace"
        )
        task_id = task.id
        # More than 2 MiB, with multibyte text to exercise character-safe server projection.
        raw = "日🙂" * 350_000 + "\nfinal diagnostic line"
        output = {"type": "result", "result": "Complete final result remains readable"}
        updated = await repository.update(task_id, stdout=raw, stderr="short diagnostic")
        assert len(updated.stdout) < 5_000
        assert "earlier output omitted" in updated.stdout
        assert updated.stdout.endswith("final diagnostic line")
        assert updated.stderr == "short diagnostic"

        active = next(item for item in await repository.list_active() if item.id == task_id)
        assert active.stdout == updated.stdout

        completed = await repository.set_status(task_id, TaskStatus.SUCCESS, agent_output=output)
        detail = await repository.get(task_id)
        listed = next(
            item
            for item in await repository.list(limit=200, status=TaskStatus.SUCCESS)
            if item.id == task_id
        )
        for item in (completed, detail, listed):
            assert item.stdout == updated.stdout
            assert item.stderr == "short diagnostic"
            assert item.agent_output == output
            assert item.status == TaskStatus.SUCCESS

        # A late status write must still preserve terminal results.
        assert (
            await repository.set_status(task_id, TaskStatus.CANCELLED)
        ).status == TaskStatus.SUCCESS
        stored = repository._tasks.find_one({"_id": task_id}, {"length": {"$strLenCP": "$stdout"}})
        assert stored["length"] == len(raw)

        await repository.update(task_id, stdout=None, stderr="")
        assert (await repository.get(task_id)).stdout is None
        assert (await repository.get(task_id)).stderr == ""
    finally:
        if task_id is not None:
            repository._tasks.delete_one({"_id": task_id})


@pytest.mark.parametrize("final_result", [False, True])
async def test_large_event_stream_returns_final_result_or_assistant_preview(
    mongo_repository, final_result
):
    repository = mongo_repository
    task = await repository.create(prompt="stream-preview-regression", repository="workspace")
    stream = [
        {"type": "tool_call", "output": "x" * 1_700_000},
        {"type": "thinking", "text": "private reasoning must not be in previews"},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "日🙂" * 3000},
                ]
            },
        },
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Final diagnostic answer"},
                ]
            },
        },
    ]
    result = {"type": "result", "result": "Completed final answer", "is_error": False}
    if final_result:
        stream.extend([result, {"type": "system", "message": "shutdown"}])
    updated = await repository.update(task.id, agent_output=stream)
    for record in (
        updated,
        await repository.get(task.id),
        (await repository.list(limit=50, status=None))[0],
        (await repository.list_active())[0],
        await repository.set_status(task.id, TaskStatus.FAILED),
    ):
        output = record.agent_output
        assert len(str(output)) < 5000
        if final_result:
            assert output == result
        else:
            assert output["result"].endswith("Final diagnostic answer")
            assert "complete output retained in storage" in output["result"]
            assert "private reasoning" not in output["result"]
    stored = repository._tasks.find_one({"_id": task.id}, {"count": {"$size": "$agent_output"}})
    assert stored["count"] == len(stream)


@pytest.mark.parametrize(
    "output",
    [
        None,
        "ordinary answer",
        {"result": "ordinary answer", "extra": [1, 2]},
        "日🙂" * 20_000,
        {"result": "日🙂" * 20_000},
        {"nested": {"big": "x" * 100_000}},
    ],
)
async def test_result_preview_bounds_large_values_and_preserves_small_results(
    mongo_repository, output
):
    task = await mongo_repository.create(prompt="result-preview-regression", repository="workspace")
    updated = await mongo_repository.update(task.id, agent_output=output)
    assert len(str(updated.agent_output)) < 5000
    if len(str(output)) < 5000:
        assert updated.agent_output == output
    else:
        assert "omitted" in updated.agent_output["result"]
