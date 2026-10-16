from __future__ import annotations

import pytest

from jarvis_voice.spotify import SpotifyClient, _search_rows


class _Settings:
    spotify_player_name = "Kitchen"


def _client(devices):
    client = object.__new__(SpotifyClient)
    client.settings = _Settings()
    client.calls = []

    async def _api(method, path, *, params=None, body=None):
        client.calls.append((method, path))
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
