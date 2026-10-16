from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis_voice.config import Settings
from jarvis_voice.spotify import SpotifyClient
from jarvis_voice.ui import LocalUiServer, UiEventHub


@pytest.fixture
async def spotify_ui(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    (tmp_path / "apps/device-ui/dist/assets").mkdir(parents=True)
    settings = Settings.from_env()
    spotify = object.__new__(SpotifyClient)
    spotify.settings = settings
    calls = []

    async def api(method, path, *, params=None, body=None):
        calls.append((method, path, params, body))
        return httpx.Response(204)

    spotify._api = api
    server = LocalUiServer(settings, None, spotify, SimpleNamespace(), UiEventHub())
    async with TestClient(TestServer(server._app)) as client:
        yield client, calls


@pytest.mark.parametrize(
    "body",
    [
        {"spotify_uri": "spotify:track:"},
        {"track_uris": "spotify:track:1"},
        {"track_uris": [17]},
        {"spotify_uri": "spotify:track:1", "device_id": 42},
    ],
)
async def test_play_rejects_invalid_payload_before_mutation(spotify_ui, body):
    client, calls = spotify_ui
    response = await client.post("/api/spotify/player/play", json=body)
    assert response.status == 400
    assert "detail" in await response.json()
    assert calls == []


async def test_play_passes_exact_sdk_id(spotify_ui):
    client, calls = spotify_ui
    response = await client.post(
        "/api/spotify/player/play",
        json={"spotify_uri": "spotify:playlist:abc", "device_id": "sdk-device"},
    )
    assert response.status == 200
    assert calls == [
        (
            "PUT",
            "/me/player/play",
            {"device_id": "sdk-device"},
            {"context_uri": "spotify:playlist:abc"},
        )
    ]


@pytest.mark.parametrize(
    "body",
    [
        {"shuffle": True},
        {"device_id": "sdk-device", "shuffle": "false"},
        {"device_id": "sdk-device", "repeat": ["track"]},
        {"device_id": "sdk-device", "shuffle": True, "repeat": "invalid"},
        {"device_id": "sdk-device"},
    ],
)
async def test_options_validate_entire_request_before_mutation(spotify_ui, body):
    client, calls = spotify_ui
    response = await client.post("/api/spotify/player/options", json=body)
    assert response.status == 400
    assert calls == []


async def test_shuffle_and_repeat_use_explicit_device(spotify_ui):
    client, calls = spotify_ui
    response = await client.post(
        "/api/spotify/player/options",
        json={"device_id": "sdk-device", "shuffle": True, "repeat": "context"},
    )
    assert response.status == 200
    assert calls == [
        ("PUT", "/me/player/shuffle", {"state": "true", "device_id": "sdk-device"}, None),
        ("PUT", "/me/player/repeat", {"state": "context", "device_id": "sdk-device"}, None),
    ]


async def test_queue_requires_device_and_does_not_read_other_playback(spotify_ui):
    client, calls = spotify_ui
    missing = await client.get("/api/spotify/player/queue")
    assert missing.status == 400
    assert calls == []
    inactive = await client.get("/api/spotify/player/queue?device_id=sdk-device")
    assert inactive.status == 200
    assert await inactive.json() == {"items": [], "currently_playing": None, "active": False}
    assert calls == [("GET", "/me/player", None, None)]


async def test_queue_add_validates_track_and_targets_device(spotify_ui):
    client, calls = spotify_ui
    invalid = await client.post(
        "/api/spotify/player/queue", json={"uri": "spotify:album:1", "device_id": "sdk-device"}
    )
    assert invalid.status == 400
    assert calls == []
    queued = await client.post(
        "/api/spotify/player/queue", json={"uri": "spotify:track:1", "device_id": "sdk-device"}
    )
    assert queued.status == 200
    assert calls == [
        ("POST", "/me/player/queue", {"uri": "spotify:track:1", "device_id": "sdk-device"}, None)
    ]
