from __future__ import annotations

from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_api import authenticated_client

from jarvis_api.voice import VoiceConnectionHub, VoiceSession


def test_device_create_and_update_store_write_only_callback_with_settings(settings):
    with authenticated_client(settings) as client:
        created = client.post(
            "/v1/devices",
            json={
                "name": "Camera",
                "kind": "camera",
                "base_url": "https://camera.local/gateway",
                "callback_token": "first-callback-secret",
                "metadata": {"describe_scene_prompt": "Look at the entry"},
            },
        )
        assert created.status_code == 201
        device = created.json()
        assert device["callback_configured"] is True
        assert "callback_token" not in device
        updated = client.patch(
            "/v1/devices/" + device["id"],
            json={"name": "Entry", "callback_token": "second-callback-secret"},
        )
        assert updated.status_code == 200
        assert updated.json()["base_url"] == "https://camera.local/gateway"
        assert updated.json()["metadata"]["describe_scene_prompt"] == "Look at the entry"
        assert updated.json()["callback_configured"] is True
        owner = client.get("/v1/users/me").json()["id"]
        secret = client.portal.call(
            client.app.state.vault.get, "device_callback", device["id"], owner
        )
        assert secret["token"] == "second-callback-secret"
        listed = client.get("/v1/devices").json()[0]
        assert "callback_token" not in listed
        assert listed["callback_configured"] is True
        assert (
            client.patch("/v1/devices/" + device["id"], json={"room": "Hall"}).json()[
                "callback_configured"
            ]
            is True
        )


def test_secret_storage_failure_rolls_back_device_create_and_update(settings):
    with authenticated_client(settings) as client:
        owner = client.get("/v1/users/me").json()["id"]
        store = client.app.state.store
        existing = client.post("/v1/devices", json={"name": "Original", "kind": "camera"}).json()
        client.portal.call(
            store.db.execute,
            "CREATE TRIGGER reject_callback BEFORE INSERT ON secrets "
            "WHEN NEW.namespace = 'device_callback' "
            "BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        )
        client.portal.call(store.db.commit)
        with pytest.raises(Exception, match="test failure"):
            client.post(
                "/v1/devices",
                json={
                    "name": "Must not survive",
                    "kind": "camera",
                    "callback_token": "valid-callback-token",
                },
            )
        with pytest.raises(Exception, match="test failure"):
            client.patch(
                "/v1/devices/" + existing["id"],
                json={"name": "Must roll back", "callback_token": "valid-callback-token"},
            )
        devices = client.portal.call(store.list_entities, "device", owner)
        assert [row["name"] for row in devices] == ["Original"]


def test_camera_registration_preserves_settings_but_updates_reports(settings):
    with authenticated_client(settings) as client:
        registration = {
            "name": "Runtime camera",
            "room": "Runtime room",
            "base_url": "http://camera:8089",
            "callback_token": "camera-callback-token",
            "metadata": {"connected": True, "resolution": [640, 480]},
        }
        assert (
            client.put("/v1/devices/camera-one/registration", json=registration).status_code == 200
        )
        edited = client.patch(
            "/v1/devices/camera-one",
            json={
                "name": "Front entry",
                "room": "",
                "metadata": {
                    "describe_scene_prompt": "Check deliveries",
                    "is_main_describe_camera": True,
                },
            },
        )
        assert edited.status_code == 200
        registration["metadata"] = {"connected": False, "resolution": [1280, 720]}
        assert (
            client.put("/v1/devices/camera-one/registration", json=registration).status_code == 200
        )
        row = client.get("/v1/devices").json()[0]
        assert row["name"] == "Front entry"
        assert row["room"] == ""
        assert row["metadata"]["describe_scene_prompt"] == "Check deliveries"
        assert row["metadata"]["is_main_describe_camera"] is True
        assert row["metadata"]["connected"] is False
        assert row["metadata"]["resolution"] == [1280, 720]


def test_selecting_default_camera_clears_only_other_owner_camera_defaults(settings):
    with authenticated_client(settings) as client:
        owner = client.get("/v1/users/me").json()["id"]
        store = client.app.state.store
        other = client.portal.call(
            partial(
                store.create_entity,
                "device",
                "other-owner",
                {"name": "Other", "kind": "camera", "metadata": {"is_main_describe_camera": True}},
            )
        )
        first = client.post(
            "/v1/devices",
            json={"name": "First", "kind": "camera", "metadata": {"is_main_describe_camera": True}},
        ).json()
        second = client.post("/v1/devices", json={"name": "Second", "kind": "camera"}).json()
        assert (
            client.patch(
                "/v1/devices/" + second["id"], json={"metadata": {"is_main_describe_camera": True}}
            ).status_code
            == 200
        )
        rows = client.portal.call(store.list_entities, "device", owner)
        assert [row["id"] for row in rows if row["metadata"].get("is_main_describe_camera")] == [
            second["id"]
        ]
        assert (
            client.portal.call(store.get_entity, "device", other["id"], "other-owner")["metadata"][
                "is_main_describe_camera"
            ]
            is True
        )
        assert len(rows) == 2 and any(row["id"] == first["id"] for row in rows)


def test_voice_reconnect_preserves_explicit_name_room_and_owner(settings):
    with authenticated_client(settings) as client:
        owner = client.get("/v1/users/me").json()["id"]
        session = VoiceSession(
            AsyncMock(),
            {"id": owner},
            settings,
            None,
            SimpleNamespace(store=client.app.state.store),
            VoiceConnectionHub(),
        )
        session.device_id = "office-voice"
        client.portal.call(session._set_device_connected, True, "Runtime name", "Office")
        assert (
            client.patch(
                "/v1/devices/office-voice",
                json={
                    "name": "Desk assistant",
                    "room": "",
                    "metadata": {
                        "acting_user_id": "not-the-owner",
                        "doorbell_alerts_enabled": True,
                    },
                },
            ).status_code
            == 200
        )
        client.portal.call(session._set_device_connected, True, "Runtime name", "Office")
        row = client.get("/v1/devices").json()[0]
        assert row["name"] == "Desk assistant"
        assert row["room"] == ""
        assert row["user_id"] == owner
        assert row["metadata"]["connected"] is True
        assert row["metadata"]["doorbell_alerts_enabled"] is True
        assert row["base_url"] is None


def test_explicit_null_callback_url_clears_endpoint_without_clearing_secret(settings):
    with authenticated_client(settings) as client:
        device = client.post(
            "/v1/devices",
            json={
                "name": "Voice",
                "kind": "voice",
                "base_url": "https://voice.local/api",
                "callback_token": "voice-callback-token",
            },
        ).json()
        updated = client.patch("/v1/devices/" + device["id"], json={"base_url": None})
        assert updated.status_code == 200
        assert updated.json()["base_url"] is None
        assert updated.json()["callback_configured"] is True


def test_explicit_callback_settings_survive_camera_registration(settings):
    with authenticated_client(settings) as client:
        report = {
            "name": "Camera",
            "base_url": "http://camera:8089",
            "callback_token": "runtime-callback-secret",
        }
        assert client.put("/v1/devices/entry-camera/registration", json=report).status_code == 200
        report["base_url"] = "http://new-camera:8089"
        assert client.put("/v1/devices/entry-camera/registration", json=report).status_code == 200
        assert client.get("/v1/devices").json()[0]["base_url"] == "http://new-camera:8089"
        assert (
            client.patch(
                "/v1/devices/entry-camera",
                json={
                    "base_url": "https://camera.example/gateway/",
                    "callback_token": "owner-callback-secret",
                },
            ).status_code
            == 200
        )
        assert client.put("/v1/devices/entry-camera/registration", json=report).status_code == 200
        row = client.get("/v1/devices").json()[0]
        assert row["base_url"] == "https://camera.example/gateway/"
        secret = client.portal.call(
            client.app.state.vault.get, "device_callback", row["id"], row["user_id"]
        )
        assert secret["token"] == "owner-callback-secret"


def test_heartbeat_merges_reports_after_a_concurrent_settings_save(settings, monkeypatch):
    with authenticated_client(settings) as client:
        device = client.post("/v1/devices", json={"name": "Camera", "kind": "camera"}).json()
        store = client.app.state.store
        original_get = store.get_entity
        edited = False

        async def get_with_concurrent_edit(kind, entity_id, owner_id=None):
            nonlocal edited
            value = await original_get(kind, entity_id, owner_id)
            if kind == "device" and entity_id == device["id"] and not edited:
                edited = True
                await store.save_device(
                    device["user_id"],
                    {"metadata": {"describe_scene_prompt": "Keep this edit"}},
                    device_id=entity_id,
                )
            return value

        monkeypatch.setattr(store, "get_entity", get_with_concurrent_edit)
        response = client.post(
            "/v1/devices/" + device["id"] + "/heartbeat", json={"connected": True, "ready": True}
        )
        assert response.status_code == 200
        row = client.portal.call(original_get, "device", device["id"], device["user_id"])
        assert row["metadata"]["describe_scene_prompt"] == "Keep this edit"
        assert row["metadata"]["health"] == {"connected": True, "ready": True}
