from __future__ import annotations

from typing import Any

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis_voice.config import Settings
from jarvis_voice.ui import LocalUiServer, UiEventHub, _component_app, _has_media_player


def test_a_device_with_a_media_player_component_counts_as_a_screen():
    roku = {
        "components": [
            {"domain": "media_player", "app": "Work MBP"},
            {"domain": "remote"},
        ]
    }
    assert _has_media_player(roku) is True
    assert _component_app(roku) == "Work MBP"

    lamp = {"components": [{"domain": "light"}]}
    assert _has_media_player(lamp) is False
    assert _component_app(lamp) == ""
    # A screen that reports no source must not invent one.
    assert _component_app({"components": [{"domain": "media_player"}]}) == ""
    assert _has_media_player(None) is False


class FakeApi:
    def __init__(self):
        self.created = []

    async def request(self, method, path, **kwargs):
        request = httpx.Request(method, f"http://jarvis.test{path}")
        if path == "/v1/speech/transcribe":
            assert kwargs["content"] == b"pcm"
            assert kwargs["params"] == {"sample_rate": 16000}
            return httpx.Response(200, json={"text": "Add a health check"}, request=request)
        return httpx.Response(200, json=[], request=request)

    async def json(self, method, path, *, params=None, body=None):
        if method == "POST" and path == "/v1/code-tasks":
            self.created.append(body)
            return {
                "id": "task-1",
                "prompt": body["prompt"],
                "status": "pending",
            }
        return []


class FakeVoice:
    ui_state = {
        "active": False,
        "phase": "idle",
        "connected": True,
        "interactions_muted": False,
    }

    def __init__(self):
        self.started = False
        self.start_count = 0
        self.muted_calls: list[bool] = []

    async def toggle_session(self):
        return None

    async def set_interactions_muted(self, muted: bool):
        self.muted_calls.append(muted)
        self.ui_state = {**self.ui_state, "interactions_muted": muted}

    async def start_coding_prompt_recording(self):
        self.started = True
        self.start_count += 1

    async def stop_coding_prompt_recording(self):
        assert self.started
        return b"pcm", 16000


class FakeSpotify:
    def config(self):
        return {}


async def _ui_client(monkeypatch, tmp_path, api, voice):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_CODING_TASKS_ENABLED", "true")
    (tmp_path / "apps/device-ui/dist/assets").mkdir(parents=True)
    settings = Settings.from_env()
    server = LocalUiServer(settings, api, FakeSpotify(), voice, UiEventHub())
    client = TestClient(TestServer(server._app))
    await client.start_server()
    return client


@pytest.mark.asyncio
async def test_config_exposes_music_tab_enabled_default_false(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        config = await (await client.get("/api/config")).json()
        assert config["music_tab_enabled"] is False
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_config_exposes_music_tab_enabled_when_set(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_MUSIC_TAB_ENABLED", "true")
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        config = await (await client.get("/api/config")).json()
        assert config["music_tab_enabled"] is True
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_recording_stop_returns_transcript_without_creating_task(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        config = await (await client.get("/api/config")).json()
        assert config["coding_tasks_enabled"] is True
        started = await client.post("/api/code-tasks/recording/start")
        assert started.status == 200
        stopped = await client.post("/api/code-tasks/recording/stop", json={})
        assert stopped.status == 200
        payload = await stopped.json()
        assert payload == {"transcript": "Add a health check"}
        assert api.created == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_confirmed_transcript_creates_task(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        created = await client.post(
            "/api/code-tasks",
            json={"prompt": "  Add a health check  ", "model": "gpt-5.6-terra"},
        )
        assert created.status == 202
        task = await created.json()
        assert task["prompt"] == "Add a health check"
        assert api.created == [{"prompt": "Add a health check", "model": "gpt-5.6-terra"}]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_blank_confirmed_prompt_is_rejected(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        rejected = await client.post("/api/code-tasks", json={"prompt": "   "})
        assert rejected.status == 422
        assert api.created == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_re_recording_transcribes_again_without_creating_a_task(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        await client.post("/api/code-tasks/recording/start")
        await client.post("/api/code-tasks/recording/stop", json={})
        again = await client.post("/api/code-tasks/recording/start")
        assert again.status == 200
        stopped = await client.post("/api/code-tasks/recording/stop", json={})
        assert (await stopped.json())["transcript"] == "Add a health check"
        assert voice.start_count == 2
        assert api.created == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_events_websocket_publishes_disconnected_voice_state(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_CODING_TASKS_ENABLED", "true")
    (tmp_path / "apps/device-ui/dist/assets").mkdir(parents=True)
    settings = Settings.from_env()
    hub = UiEventHub()
    await hub.set_voice_state(active=False, phase="idle", connected=False)
    ui = LocalUiServer(settings, FakeApi(), FakeSpotify(), FakeVoice(), hub)
    client = TestClient(TestServer(ui._app))
    await client.start_server()
    try:
        async with client.ws_connect("/api/events") as ws:
            first = await ws.receive_json()
            assert first["type"] == "voice.state"
            assert first["data"]["connected"] is False
            assert first["data"]["phase"] == "idle"
            await hub.set_voice_state(connected=True)
            second = await ws.receive_json()
            assert second["type"] == "voice.state"
            assert second["data"]["connected"] is True
    finally:
        await client.close()


class BanterApi(FakeApi):
    def __init__(self, payload, status=200):
        super().__init__()
        self.payload = payload
        self.status = status
        self.requests = []

    async def request(self, method, path, **kwargs):
        self.requests.append((method, path, kwargs))
        response = httpx.Response(
            self.status,
            json=self.payload,
            request=httpx.Request(method, f"http://jarvis.test{path}"),
        )
        response.raise_for_status()
        return response


@pytest.mark.asyncio
@pytest.mark.parametrize("paired", [False, True])
async def test_banter_status_uses_configured_device_and_preserves_pairing(
    monkeypatch, tmp_path, paired
):
    monkeypatch.setenv("JARVIS_DEVICE_ID", "voice-three")
    payload = {
        "paired": paired,
        "available": paired,
        "busy": False,
        "status": "ready" if paired else "unpaired",
        "source_device_id": "sherman" if paired else None,
    }
    api = BanterApi(payload)
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.get("/api/banter?response_device_id=another-device")
        assert response.status == 200
        assert await response.json() == payload
        assert api.requests == [("GET", "/v1/banter/devices/voice-three", {"params": None})]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_banter_trigger_targets_only_this_device(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_DEVICE_ID", "voice-three")
    payload = {
        "paired": True,
        "available": True,
        "busy": True,
        "status": "queued",
        "source_device_id": "sherman",
    }
    api = BanterApi(payload, status=202)
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.post(
            "/api/banter/trigger", json={"response_device_id": "another-device"}
        )
        assert response.status == 202
        assert await response.json() == payload
        assert api.requests == [
            ("POST", "/v1/banter/devices/voice-three/trigger", {"params": None})
        ]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_banter_trigger_preserves_upstream_rejection(monkeypatch, tmp_path):
    api = BanterApi({"detail": "Sherman is offline"}, status=409)
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.post("/api/banter/trigger")
        assert response.status == 409
        assert await response.json() == {"detail": "Sherman is offline"}
    finally:
        await client.close()


class SmartHomeApi(FakeApi):
    """Answers the smart-home calls the kiosk makes, and records them."""

    def __init__(self, *, lights=None, devices=None, display=None, fail=None):
        super().__init__()
        self.lights = lights if lights is not None else {"count": 2, "is_on": True, "unknown": 0}
        self.devices = devices if devices is not None else []
        self.display = display
        self.fail = fail
        self.calls: list[tuple[str, str, Any]] = []

    async def json(self, method, path, *, params=None, body=None):
        self.calls.append((method, path, body))
        if self.fail is not None:
            raise self.fail
        if path.endswith("/lights"):
            return dict(self.lights)
        if path.endswith("/display"):
            return self.display
        if path == "/v1/smart-devices":
            return list(self.devices)
        if path == "/v1/smart-devices/control":
            return {"succeeded": self.lights["count"], "failed": 0}
        return {"accepted": True}


def _status_error(status: int, payload: dict[str, Any]) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "http://jarvis.test/v1/smart-devices")
    response = httpx.Response(status, json=payload, request=request)
    return httpx.HTTPStatusError("upstream", request=request, response=response)


@pytest.mark.asyncio
async def test_room_lights_state_comes_from_one_api_call(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    api = SmartHomeApi(lights={"count": 3, "is_on": True, "unknown": 1})
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        state = await (await client.get("/api/lights/room-state")).json()
        assert state == {"room_bound": True, "is_on": True, "count": 3, "unknown": 1}
        # One aggregate call, not one per light.
        assert api.calls == [("GET", "/v1/rooms/Office/lights", None)]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_device_with_no_room_reports_that_rather_than_failing(monkeypatch, tmp_path):
    api = SmartHomeApi()
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        state = await (await client.get("/api/lights/room-state")).json()
        assert state == {"room_bound": False, "is_on": None, "count": 0, "unknown": 0}
        assert api.calls == []
        rejected = await client.post("/api/lights/room-toggle")
        assert rejected.status == 400
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_the_toggle_reads_the_room_before_deciding(monkeypatch, tmp_path):
    """A cached value goes stale as soon as the phone or a voice turn changes it."""
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    api = SmartHomeApi(lights={"count": 2, "is_on": True, "unknown": 0})
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        first = await (await client.post("/api/lights/room-toggle")).json()
        assert first["action"] == "turn_off"

        # Someone else turned them off in between. The next press must turn them on.
        api.lights = {"count": 2, "is_on": False, "unknown": 0}
        second = await (await client.post("/api/lights/room-toggle")).json()
        assert second["action"] == "turn_on"

        assert [call[1] for call in api.calls] == [
            "/v1/rooms/Office/lights",
            "/v1/smart-devices/control",
            "/v1/rooms/Office/lights",
            "/v1/smart-devices/control",
        ]
        assert api.calls[1][2] == {
            "scope": "room",
            "selector": "Office",
            "action": "turn_off",
            "parameters": {},
        }
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_unknown_room_power_turns_the_lights_on(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    api = SmartHomeApi(lights={"count": 2, "is_on": None, "unknown": 2})
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        result = await (await client.post("/api/lights/room-toggle")).json()
        assert result["action"] == "turn_on"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_room_with_no_lights_is_a_not_found(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_ROOM", "Cellar")
    api = SmartHomeApi(lights={"count": 0, "is_on": None, "unknown": 0})
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        assert (await client.post("/api/lights/room-toggle")).status == 404
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_an_upstream_failure_reaches_the_kiosk_as_json(monkeypatch, tmp_path):
    """The kiosk parses JSON, so a bare text body would surface as a parse error."""
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    api = SmartHomeApi(fail=_status_error(503, {"detail": "Home Assistant is unreachable"}))
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        for request in (
            client.get("/api/lights/room-state"),
            client.post("/api/lights/room-toggle"),
            client.get("/api/screens"),
        ):
            response = await request
            assert response.status == 503
            assert await response.json() == {"detail": "Home Assistant is unreachable"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_transport_failure_is_reported_as_unavailable(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    api = SmartHomeApi(fail=httpx.ConnectError("connection refused"))
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.get("/api/lights/room-state")
        assert response.status == 503
        assert "connection refused" in (await response.json())["detail"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_screens_are_listed_with_the_rooms_default_marked(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    devices = [
        {
            "id": "lamp",
            "name": "Office 1",
            "components": [{"domain": "light"}],
        },
        {
            "id": "roku",
            "name": "Demo TV",
            "room": "Office",
            "model": "55S41R",
            "available": True,
            "power": True,
            "capabilities": ["power", "volume", "remote_keys"],
            "supported_keys": ["home", "select"],
            "components": [
                {"domain": "remote"},
                {
                    "domain": "media_player",
                    "app": "Work MBP",
                    "muted": None,
                    "apps": ["Netflix", "Work MBP", "HDMI\u00a04\u00a0(eARC)"],
                    "app_id": "tvinput.hdmi1",
                    "media_title": "Local news",
                    "media_channel": "5.1",
                    "playback_state": "playing",
                    "volume_percent": None,
                },
            ],
        },
        {
            "id": "lounge-tv",
            "name": "Lounge TV",
            "room": "Lounge",
            "available": False,
            "power": None,
            "capabilities": ["power"],
            "components": [{"domain": "media_player"}],
        },
    ]
    api = SmartHomeApi(devices=devices, display={"id": "roku"})
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        rows = await (await client.get("/api/screens")).json()
        # The lamp is not a screen.
        assert [row["id"] for row in rows] == ["roku", "lounge-tv"]
        assert rows[0]["is_room_default"] is True
        assert rows[0]["app"] == "Work MBP"
        assert rows[0]["muted"] is None
        assert rows[0]["volume_percent"] is None
        assert rows[0]["apps"] == ["Netflix", "Work MBP", "HDMI\u00a04\u00a0(eARC)"]
        assert rows[0]["app_id"] == "tvinput.hdmi1"
        assert rows[0]["media_title"] == "Local news"
        assert rows[0]["media_channel"] == "5.1"
        assert rows[0]["playback_state"] == "playing"
        assert rows[0]["supported_keys"] == ["home", "select"]
        # An unreachable screen is still listed, and says so.
        assert rows[1]["is_room_default"] is False
        assert (rows[1]["available"], rows[1]["power"]) == (False, None)
        assert rows[1]["apps"] == []
        assert rows[1]["volume_percent"] is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_screen_command_is_forwarded_unchanged(monkeypatch, tmp_path):
    api = SmartHomeApi()
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        sent = await client.post(
            "/api/screens/roku/commands", json={"action": "key", "parameters": {"key": "home"}}
        )
        assert sent.status == 200
        assert api.calls == [
            (
                "POST",
                "/v1/smart-devices/roku/commands",
                {"action": "key", "parameters": {"key": "home"}},
            )
        ]

        blank = await client.post("/api/screens/roku/commands", json={"action": "  "})
        assert blank.status == 400
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_a_key_the_api_rejects_is_passed_back_verbatim(monkeypatch, tmp_path):
    api = SmartHomeApi(fail=_status_error(400, {"detail": "unsupported remote key 'eject'"}))
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.post(
            "/api/screens/roku/commands", json={"action": "key", "parameters": {"key": "eject"}}
        )
        assert response.status == 400
        assert await response.json() == {"detail": "unsupported remote key 'eject'"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_interactions_mute_requires_boolean_and_updates_state(monkeypatch, tmp_path):
    api = FakeApi()
    voice = FakeVoice()
    client = await _ui_client(monkeypatch, tmp_path, api, voice)
    try:
        bad = await client.post("/api/voice/interactions-mute", json={})
        assert bad.status == 400
        muted = await client.post("/api/voice/interactions-mute", json={"muted": True})
        assert muted.status == 200
        payload = await muted.json()
        assert payload["ok"] is True
        assert payload["interactions_muted"] is True
        assert voice.muted_calls == [True]
        unmuted = await client.post("/api/voice/interactions-mute", json={"muted": False})
        assert (await unmuted.json())["interactions_muted"] is False
        assert voice.muted_calls == [True, False]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fields", [{}, {"model": None}, {"model": ""}])
async def test_code_task_requires_model_before_proxying(monkeypatch, tmp_path, fields):
    api = FakeApi()
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.post("/api/code-tasks", json={"prompt": "Ship it", **fields})
        assert response.status == 422
        assert api.created == []
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_code_task_feed_proxies_pages_output_follow_up_and_events(monkeypatch, tmp_path):
    calls = []
    streams = []

    class FeedApi(FakeApi):
        async def request(self, method, path, **kwargs):
            calls.append((method, path, kwargs))
            return httpx.Response(200, json={"items": [], "next_cursor": "older"})

        async def json(self, method, path, **kwargs):
            calls.append((method, path, kwargs))
            return {"id": "follow-up", "parent_task_id": "one"}

        async def open_event_stream(self, path, **kwargs):
            calls.append(("GET", path, kwargs))
            response = httpx.Response(200, content=b"event: output\nid: 4\ndata: {}\n\n")
            streams.append(response)
            return response

    client = await _ui_client(monkeypatch, tmp_path, FeedApi(), FakeVoice())
    try:
        response = await client.get("/api/code-tasks?limit=2&view=history&cursor=older")
        assert (await response.json())["next_cursor"] == "older"
        assert calls[-1] == (
            "GET",
            "/v1/code-tasks",
            {"params": {"limit": "2", "view": "history", "cursor": "older"}},
        )
        await client.get("/api/code-tasks/one/output?after=4&limit=10")
        assert calls[-1] == (
            "GET",
            "/v1/code-tasks/one/output",
            {"params": {"after": "4", "limit": "10"}},
        )
        response = await client.post("/api/code-tasks/one/follow-up", json={"prompt": "Continue"})
        assert response.status == 202
        assert (await response.json())["parent_task_id"] == "one"
        assert calls[-1][2] == {"body": {"prompt": "Continue"}}
        response = await client.get(
            "/api/code-tasks/one/events?after=3", headers={"Last-Event-ID": "4"}
        )
        assert response.headers["Content-Type"] == "text/event-stream"
        assert await response.read() == b"event: output\nid: 4\ndata: {}\n\n"
        assert calls[-1][2] == {"params": {"after": "3"}, "last_event_id": "4"}
        assert streams[-1].is_closed
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_light_menu_filters_inventory_and_controls_exact_targets(monkeypatch, tmp_path):
    api = SmartHomeApi(
        devices=[
            {
                "id": "lamp",
                "name": "Desk",
                "room": "Office",
                "is_light": True,
                "available": True,
                "power": False,
            },
            {"id": "tv", "name": "TV", "room": "Office", "is_light": False},
        ]
    )
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        response = await client.get("/api/lights")
        assert response.status == 200
        assert [row["id"] for row in await response.json()] == ["lamp"]
        for scope, selector in [("device", "lamp"), ("room", "Office")]:
            response = await client.post(
                "/api/lights/control",
                json={"scope": scope, "selector": selector, "action": "turn_on"},
            )
            assert response.status == 200
            assert api.calls[-1] == (
                "POST",
                "/v1/smart-devices/control",
                {"scope": scope, "selector": selector, "action": "turn_on", "parameters": {}},
            )
        for scope, selector, action in [
            ("all", "", "turn_on"),
            ("device", "tv", "turn_on"),
            ("room", "Off", "turn_off"),
            ("device", "lamp", "toggle"),
        ]:
            response = await client.post(
                "/api/lights/control", json={"scope": scope, "selector": selector, "action": action}
            )
            assert response.status in (400, 404)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_light_menu_upstream_failure_is_bounded(monkeypatch, tmp_path):
    api = SmartHomeApi(fail=_status_error(503, {"detail": "Lights unavailable"}))
    client = await _ui_client(monkeypatch, tmp_path, api, FakeVoice())
    try:
        assert (await client.get("/api/lights")).status == 503
        assert (
            await client.post(
                "/api/lights/control",
                json={"scope": "room", "selector": "Office", "action": "turn_off"},
            )
        ).status == 503
    finally:
        await client.close()
