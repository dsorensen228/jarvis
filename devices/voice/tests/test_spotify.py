from __future__ import annotations

import pytest

from jarvis_voice.spotify import SpotifyClient, _search_rows


class _Settings:
    spotify_player_name = "Kitchen"


def _client(devices):
    client = object.__new__(SpotifyClient)
    client.settings = _Settings()
    client.calls = []
    client.requests = []

    async def _api(method, path, *, params=None, body=None):
        client.calls.append((method, path))
        client.requests.append((method, path, params, body))
        if path == "/me/player/devices":

            class _Response:
                @staticmethod
                def json():
                    return {"devices": devices}

            return _Response()
        return None

    client._api = _api
    return client


@pytest.mark.asyncio
async def test_play_skips_transfer_when_target_device_already_active():
    client = _client([{"id": "d1", "name": "Kitchen", "is_active": True}])
    await client.play(spotify_uri="spotify:album:1")
    assert [path for _, path in client.calls] == ["/me/player/devices", "/me/player/play"]


@pytest.mark.asyncio
async def test_play_transfers_playback_when_target_device_inactive():
    client = _client([{"id": "d1", "name": "Kitchen", "is_active": False}])
    await client.play(spotify_uri="spotify:album:1")
    assert [path for _, path in client.calls] == [
        "/me/player/devices",
        "/me/player",
        "/me/player/play",
    ]


def test_search_rows_flatten_current_spotify_shape():
    payload = {
        "tracks": {
            "items": [
                {
                    "uri": "spotify:track:1",
                    "name": "Song",
                    "artists": [{"name": "Artist"}],
                    "album": {"images": [{"url": "small", "width": 64}]},
                }
            ]
        }
    }
    assert _search_rows(payload, 10) == [
        {
            "uri": "spotify:track:1",
            "name": "Song",
            "subtitle": "Artist",
            "image": "small",
            "kind": "track",
        }
    ]


@pytest.mark.asyncio
async def test_touchscreen_play_targets_exact_sdk_device_without_name_lookup():
    client = _client([{"id": "other", "name": "Kitchen", "is_active": True}])
    calls = []

    async def api(method, path, *, params=None, body=None):
        calls.append((method, path, params, body))

    client._api = api
    await client.play(spotify_uri="spotify:track:abc123", device_id="sdk-device")
    assert calls == [
        ("PUT", "/me/player/play", {"device_id": "sdk-device"}, {"uris": ["spotify:track:abc123"]})
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"spotify_uri": "https://open.spotify.com/track/1"},
        {"spotify_uri": "spotify:track:"},
        {"spotify_uri": "spotify:episode:1"},
        {"spotify_uri": "spotify:album:bad:id"},
        {"track_uris": ["spotify:track:1", "spotify:album:2"]},
        {"spotify_uri": "spotify:track:valid", "track_uris": ["not-a-track-uri"]},
        {"track_uris": [None]},
        {"track_uris": []},
    ],
)
async def test_invalid_play_does_not_transfer_or_contact_spotify(payload):
    client = _client([{"id": "d1", "name": "Kitchen", "is_active": False}])
    with pytest.raises(ValueError):
        await client.play(**payload)
    assert client.calls == []


@pytest.mark.asyncio
async def test_queue_does_not_show_another_devices_playback():
    import httpx

    client = _client([])

    async def api(method, path, *, params=None, body=None):
        client.calls.append((method, path))
        assert path == "/me/player"
        return httpx.Response(200, json={"device": {"id": "another-device"}})

    client._api = api
    assert await client.queue("sdk-device") == {
        "items": [],
        "currently_playing": None,
        "active": False,
    }
    assert client.calls == [("GET", "/me/player")]


@pytest.mark.asyncio
async def test_queue_normalizes_tracks_and_preserves_duplicates():
    import httpx

    client = _client([])
    track = {"uri": "spotify:track:1", "name": "Song", "artists": [{"name": "Artist"}]}

    async def api(method, path, *, params=None, body=None):
        if path == "/me/player":
            return httpx.Response(200, json={"device": {"id": "sdk-device"}})
        return httpx.Response(200, json={"currently_playing": track, "queue": [track, None, track]})

    client._api = api
    result = await client.queue("sdk-device")
    assert result["active"] is True
    assert result["currently_playing"]["subtitle"] == "Artist"
    assert [item["uri"] for item in result["items"]] == ["spotify:track:1", "spotify:track:1"]


@pytest.mark.asyncio
async def test_queue_and_options_always_send_explicit_device():
    client = _client([])
    calls = []

    async def api(method, path, *, params=None, body=None):
        calls.append((method, path, params))

    client._api = api
    await client.add_to_queue("spotify:track:1", "sdk-device")
    await client.set_shuffle(False, "sdk-device")
    await client.set_repeat("track", "sdk-device")
    assert calls == [
        ("POST", "/me/player/queue", {"uri": "spotify:track:1", "device_id": "sdk-device"}),
        ("PUT", "/me/player/shuffle", {"state": "false", "device_id": "sdk-device"}),
        ("PUT", "/me/player/repeat", {"state": "track", "device_id": "sdk-device"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,args",
    [
        ("add_to_queue", ("spotify:album:1", "sdk-device")),
        ("add_to_queue", ("spotify:track:1", "")),
        ("set_shuffle", ("false", "sdk-device")),
        ("set_shuffle", (True, "")),
        ("set_repeat", ("all", "sdk-device")),
        ("set_repeat", ("off", "")),
        ("queue", ("",)),
    ],
)
async def test_invalid_queue_and_options_never_contact_spotify(method, args):
    client = _client([])
    with pytest.raises(ValueError):
        await getattr(client, method)(*args)
    assert client.calls == []


@pytest.mark.asyncio
async def test_disconnect_waits_for_token_rotation_before_removing_credentials(tmp_path):
    import asyncio

    client = _client([])
    client._lock = asyncio.Lock()
    client.settings = type("Settings", (), {"spotify_refresh_token_file": tmp_path / "token"})()
    client._access_token = "old-access"
    client._expires_at = 100.0
    client.settings.spotify_refresh_token_file.write_text("old-refresh")
    await client._lock.acquire()
    disconnect = asyncio.create_task(client.disconnect())
    await asyncio.sleep(0)
    assert not disconnect.done()
    client.settings.spotify_refresh_token_file.write_text("rotated-refresh")
    client._lock.release()
    await disconnect
    assert not client.settings.spotify_refresh_token_file.exists()
    assert client._access_token == ""
    assert client._expires_at == 0.0


def test_queue_filters_episodes_instead_of_labeling_them_tracks():
    from jarvis_voice.spotify import _queue_tracks

    assert _queue_tracks(
        [
            {"uri": "spotify:episode:1", "name": "Podcast"},
            {"uri": "spotify:track:2", "name": "Music"},
            None,
        ],
        50,
    ) == [
        {"uri": "spotify:track:2", "name": "Music", "subtitle": "", "image": None, "kind": "track"}
    ]
    assert _queue_tracks(None, 50) == []


@pytest.mark.parametrize(
    "status,headers,body,expected",
    [
        (401, {}, {}, "fresh sign-in"),
        (403, {}, {"error": {"message": "Premium required"}}, "requires Spotify Premium"),
        (403, {}, {"error": {"message": "Restriction violated"}}, "Restriction violated"),
        (404, {}, {}, "Retry the connection"),
        (429, {"Retry-After": "12"}, {}, "Wait 12 seconds"),
        (429, {"Retry-After": "99999999"}, {}, "Wait a few minutes"),
        (429, {"Retry-After": "garbage"}, {}, "Wait a few minutes"),
        (503, {}, {}, "temporarily unavailable"),
    ],
)
async def test_api_errors_are_actionable_without_raw_provider_json(status, headers, body, expected):
    import httpx

    client = _client([])
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(status, headers=headers, json=body)

    async def token():
        return "access"

    async def invalidate():
        return None

    client._token = token
    client.invalidate = invalidate
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client._http:
        with pytest.raises(RuntimeError, match=expected) as error:
            await SpotifyClient._api(client, "POST", "/me/player/queue")
        assert "{" not in str(error.value)
    # Only an explicitly rejected access token gets the existing refresh retry;
    # rate limits and ambiguous service failures must never duplicate mutations.
    assert len(requests) == (2 if status == 401 else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "uri,expected_body",
    [
        ("spotify:track:valid", {"uris": ["spotify:track:valid"]}),
        ("spotify:album:valid", {"context_uri": "spotify:album:valid"}),
    ],
)
async def test_voice_default_empty_track_list_preserves_supplied_uri(uri, expected_body):
    client = _client([{"id": "voice-device", "name": "Kitchen", "is_active": True}])
    await client.play(spotify_uri=uri, track_uris=[])
    assert client.requests == [
        ("GET", "/me/player/devices", None, None),
        ("PUT", "/me/player/play", {"device_id": "voice-device"}, expected_body),
    ]
