import base64
import json
import os
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from bson import BSON

from code_factory.models import TaskRecord, TaskStatus
from code_factory.repository import (
    InvalidCursorError,
    TaskRepository,
    _decode_cursor,
    _encode_cursor,
)


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


def test_page_cursor_rejects_malformed_values_and_changed_filters():
    now = datetime.now(UTC)
    task = TaskRecord(
        id="task-1",
        prompt="test",
        status=TaskStatus.RUNNING,
        workflow_id="workflow-1",
        created_at=now,
        updated_at=now,
    )
    cursor = _encode_cursor(task, None, "active")
    assert _decode_cursor(cursor, None, "active") == (now, task.id)
    for value, status, view in [
        ("not-json", None, "active"),
        ("a" * 1025, None, "active"),
        (cursor, TaskStatus.RUNNING, "active"),
        (cursor, None, "history"),
    ]:
        with pytest.raises(InvalidCursorError):
            _decode_cursor(value, status, view)


def test_naive_and_aware_utc_cursors_refer_to_same_page_boundary():
    boundary = datetime(2026, 9, 27, 20, 22, 56, tzinfo=UTC)
    for timestamp in (
        "2026-09-27T20:22:56",
        "2026-09-27T20:22:56+00:00",
        "2026-09-27T16:22:56-04:00",
    ):
        cursor = base64.urlsafe_b64encode(
            json.dumps([timestamp, "one", None, "all", "code"]).encode()
        ).decode()
        assert _decode_cursor(cursor, None, "all") == (boundary, "one")


async def test_pagination_stays_stable_when_new_tasks_arrive(mongo_repository):
    repository = mongo_repository
    now = datetime.now(UTC).replace(microsecond=0)
    tasks = []
    for index in range(7):
        task = await repository.create(prompt=f"task {index}", repository="workspace")
        await repository.update(task.id, created_at=now)
        tasks.append(task)
    expected = sorted((task.id for task in tasks), reverse=True)
    first = await repository.list_page(limit=3, status=None)
    assert [task.id for task in first.items] == expected[:3]
    assert first.next_cursor
    newest = await repository.create(prompt="arrived during scroll", repository="workspace")
    second = await repository.list_page(limit=3, status=None, cursor=first.next_cursor)
    third = await repository.list_page(limit=3, status=None, cursor=second.next_cursor)
    actual = [task.id for page in (first, second, third) for task in page.items]
    assert actual == expected
    assert newest.id not in actual
    assert third.next_cursor is None


async def test_pagination_filters_active_history_and_specific_status(mongo_repository):
    repository = mongo_repository
    active = await repository.create(prompt="active", repository="workspace")
    terminal = await repository.create(prompt="completed", repository="workspace")
    await repository.set_status(terminal.id, TaskStatus.SUCCESS)
    assert [
        task.id for task in (await repository.list_page(limit=5, status=None, view="active")).items
    ] == [active.id]
    assert [
        task.id for task in (await repository.list_page(limit=5, status=None, view="history")).items
    ] == [terminal.id]
    assert [
        task.id for task in (await repository.list_page(limit=5, status=TaskStatus.SUCCESS)).items
    ] == [terminal.id]
    with pytest.raises(InvalidCursorError):
        await repository.list_page(limit=5, status=TaskStatus.RUNNING, view="active")


async def test_output_persists_incrementally_with_retention_and_reconnect(mongo_repository):
    repository = mongo_repository
    task = await repository.create(prompt="stream", repository="workspace")
    await repository.append_output(task.id, [{"kind": "assistant", "text": "first message"}])
    first = await repository.output(task.id, after=0, limit=100)
    assert first.next_after == 1
    assert first.items[0].text == "first message"
    assert first.task.status is TaskStatus.PENDING
    assert first.task.output_seq == 1
    await repository.append_output(
        task.id, [{"kind": "tool", "text": str(index) + "x" * 5000} for index in range(300)]
    )
    page = await repository.output(task.id, after=0, limit=200)
    assert page.truncated
    assert page.has_more
    assert page.items[0].seq == 2
    assert page.next_after == 201
    assert all(len(event.text) == 2000 for event in page.items)
    last = await repository.output(task.id, after=page.next_after, limit=200)
    assert len(last.items) == 100
    assert last.next_after == 301
    assert not last.has_more
    assert not last.truncated
    empty = await repository.output(task.id, after=last.next_after, limit=200)
    assert empty.items == []
    assert empty.next_after == 301
    assert (await repository.get(task.id)).output_seq == 301


async def test_concurrent_progress_writers_allocate_unique_sequences(mongo_repository):
    import asyncio

    task = await mongo_repository.create(prompt="parallel", repository="workspace")
    await asyncio.gather(
        *[
            mongo_repository.append_output(task.id, [{"kind": "assistant", "text": str(index)}])
            for index in range(20)
        ]
    )
    page = await mongo_repository.output(task.id, after=0, limit=100)
    assert [event.seq for event in page.items] == list(range(1, 21))
    assert {event.text for event in page.items} == {str(index) for index in range(20)}


async def test_output_cursor_and_limit_bound_the_actual_mongo_transfer(mongo_repository):
    repository = mongo_repository
    task = await repository.create(prompt="bandwidth regression", repository="workspace")
    events = [{"kind": "assistant", "text": "x" * 2000} for _ in range(300)]
    await repository.append_output(task.id, events)
    find_one = repository._tasks.find_one
    full_document = find_one({"_id": task.id})
    assert len(BSON.encode(full_document)) > 600_000
    transferred = []

    def observe_response(*args, **kwargs):
        document = find_one(*args, **kwargs)
        transferred.append(document)
        return document

    with patch.object(repository._tasks, "find_one", side_effect=observe_response):
        tail = await repository.output(task.id, after=297, limit=1)
        assert [event.seq for event in tail.items] == [298]
        assert tail.has_more
        assert [event["seq"] for event in transferred[-1]["output_events"]] == [298, 299]
        assert len(BSON.encode(transferred[-1])) < 10_000

        idle = await repository.output(task.id, after=300, limit=100)
        assert idle.items == []
        assert idle.next_after == 300
        assert not idle.truncated
        assert transferred[-1]["output_events"] == []
        assert len(BSON.encode(transferred[-1])) < 2_000

        # A newer retention window must still indicate a gap without returning
        # the omitted history just to calculate its first sequence number.
        await repository.append_output(task.id, events)
        gap = await repository.output(task.id, after=0, limit=1)
        assert gap.truncated
        assert gap.next_after == 301
        assert gap.has_more
        assert [event["seq"] for event in transferred[-1]["output_events"]] == [301, 302]
        assert len(BSON.encode(transferred[-1])) < 10_000


async def test_output_for_legacy_task_without_progress_fields(mongo_repository):
    task = await mongo_repository.create(prompt="legacy", repository="workspace")
    mongo_repository._tasks.update_one(
        {"_id": task.id}, {"$unset": {"output_events": "", "output_seq": ""}}
    )
    page = await mongo_repository.output(task.id, after=0, limit=1)
    assert page.items == []
    assert page.next_after == 0
    assert not page.has_more
    assert not page.truncated


def test_pagination_cursor_is_bound_to_task_type():
    now = datetime.now(UTC)
    task = TaskRecord(
        id="research-1",
        prompt="Research",
        status=TaskStatus.SUCCESS,
        workflow_id="wf",
        created_at=now,
        updated_at=now,
        task_type="research",
    )
    cursor = _encode_cursor(task, None, "history", "research")
    assert _decode_cursor(cursor, None, "history", "research") == (now, task.id)
    with pytest.raises(InvalidCursorError):
        _decode_cursor(cursor, None, "history", "code")


async def test_listing_queries_include_legacy_code_and_isolate_research():
    repository = TaskRepository.__new__(TaskRepository)
    repository._tasks = MagicMock()
    repository._tasks.find.return_value.sort.return_value.limit.return_value = []
    await repository.list_page(limit=10, status=None)
    query, projection = repository._tasks.find.call_args.args
    assert query == {"$or": [{"task_type": "code"}, {"task_type": {"$exists": False}}]}
    assert "report_html" not in projection
    await repository.list_page(limit=10, status=TaskStatus.SUCCESS, task_type="research")
    assert repository._tasks.find.call_args.args[0] == {
        "task_type": "research",
        "status": "success",
    }
    await repository.list(limit=10, status=None, task_type="research")
    assert repository._tasks.find.call_args.args[0] == {"task_type": "research"}


async def test_report_lookup_requires_completed_research_and_returns_only_artifact():
    from code_factory.repository import TaskNotFoundError

    repository = TaskRepository.__new__(TaskRepository)
    repository._tasks = MagicMock()
    repository._tasks.find_one.return_value = {"report_html": "<p>Findings</p>"}
    assert await repository.get_report("research-1") == {
        "task_id": "research-1",
        "html": "<p>Findings</p>",
    }
    assert repository._tasks.find_one.call_args.args == (
        {
            "_id": "research-1",
            "task_type": "research",
            "status": "success",
            "report_available": True,
        },
        {"report_html": 1},
    )
    for document in (None, {}, {"report_html": ""}):
        repository._tasks.find_one.return_value = document
        with pytest.raises(TaskNotFoundError):
            await repository.get_report("research-1")


async def test_legacy_research_isolation_and_report_visibility(mongo_repository):
    repo = mongo_repository
    legacy = await repo.create(prompt="legacy", repository="workspace")
    repo._tasks.update_one({"_id": legacy.id}, {"$unset": {"task_type": ""}})
    research = await repo.create(prompt="research", repository="research", task_type="research")
    await repo.set_status(
        research.id,
        TaskStatus.SUCCESS,
        report_available=True,
        report_html="<article><p>Verified facts</p></article>",
    )
    assert [item.id for item in (await repo.list_page(limit=10, status=None)).items] == [legacy.id]
    assert [
        item.id
        for item in (await repo.list_page(limit=10, status=None, task_type="research")).items
    ] == [research.id]
    for task in (
        await repo.get(research.id),
        (await repo.output(research.id, after=0, limit=1)).task,
    ):
        assert task.report_available
        assert task.report_html is None
    assert (await repo.get_report(research.id))[
        "html"
    ] == "<article><p>Verified facts</p></article>"
