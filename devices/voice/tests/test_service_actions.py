from __future__ import annotations

import pytest

from jarvis_voice.service import VoiceDeviceService


class FakeEvents:
    def __init__(self):
        self.actions = []

    async def client_action(self, action, arguments):
        self.actions.append((action, arguments))


class FakeSpotify:
    def __init__(self):
        self.calls = []

    async def search(self, query, types, limit):
        self.calls.append(("search", query, types, limit))
        return [
            {
                "uri": f"spotify:track:{index}",
                "name": "Here Comes the Sun",
                "subtitle": "The Beatles",
                "image": "https://i.scdn.co/image/abc123",
                "kind": "track",
            }
            for index in range(1, 7)
        ]

    async def play(self, *, spotify_uri, track_uris, device_name):
        self.calls.append(("play", spotify_uri, track_uris, device_name))

    async def pause(self, device_name):
        self.calls.append(("pause", device_name))

    async def resume(self, device_name):
        self.calls.append(("resume", device_name))

    async def skip_next(self, device_name):
        self.calls.append(("next", device_name))

    async def skip_previous(self, device_name):
        self.calls.append(("previous", device_name))


class FakeBrowser:
    async def close_external_tabs(self):
        return 1


class Resettable:
    def reset(self):
        return None


class FakePlayer:
    def __init__(self):
        self.is_playing = False
        self.chunks = []
        self.sample_rate = None

    def clear(self):
        self.is_playing = False

    def start_response(self, sample_rate):
        self.sample_rate = sample_rate
        self.is_playing = True

    def enqueue(self, pcm):
        self.chunks.append(pcm)

    def finish_response(self):
        self.is_playing = False


@pytest.fixture
def service():
    instance = object.__new__(VoiceDeviceService)
    instance.events = FakeEvents()
    instance.spotify = FakeSpotify()
    instance.browser = FakeBrowser()
    return instance


@pytest.mark.asyncio
async def test_navigation_action_reaches_touchscreen_event_hub(service):
    result = await service._execute_device_action("navigate_device_ui", {"destination": "spotify"})
    assert result == {"ok": True, "destination": "spotify"}
    assert service.events.actions == [("navigate_device_ui", {"destination": "spotify"})]


@pytest.mark.asyncio
async def test_spotify_search_and_play_use_device_credentials(service):
    result = await service._execute_device_action(
        "spotify_search", {"query": "Beatles", "types": "track", "limit": 3}
    )
    assert result[0]["uri"] == "spotify:track:1"
    # The search result feeds the language model: rows are capped at the
    # requested limit and cover-art URLs are stripped to keep the next model
    # turn's prompt small.
    assert len(result) == 3
    assert all("image" not in row for row in result)
    await service._execute_device_action(
        "spotify_start_playback", {"spotify_uri": "spotify:track:1"}
    )
    assert service.spotify.calls == [
        ("search", "Beatles", "track", 3),
        ("play", "spotify:track:1", None, ""),
    ]


@pytest.mark.asyncio
async def test_play_best_match_searches_and_starts_playback_in_one_action(service):
    result = await service._execute_device_action(
        "spotify_play_best_match", {"query": "music by the Beatles", "types": "artist,track"}
    )
    assert result["ok"] is True
    assert result["status"] == "playing"
    assert result["played"]["uri"] == "spotify:track:1"
    assert "image" not in result["played"]
    assert service.spotify.calls == [
        ("search", "music by the Beatles", "artist,track", 5),
        ("play", "spotify:track:1", None, ""),
    ]


@pytest.mark.asyncio
async def test_play_best_match_prefers_the_first_listed_result_kind(service):
    async def search(query, types, limit):
        return [
            {"uri": "spotify:track:9", "name": "Song", "subtitle": "", "kind": "track"},
            {"uri": "spotify:artist:1", "name": "Band", "subtitle": "", "kind": "artist"},
        ]

    service.spotify.search = search
    result = await service._execute_device_action(
        "spotify_play_best_match", {"query": "the band", "types": "artist,track"}
    )
    assert result["played"]["uri"] == "spotify:artist:1"
    assert service.spotify.calls == [("play", "spotify:artist:1", None, "")]


@pytest.mark.asyncio
async def test_browser_actions_reach_touchscreen_event_hub(service):
    result = await service._execute_device_action("show_wikipedia", {"query": "Ada Lovelace"})
    assert result["ok"] is True
    assert service.events.actions[0][0] == "browser_open"
    assert "Ada+Lovelace" in service.events.actions[0][1]["url"]
    closed = await service._execute_device_action("close_browser", {})
    assert closed == {"ok": True, "closed_tabs": 1}
    assert service.events.actions[-1] == ("browser_close", {})


@pytest.fixture
def announcement_service(service):
    service._session_active = False
    service._activating = False
    service._follow_up_deadline = 10.0
    service._announcement_active = False
    service._last_conversation_activity = 10.0
    service.segmenter = Resettable()
    service.barge = Resettable()
    service.player = FakePlayer()
    service.protocol = type("Protocol", (), {"connected": False})()
    service._phase = None
    service.respeaker = type("Respeaker", (), {"set_led": lambda self, state: None})()
    service._publish_state = lambda: _nothing()
    return service


@pytest.mark.asyncio
async def test_unsolicited_announcement_plays_while_session_is_idle(announcement_service):
    service = announcement_service

    await service._on_backend_event("announcement.started", {"sample_rate": 24000})
    await service._on_backend_audio(b"pcm")
    await service._on_backend_event("announcement.done", {})

    assert service.player.sample_rate == 24000
    assert service.player.chunks == [b"pcm"]
    assert service._announcement_active is False
    assert service.events.actions == []


@pytest.mark.asyncio
@pytest.mark.parametrize("camera_device_id", ["front-door-camera", "back-door-camera"])
async def test_door_announcement_previews_camera_once_at_start(
    announcement_service, camera_device_id
):
    service = announcement_service
    await service._on_backend_event(
        "announcement.started", {"sample_rate": 24000, "camera_device_id": camera_device_id}
    )

    expected_actions = [("show_camera_preview", {"camera_device_id": camera_device_id})]
    assert service.events.actions == expected_actions

    await service._on_backend_audio(b"pcm")
    await service._on_backend_event("announcement.done", {"camera_device_id": camera_device_id})

    assert service.events.actions == expected_actions
    assert service.player.chunks == [b"pcm"]
    assert service._announcement_active is False


@pytest.mark.asyncio
@pytest.mark.parametrize("camera_device_id", [None, "", " \t ", 123, False, [], {}])
async def test_malformed_announcement_camera_does_not_navigate(
    announcement_service, camera_device_id
):
    service = announcement_service
    await service._on_backend_event("announcement.started", {"camera_device_id": camera_device_id})
    await service._on_backend_audio(b"pcm")
    await service._on_backend_event("announcement.done", {})

    assert service.events.actions == []
    assert service.player.chunks == [b"pcm"]
    assert service._announcement_active is False


async def _nothing():
    return None
