from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import replace
from unittest.mock import patch

from conftest import FakeCodeFactory, FakeLlm, FakeSpeech
from fastapi.testclient import TestClient

from jarvis_api.app import create_app


def authenticated_client(settings, code_factory_client=None):
    app = create_app(
        settings,
        llm=FakeLlm(),
        speech_service=FakeSpeech(),
        code_factory_client=code_factory_client,
    )
    client = TestClient(app)
    client.__enter__()
    response = client.post(
        "/v1/auth/token",
        json={"username": "owner", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    client.headers.update({"Authorization": f"Bearer {token}"})
    return client


def test_health_and_identity(settings):
    with authenticated_client(settings) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        ready = client.get("/health/ready")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ok"

        me = client.get("/v1/users/me")
        assert me.status_code == 200
        assert me.json()["username"] == "owner"

        updated = client.patch(
            "/v1/users/me", json={"name": "David", "settings": {"theme": "dark"}}
        )
        assert updated.json()["name"] == "David"
        assert updated.json()["settings"] == {"theme": "dark"}

        pair = client.post(
            "/v1/auth/token",
            json={"username": "owner", "password": "correct horse battery staple"},
        ).json()
        assert (
            client.post(
                "/v1/auth/logout", json={"refresh_token": pair["refresh_token"]}
            ).status_code
            == 204
        )
        assert (
            client.post(
                "/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]}
            ).status_code
            == 401
        )


def test_google_login_maps_allowlisted_identity_to_local_owner(settings):
    configured = replace(
        settings,
        google_client_id="web-client.apps.googleusercontent.com",
        google_login_subjects=["google-owner-subject"],
    )
    app = create_app(configured, llm=FakeLlm(), speech_service=FakeSpeech())
    claims = {
        "sub": "google-owner-subject",
        "email": "owner@example.com",
        "email_verified": True,
    }
    with patch("jarvis_api.auth.google_id_token.verify_oauth2_token", return_value=claims):
        with TestClient(app) as client:
            response = client.post(
                "/v1/auth/google", json={"google_id_token": "valid-google-token"}
            )
            assert response.status_code == 200, response.text
            me = client.get(
                "/v1/users/me",
                headers={"Authorization": "Bearer " + response.json()["access_token"]},
            )
            assert me.status_code == 200
            assert me.json()["username"] == "owner"


def test_google_login_rejects_unallowlisted_or_unverified_identity(settings):
    configured = replace(
        settings,
        google_client_id="web-client.apps.googleusercontent.com",
        google_login_subjects=["google-owner-subject"],
    )
    app = create_app(configured, llm=FakeLlm(), speech_service=FakeSpeech())
    with TestClient(app) as client:
        for claims in (
            {"sub": "someone-else", "email_verified": True},
            {"sub": "google-owner-subject", "email_verified": False},
        ):
            with patch("jarvis_api.auth.google_id_token.verify_oauth2_token", return_value=claims):
                response = client.post(
                    "/v1/auth/google", json={"google_id_token": "unauthorized-google-token"}
                )
            assert response.status_code == 401


def test_google_login_reports_missing_server_configuration(settings):
    app = create_app(settings, llm=FakeLlm(), speech_service=FakeSpeech())
    with TestClient(app) as client:
        response = client.post("/v1/auth/google", json={"google_id_token": "some-google-token"})
        assert response.status_code == 503


def test_google_login_reports_transport_failure_fetching_certs(settings):
    """DNS/network failures fetching Google JWKS must not surface as opaque 500s."""
    from google.auth.exceptions import TransportError

    configured = replace(
        settings,
        google_client_id="web-client.apps.googleusercontent.com",
        google_login_subjects=["google-owner-subject"],
    )
    app = create_app(configured, llm=FakeLlm(), speech_service=FakeSpeech())
    with patch(
        "jarvis_api.auth.google_id_token.verify_oauth2_token",
        side_effect=TransportError("Failed to resolve www.googleapis.com"),
    ):
        with TestClient(app) as client:
            response = client.post(
                "/v1/auth/google", json={"google_id_token": "unreachable-certs-token"}
            )
    assert response.status_code == 503
    assert "Google" in response.json()["detail"]


def test_manual_code_task_gateway_is_authenticated(settings):
    code_factory = FakeCodeFactory()
    app = create_app(
        settings,
        llm=FakeLlm(),
        speech_service=FakeSpeech(),
        code_factory_client=code_factory,
    )
    with TestClient(app) as anonymous:
        assert anonymous.get("/v1/code-tasks").status_code == 401
        assert (
            anonymous.post(
                "/v1/code-tasks",
                json={"prompt": "Update the docs"},
            ).status_code
            == 401
        )

    with authenticated_client(settings, code_factory) as client:
        created = client.post(
            "/v1/code-tasks",
            json={"prompt": "  Update the docs  "},
        )
        assert created.status_code == 202, created.text
        assert created.json()["prompt"] == "Update the docs"
        assert created.json()["repository"] == "workspace"
        ignored = client.post(
            "/v1/code-tasks",
            json={"prompt": "Legacy client", "repository": "sherman"},
        )
        assert ignored.status_code == 202, ignored.text
        assert ignored.json()["repository"] == "workspace"
        assert ignored.json()["model"] is None
        for model in (
            "gpt-5.6-sol-medium",
            "claude-opus-5-thinking-high",
            "claude-fable-5-thinking-high",
        ):
            pinned = client.post(
                "/v1/code-tasks",
                json={"prompt": "Pin the agent model", "model": model},
            )
            assert pinned.status_code == 202, pinned.text
            assert pinned.json()["model"] == model
        unknown = client.post(
            "/v1/code-tasks",
            json={"prompt": "Pin the agent model", "model": "gpt-2"},
        )
        assert unknown.status_code == 422
        assert client.get("/v1/code-tasks").json()[0]["id"] == "task-1"
        assert client.get("/v1/code-tasks/task-1").json()["status"] == "pending"
        cancelled = client.post("/v1/code-tasks/task-1/cancel")
        assert cancelled.json()["status"] == "cancel_requested"


def test_personal_data_crud(settings):
    with authenticated_client(settings) as client:
        created = client.post("/v1/todos", json={"title": "Buy coffee", "category": "home"})
        assert created.status_code == 201
        todo_id = created.json()["id"]
        assert client.patch(f"/v1/todos/{todo_id}", json={"completed": True}).json()["completed"]
        assert len(client.get("/v1/todos").json()) == 1
        assert client.delete(f"/v1/todos/{todo_id}").status_code == 204

        shopping = client.post("/v1/shopping-lists", json={"name": "Groceries"}).json()
        changed = client.patch(
            "/v1/shopping-lists/{}".format(shopping["id"]), json={"add_items": ["milk", "eggs"]}
        ).json()
        assert [item["text"] for item in changed["items"]] == ["milk", "eggs"]

        timer = client.post("/v1/timers", json={"label": "Tea", "duration_seconds": 60})
        assert timer.status_code == 201
        paused = client.patch("/v1/timers/{}".format(timer.json()["id"]), json={"action": "pause"})
        assert paused.json()["status"] == "paused"

        memory = client.post(
            "/v1/memories", json={"content": "I prefer dark roast coffee", "category": "taste"}
        )
        assert memory.status_code == 201
        assert (
            client.get("/v1/memories", params={"q": "coffee"}).json()[0]["content"]
            == "I prefer dark roast coffee"
        )


def test_conversation_and_chat(settings):
    llm = FakeLlm("A concise local answer.")
    app = create_app(settings, llm=llm, speech_service=FakeSpeech())
    with TestClient(app) as client:
        pair = client.post(
            "/v1/auth/token",
            json={"username": "owner", "password": "correct horse battery staple"},
        ).json()
        headers = {"Authorization": "Bearer {}".format(pair["access_token"])}
        response = client.post("/v1/chat", headers=headers, json={"message": "Hi"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["response"] == "A concise local answer."

        conversation = client.get(
            "/v1/conversations/{}".format(body["conversation_id"]), headers=headers
        ).json()
        assert [message["role"] for message in conversation["messages"]] == [
            "user",
            "assistant",
        ]
        assert llm.requests


def test_projects_and_text_assets(settings):
    with authenticated_client(settings) as client:
        project = client.post(
            "/v1/projects", json={"title": "Workshop", "description": "Build things"}
        ).json()
        asset = client.post(
            "/v1/assets/text",
            json={
                "title": "Notes",
                "body": "use walnut and brass",
                "project_id": project["id"],
                "keywords": ["materials"],
            },
        ).json()
        results = client.get("/v1/assets", params={"query": "walnut"}).json()
        assert [row["id"] for row in results] == [asset["id"]]
        content = client.get("/v1/assets/{}/content".format(asset["id"]))
        assert content.text == "use walnut and brass"


def test_project_tree_folders_and_file_upload(settings):
    with authenticated_client(settings) as client:
        project = client.post("/v1/projects", json={"title": "Camera migration"}).json()
        folder = client.post(f"/v1/projects/{project['id']}/folders", json={"name": "Notes"})
        assert folder.status_code == 201, folder.text
        uploaded = client.post(
            "/v1/assets/files",
            data={"project_id": project["id"], "parent_id": folder.json()["id"]},
            files={"file": ("checklist.txt", b"verify camera", "text/plain")},
        )
        assert uploaded.status_code == 201, uploaded.text
        tree = client.get(f"/v1/projects/{project['id']}/tree").json()
        assert {(node["type"], node["name"]) for node in tree} == {
            ("folder", "Notes"),
            ("asset", "checklist.txt"),
        }
        assert (
            client.delete(f"/v1/projects/{project['id']}/nodes/{folder.json()['id']}").status_code
            == 204
        )
        assert client.get(f"/v1/projects/{project['id']}/tree").json() == []


def test_mobile_identity_avatar_and_push_token(settings):
    with authenticated_client(settings) as client:
        users = client.get("/v1/users")
        assert users.status_code == 200
        assert users.json()[0]["username"] == "owner"
        avatar = client.post(
            "/v1/users/me/avatar", files={"file": ("avatar.jpg", b"jpeg", "image/jpeg")}
        )
        assert avatar.status_code == 200, avatar.text
        assert client.get(avatar.json()["avatar_url"]).content == b"jpeg"
        token = {
            "token": "ExponentPushToken[test]",
            "provider": "expo",
            "platform": "android",
            "device_id": "phone",
        }
        assert client.post("/v1/users/me/push-tokens", json=token).status_code == 200
        removed = client.request("DELETE", "/v1/users/me/push-tokens", json={"device_id": "phone"})
        assert removed.json()["deactivated"] == 1


def test_camera_registration_session_and_idempotent_event(settings):
    with authenticated_client(settings) as client:
        registration = client.put(
            "/v1/devices/camera-one/registration",
            json={
                "name": "Porch",
                "base_url": "http://camera-one.local:8089",
                "callback_token": "camera-callback-secret",
                "metadata": {
                    "connected": True,
                    "person_alert_text": "Someone's at the side door.",
                },
            },
        )
        assert registration.status_code == 200, registration.text
        device = client.get("/v1/devices").json()[0]
        assert device["id"] == "camera-one"
        assert device["user_id"]
        assert "callback" not in str(device).lower()
        changed_kind = client.patch("/v1/devices/camera-one", json={"kind": "voice"}).json()
        assert changed_kind["kind"] == "voice"
        assert changed_kind["user_id"] == device["user_id"]
        assert client.patch("/v1/devices/camera-one", json={"kind": "camera"}).status_code == 200
        with sqlite3.connect(str(settings.database_path)) as database:
            encrypted = database.execute(
                "SELECT value FROM secrets WHERE namespace='device_callback'"
            ).fetchone()[0]
        assert "camera-callback-secret" not in encrypted
        session = client.post("/v1/devices/camera-one/camera/stream-session")
        assert session.status_code == 200
        assert session.json()["camera_token"] not in str(device)

        event_data = {
            "event_id": "event-1",
            "event_type": "person_detected",
            "captured_at": "2026-08-11T00:00:00+00:00",
            "confidence": "0.87",
        }
        first = client.post(
            "/v1/devices/camera-one/camera/events",
            data=event_data,
            files={"frame": ("frame.jpg", b"\xff\xd8jpeg\xff\xd9", "image/jpeg")},
        )
        second = client.post(
            "/v1/devices/camera-one/camera/events",
            data=event_data,
            files={"frame": ("frame.jpg", b"\xff\xd8jpeg\xff\xd9", "image/jpeg")},
        )
        assert first.status_code == second.status_code == 201
        assert first.json()["id"] == second.json()["id"]
        with sqlite3.connect(str(settings.database_path)) as database:
            event_json = database.execute(
                "SELECT data FROM entities WHERE kind='camera_event' AND id=?",
                (first.json()["id"],),
            ).fetchone()[0]
        announcement = json.loads(event_json)["announcement"]
        assert announcement["status"] == "no_connected_targets"
        assert announcement["text"] == "Someone's at the side door."
        mobile_push = json.loads(event_json)["mobile_push"]
        assert mobile_push["status"] == "no_android_targets"
        assert mobile_push["text"] == "Someone's at the side door."
        assert mobile_push["type"] == "person_detected"
        bad_frame = client.post(
            "/v1/devices/camera-one/camera/events",
            data={**event_data, "event_id": "bad-frame"},
            files={"frame": ("frame.txt", b"not a jpeg", "text/plain")},
        )
        assert bad_frame.status_code == 415


def test_camera_person_detected_pushes_android_expo_tokens(settings):
    posts = []

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"status": "ok"}]}

    async def fake_post(url, json=None):
        posts.append({"url": url, "json": json})
        return FakeResponse()

    with authenticated_client(settings) as client:
        assert (
            client.put(
                "/v1/devices/camera-one/registration",
                json={
                    "name": "Porch",
                    "base_url": "http://camera-one.local:8089",
                    "callback_token": "camera-callback-secret",
                    "metadata": {"person_alert_text": "Someone's at the side door."},
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/v1/users/me/push-tokens",
                json={
                    "token": "ExponentPushToken[android-phone]",
                    "provider": "expo",
                    "platform": "android",
                    "device_id": "pixel",
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/v1/users/me/push-tokens",
                json={
                    "token": "ExponentPushToken[iphone]",
                    "provider": "expo",
                    "platform": "ios",
                    "device_id": "iphone",
                },
            ).status_code
            == 200
        )
        client.app.state.push._http.post = fake_post  # type: ignore[method-assign]
        first = client.post(
            "/v1/devices/camera-one/camera/events",
            data={
                "event_id": "push-event-1",
                "event_type": "person_detected",
                "captured_at": "2026-08-11T00:00:00+00:00",
                "confidence": "0.91",
            },
        )
        assert first.status_code == 201, first.text
        # Retry must not send a second push.
        second = client.post(
            "/v1/devices/camera-one/camera/events",
            data={
                "event_id": "push-event-1",
                "event_type": "person_detected",
                "captured_at": "2026-08-11T00:00:00+00:00",
                "confidence": "0.91",
            },
        )
        assert second.status_code == 201
        assert len(posts) == 1
        assert posts[0]["url"] == "https://exp.host/--/api/v2/push/send"
        messages = posts[0]["json"]
        assert len(messages) == 1
        assert messages[0]["to"] == "ExponentPushToken[android-phone]"
        assert messages[0]["body"] == "Someone's at the side door."
        assert messages[0]["channelId"] == "camera-person"
        assert messages[0]["data"]["type"] == "person_detected"
        assert messages[0]["data"]["device_id"] == "camera-one"
        with sqlite3.connect(str(settings.database_path)) as database:
            event_json = database.execute(
                "SELECT data FROM entities WHERE kind='camera_event' AND id=?",
                (first.json()["id"],),
            ).fetchone()[0]
        mobile_push = json.loads(event_json)["mobile_push"]
        assert mobile_push["status"] == "sent"
        assert mobile_push["token_count"] == 1


def test_wear_chat_returns_kokoro_pcm(settings):
    with authenticated_client(settings) as client:
        response = client.post("/v1/wear/chat", json={"message": "Hello"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["response"] == "Hello from Jarvis."
        assert body["audio_encoding"] == "pcm_s16le"
        assert body["sample_rate"] == 24000
        assert body["audio_base64"]


def test_old_operating_mode_routes_are_not_carried_forward(settings):
    with authenticated_client(settings) as client:
        for path in (
            "/pi/chat",
            "/wear/jarvis",
            "/jarvis-chat",
            "/agent/todos",
            "/voice/realtime",
        ):
            assert client.post(path, json={}).status_code == 404


HA_TOKEN = "top-secret-home-assistant-token"


@contextmanager
def smart_home_client(settings, home_assistant):
    """A client whose smart-home service talks to the fake Home Assistant.

    The service is built by the app's lifespan, so the adapter can only be
    swapped once startup has run. Entering the client again would rebuild it.
    """
    client = authenticated_client(
        replace(
            settings,
            home_assistant_url="http://home-assistant.invalid:8123",
            home_assistant_token=HA_TOKEN,
        )
    )
    client.app.state.smart_home.client = home_assistant
    try:
        yield client
    finally:
        client.__exit__(None, None, None)


def test_the_home_assistant_token_is_never_stored_or_returned(settings, home_assistant):
    """Vendor credentials moved to Home Assistant; Jarvis holds only a deploy secret."""
    with smart_home_client(settings, home_assistant) as client:
        bodies = [client.post("/v1/smart-home/sync").text]
        for path in (
            "/v1/integrations",
            "/v1/smart-home",
            "/v1/smart-devices",
            "/v1/users/me",
        ):
            response = client.get(path)
            assert response.status_code == 200, response.text
            bodies.append(response.text)
        assert not any(HA_TOKEN in body for body in bodies)

        # Nor does it reach the database: it is configuration, not a stored secret.
        with sqlite3.connect(str(settings.database_path)) as database:
            dump = "\n".join(line for line in database.iterdump())
        assert HA_TOKEN not in dump
        assert (
            database_rows(settings, "SELECT COUNT(*) FROM secrets WHERE namespace='govee'")[0][0]
            == 0
        )


def test_integration_status_reports_home_assistant_and_keeps_personal_accounts(
    settings, home_assistant
):
    with smart_home_client(settings, home_assistant) as client:
        statuses = client.get("/v1/integrations").json()
        assert statuses["home_assistant"]["connected"] is True
        assert statuses["home_assistant"]["platform"] == "home_assistant"
        # Personal integrations are untouched by the smart-home migration.
        assert "gmail" in statuses
        # And the vendor integrations are gone rather than aliased.
        assert "govee" not in statuses and "roku" not in statuses
        assert client.put("/v1/integrations/govee", json={}).status_code == 404


def test_devices_can_be_imported_labelled_and_commanded_over_http(settings, home_assistant):
    with smart_home_client(settings, home_assistant) as client:
        imported = client.post("/v1/smart-home/sync")
        assert imported.status_code == 200, imported.text
        devices = {device["source_name"]: device for device in imported.json()}
        assert set(devices) == {
            "Office 1",
            "Kitchen Table 1",
            "Desk light",
            "Office Dual Smart Plug",
            "Demo TV",
        }

        lamp = devices["Office 1"]
        assert lamp["platform"] == "home_assistant"
        assert lamp["capabilities"] == ["brightness", "color", "color_temperature", "power"]

        renamed = client.patch(
            f"/v1/smart-devices/{lamp['id']}",
            json={"name": "Office lamp", "room": "office"},
        )
        assert renamed.status_code == 200, renamed.text
        assert (renamed.json()["name"], renamed.json()["room"]) == ("Office lamp", "office")

        command = client.post(
            f"/v1/smart-devices/{lamp['id']}/commands",
            json={"action": "brightness", "parameters": {"percent": 30}},
        )
        assert command.status_code == 200, command.text
        assert command.json()["brightness_percent"] == 30
        assert home_assistant.calls == [
            ("light", "turn_on", {"entity_id": "light.office_1", "brightness": 76})
        ]

        # A re-import keeps the label the owner just set.
        again = client.post("/v1/smart-home/sync").json()
        assert [d["name"] for d in again if d["id"] == lamp["id"]] == ["Office lamp"]


def test_a_socket_is_addressable_without_disturbing_the_other_outlet(settings, home_assistant):
    with smart_home_client(settings, home_assistant) as client:
        devices = {d["source_name"]: d for d in client.post("/v1/smart-home/sync").json()}
        plug = devices["Office Dual Smart Plug"]
        assert [component["name"] for component in plug["components"]] == [
            "",
            "Socket 1",
            "Socket 2",
        ]

        response = client.post(
            f"/v1/smart-devices/{plug['id']}/commands",
            json={"action": "turn_off", "component": "socket_2"},
        )
        assert response.status_code == 200, response.text
        assert home_assistant.calls == [
            ("switch", "turn_off", {"entity_id": "switch.office_dual_smart_plug_socket_2"})
        ]


def test_an_action_a_device_cannot_perform_is_a_client_error(settings, home_assistant):
    with smart_home_client(settings, home_assistant) as client:
        devices = {d["source_name"]: d for d in client.post("/v1/smart-home/sync").json()}
        plug = devices["Office Dual Smart Plug"]

        refused = client.post(
            f"/v1/smart-devices/{plug['id']}/commands",
            json={"action": "brightness", "parameters": {"percent": 50}},
        )
        assert refused.status_code == 400
        assert "cannot brightness" in refused.json()["detail"]
        assert home_assistant.calls == []

        missing = client.post(
            "/v1/smart-devices/does-not-exist/commands", json={"action": "turn_on"}
        )
        assert missing.status_code == 404


def test_an_unreachable_home_assistant_is_a_service_error_not_a_crash(settings, home_assistant):
    from jarvis_api.smarthome.model import SmartHomeUnavailable

    with smart_home_client(settings, home_assistant) as client:
        devices = {d["source_name"]: d for d in client.post("/v1/smart-home/sync").json()}
        lamp = devices["Office 1"]

        async def unreachable(*args, **kwargs):
            raise SmartHomeUnavailable("Home Assistant is unreachable")

        home_assistant.call_service = unreachable
        home_assistant.fail_states = SmartHomeUnavailable("Home Assistant is unreachable")

        failed = client.post(f"/v1/smart-devices/{lamp['id']}/commands", json={"action": "turn_on"})
        assert failed.status_code == 503
        assert "unreachable" in failed.json()["detail"]

        # A listing still renders so the phone can show the house it knows about.
        listed = client.get("/v1/smart-devices")
        assert listed.status_code == 200
        offline = [d for d in listed.json() if d["id"] == lamp["id"]][0]
        assert offline["name"] == "Office 1"
        assert offline["available"] is False
        assert offline["power"] is None


def test_rooms_expose_light_power_and_the_display_to_route_media_to(settings, home_assistant):
    with smart_home_client(settings, home_assistant) as client:
        devices = {d["source_name"]: d for d in client.post("/v1/smart-home/sync").json()}
        for source_name in ("Office 1", "Demo TV"):
            assert (
                client.patch(
                    f"/v1/smart-devices/{devices[source_name]['id']}",
                    json={"room": "Office"},
                ).status_code
                == 200
            )

        rooms = {room["name"]: room for room in client.get("/v1/rooms").json()}
        assert rooms["Office"]["device_count"] == 2

        lights = client.get("/v1/rooms/Office/lights").json()
        assert (lights["count"], lights["is_on"]) == (1, True)

        display = client.get("/v1/rooms/office/display").json()
        assert display["id"] == devices["Demo TV"]["id"]
        assert client.get("/v1/rooms/Cellar/display").json() is None


def database_rows(settings, sql):
    with sqlite3.connect(str(settings.database_path)) as database:
        return database.execute(sql).fetchall()
