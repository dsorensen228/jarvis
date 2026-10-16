from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from jarvis_api.push import ExpoPushClient, notify_person_detected
from jarvis_api.store import SqliteStore


@pytest.fixture
async def store(tmp_path):
    database = SqliteStore(str(tmp_path / "notifications.sqlite3"))
    await database.start()
    yield database
    await database.close()


async def token(store, token_id="phone", owner="owner"):
    await store.create_entity(
        "push_token",
        owner,
        {
            "platform": "android",
            "provider": "expo",
            "token": f"ExponentPushToken[{token_id}]",
        },
        entity_id=token_id,
    )


class Factory:
    def __init__(self, task):
        self.task = task

    async def get_task(self, task_id):
        assert task_id == self.task["id"]
        return self.task

    get_research_task = get_task


@pytest.mark.parametrize(
    "kind,status,want_type,want_status",
    [
        ("code", "success", "code_task", "completed"),
        ("code", "failed", "code_task", "failed"),
        ("research", "success", "research_task", "completed"),
        ("research", "failed", "research_task", "failed"),
    ],
)
async def test_task_alert_survives_monitor_restart_and_only_notifies_creator(
    store,
    kind,
    status,
    want_type,
    want_status,
):
    from jarvis_api.task_notifications import TaskNotificationService

    posts = []

    def expo(request):
        posts.extend(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"status": "ok", "id": "receipt-one"}]})

    task = {"id": "task-one", "status": "running", "prompt": "Compare battery options"}
    factory = Factory(task)
    await token(store)
    await token(store, "other-phone", owner="other")
    async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as http:
        push = ExpoPushClient(http)
        await TaskNotificationService(store, factory, push).track("owner", task, kind)
        factory.task = {**task, "status": status}
        restarted = TaskNotificationService(store, factory, push)
        await restarted.tick()
        await restarted.tick()
    assert len(posts) == 1
    assert posts[0]["to"] == "ExponentPushToken[phone]"
    assert posts[0]["channelId"] == "task-status"
    assert posts[0]["data"] == {
        "type": want_type,
        "task_id": "task-one",
        "status": want_status,
    }
    assert "Compare battery options" in posts[0]["body"]
    assert (await store.list_all_entities("task_notification"))[0]["status"] == "complete"


async def test_partial_task_push_retries_only_rejected_token(store):
    from jarvis_api.task_notifications import TaskNotificationService

    posts = []

    def expo(request):
        messages = json.loads(request.content)
        posts.append(messages)
        tickets = [
            {"status": "error", "details": {"error": "InvalidCredentials"}}
            if message["to"].endswith("phone-b]") and len(posts) == 1
            else {"status": "ok", "id": f"ticket-{len(posts)}-{i}"}
            for i, message in enumerate(messages)
        ]
        return httpx.Response(200, json={"data": tickets})

    await token(store, "phone-a")
    await token(store, "phone-b")
    task = {"id": "one", "status": "running", "prompt": "Fix the lights"}
    factory = Factory(task)
    async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as http:
        service = TaskNotificationService(store, factory, ExpoPushClient(http))
        await service.track("owner", task, "code")
        factory.task = {**task, "status": "success"}
        await service.tick()
        # A renamed/re-registered device can produce another row for the same Expo token.
        await store.create_entity(
            "push_token",
            "owner",
            {
                "platform": "android",
                "provider": "expo",
                "token": "ExponentPushToken[phone-a]",
            },
            entity_id="renamed-phone-a",
        )
        await service.tick()
        await service.tick()
    assert [len(batch) for batch in posts] == [2, 1]
    assert posts[1][0]["to"] == "ExponentPushToken[phone-b]"


async def test_no_phone_retains_pending_task_until_registration(store):
    from jarvis_api.task_notifications import TaskNotificationService

    posts = []

    def expo(request):
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"status": "ok", "id": "ticket-one"}]})

    task = {"id": "one", "status": "running", "prompt": "Research"}
    factory = Factory(task)
    async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as http:
        service = TaskNotificationService(store, factory, ExpoPushClient(http))
        await service.track("owner", task, "research")
        factory.task = {**task, "status": "failed"}
        await service.tick()
        assert posts == []
        await token(store)
        await service.tick()
    assert len(posts) == 1


async def test_receipt_error_prunes_dead_token_and_updates_camera_delivery(store):
    from jarvis_api.task_notifications import TaskNotificationService

    def expo(request):
        if request.url.path.endswith("/send"):
            return httpx.Response(200, json={"data": [{"status": "ok", "id": "receipt-one"}]})
        return httpx.Response(
            200,
            json={
                "data": {
                    "receipt-one": {
                        "status": "error",
                        "message": "private token",
                        "details": {"error": "DeviceNotRegistered"},
                    }
                }
            },
        )

    await token(store)
    await store.create_entity("camera_event", "owner", {}, entity_id="event-one")
    async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as http:
        push = ExpoPushClient(http)
        result = await notify_person_detected(
            store=store,
            push_client=push,
            user_id="owner",
            device_id="front",
            event_id="event-one",
            alert_text="Someone's at the front door.",
        )
        await store.update_entity("camera_event", "event-one", "owner", {"mobile_push": result})
        await store.update_entity(
            "push_receipt",
            "receipt-one",
            "owner",
            {
                "check_after": "2000-01-01T00:00:00+00:00",
            },
        )
        await TaskNotificationService(store, Factory({}), push).tick()
    assert await store.list_entities("push_token", "owner") == []
    event = await store.get_entity("camera_event", "event-one", "owner")
    assert event["mobile_push"]["receipt_status"] == "error"
    assert "DeviceNotRegistered" in str(event["mobile_push"])
    assert "private token" not in str(event)


async def test_provider_rejection_retries_only_failed_device_after_backoff(store):
    from jarvis_api.task_notifications import TaskNotificationService

    posts = []

    def expo(request):
        if request.url.path.endswith("/getReceipts"):
            return httpx.Response(
                200,
                json={
                    "data": {
                        "ticket-1-0": {
                            "status": "error",
                            "details": {"error": "InvalidCredentials"},
                        },
                        "ticket-1-1": {"status": "ok"},
                    }
                },
            )
        messages = json.loads(request.content)
        posts.append(messages)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"status": "ok", "id": f"ticket-{len(posts)}-{i}"} for i in range(len(messages))
                ]
            },
        )

    await token(store, "phone-a")
    await token(store, "phone-b")
    task = {"id": "one", "status": "running", "prompt": "Fix lights"}
    factory = Factory(task)
    async with httpx.AsyncClient(transport=httpx.MockTransport(expo)) as http:
        service = TaskNotificationService(store, factory, ExpoPushClient(http))
        await service.track("owner", task, "code")
        factory.task = {**task, "status": "success"}
        await service.tick()
        for receipt in await store.list_all_entities("push_receipt"):
            await store.update_entity(
                "push_receipt",
                receipt["id"],
                "owner",
                {
                    "check_after": "2000-01-01T00:00:00+00:00",
                },
            )
        await service.tick()
        row = (await store.list_all_entities("task_notification"))[0]
        assert row["status"] == "pending"
        await service.tick()
        assert len(posts) == 1
        await store.update_entity(
            "task_notification",
            row["id"],
            "owner",
            {
                "retry_after": "2000-01-01T00:00:00+00:00",
            },
        )
        await service.tick()
    assert len(posts) == 2
    assert [message["to"] for message in posts[1]] == [posts[0][0]["to"]]


async def test_camera_phone_push_does_not_wait_for_voice_playback(store):
    from jarvis_api.api.devices import _alert_person_detection

    voice_started, release_voice, push_sent = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def announce(*args, **kwargs):
        voice_started.set()
        await release_voice.wait()
        return []

    async def send(**kwargs):
        push_sent.set()
        return {"status": "no_android_targets", "token_count": 0}

    app = SimpleNamespace(
        state=SimpleNamespace(
            store=store,
            voice_connections=SimpleNamespace(announce=announce),
            push=SimpleNamespace(send_person_detected=send),
        )
    )
    await store.create_entity("camera_event", "owner", {}, entity_id="event")
    task = asyncio.create_task(_alert_person_detection(app, "owner", "front", "event", "At door"))
    try:
        await asyncio.wait_for(voice_started.wait(), 1)
        await asyncio.wait_for(push_sent.wait(), 0.1)
    finally:
        release_voice.set()
        await task


@pytest.mark.parametrize("kind", ["code", "research"])
def test_api_submission_registers_durable_recipient(settings, kind):
    from test_code_factory import TASK, authenticated_client, gateway

    task = {**TASK, "task_type": kind}
    with authenticated_client(
        settings, gateway(lambda request: httpx.Response(202, json=task))
    ) as client:
        response = client.post(
            f"/v1/{kind}-tasks",
            json={
                "prompt": "Do work",
                "model": "gpt-6-sol",
            },
        )
        assert response.status_code == 202
        rows = client.portal.call(client.app.state.store.list_all_entities, "task_notification")
        assert len(rows) == 1
        assert rows[0]["task_id"] == "one"
        assert rows[0]["task_type"] == kind


@pytest.mark.parametrize("kind", ["code", "research"])
async def test_chat_submission_registers_requesting_user(store, kind):
    from jarvis_api.capabilities import Capabilities
    from jarvis_api.task_notifications import TaskNotificationService
    from jarvis_api.tools import ToolContext, ToolRegistry

    class ChatFactory:
        async def create_task(self, *args):
            return {"id": "from-chat", "status": "pending", "prompt": args[0]}

        create_research_task = create_task

    factory = ChatFactory()
    registry = ToolRegistry(
        Capabilities(store),
        code_factory=factory,
        task_notifications=TaskNotificationService(store, factory, None),
    )
    try:
        await registry.execute(
            f"create_{kind}_task",
            ToolContext("speaker", "conversation"),
            json.dumps({"prompt": "Investigate the problem"}),
        )
        rows = await store.list_all_entities("task_notification")
        assert len(rows) == 1
        assert rows[0]["owner_id"] == "speaker"
        assert rows[0]["task_id"] == "from-chat"
    finally:
        await registry.close()


@pytest.mark.parametrize("kind", ["code", "research"])
@pytest.mark.parametrize("operation", ["get", "list"])
async def test_chat_observation_tracks_existing_active_tasks_only(store, kind, operation):
    from jarvis_api.capabilities import Capabilities
    from jarvis_api.task_notifications import TaskNotificationService
    from jarvis_api.tools import ToolContext, ToolRegistry

    class ObservedFactory:
        async def get_task(self, task_id):
            return {"id": "active", "status": "running"}

        async def list_tasks(self, **kwargs):
            return {
                "items": [{"id": "active", "status": "running"}, {"id": "old", "status": "success"}]
            }

        get_research_task = get_task
        list_research_tasks = list_tasks

    factory = ObservedFactory()
    registry = ToolRegistry(
        Capabilities(store),
        code_factory=factory,
        task_notifications=TaskNotificationService(store, factory, None),
    )
    try:
        await registry.execute(
            f"{operation}_{kind}_task" + ("s" if operation == "list" else ""),
            ToolContext("reader", "chat"),
            json.dumps({"task_id": "active"}),
        )
        rows = await store.list_all_entities("task_notification")
        assert [row["task_id"] for row in rows] == ["active"]
        assert rows[0]["owner_id"] == "reader"
    finally:
        await registry.close()


async def test_pending_scan_does_not_allow_finished_history_to_hide_active_task(store):
    await store.create_entity(
        "task_notification", "owner", {"status": "pending"}, entity_id="active"
    )
    await store.create_entity(
        "task_notification", "owner", {"status": "complete"}, entity_id="done"
    )
    rows = await store.list_all_entities("task_notification", limit=1, status="pending")
    assert [row["id"] for row in rows] == ["active"]
