import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from jarvis_voice.service import VoiceDeviceService, VoicePhase


def make_service():
    instance = object.__new__(VoiceDeviceService)
    instance._phase = VoicePhase.IDLE
    instance._session_active = False
    instance._activating = False
    instance._announcement_active = False
    instance._scripted_speech_active = False
    instance._scripted_speech_interrupted = False
    instance._coding_prompt = SimpleNamespace(active=False)
    instance.player = SimpleNamespace(
        is_playing=False,
        playback_failed=False,
        output_latency_seconds=0,
        start_response=Mock(),
        enqueue=Mock(),
        finish_response=Mock(),
        clear=Mock(),
    )
    instance.wakeword = SimpleNamespace(reset=Mock())
    instance._transition = AsyncMock()
    instance._wait_for_playback = AsyncMock()
    return instance


def payload():
    return {"sample_rate": 24000, "pcm_base64": base64.b64encode(b"\x01\x00" * 20).decode()}


async def test_scripted_speech_waits_for_drain_and_returns_idle_without_followup():
    service = make_service()
    entered, finish = asyncio.Event(), asyncio.Event()

    async def wait(**kwargs):
        entered.set()
        await finish.wait()

    service._wait_for_playback = wait
    assert await service._execute_device_action("speech_status", {}) == {"idle": True}
    task = asyncio.create_task(service._execute_device_action("play_scripted_speech", payload()))
    await entered.wait()
    assert not task.done()
    assert not service._idle_for_scripted_speech()
    finish.set()
    assert await task == {"status": "played"}
    assert service._session_active is False
    service._transition.assert_awaited_with(VoicePhase.IDLE)
    assert service.player.enqueue.call_args.args[0] == b"\x01\x00" * 20


async def test_busy_or_interrupted_or_failed_never_reports_played():
    service = make_service()
    service._session_active = True
    assert await service._play_scripted_speech(payload()) == {"status": "busy"}
    service.player.enqueue.assert_not_called()
    service._session_active = False

    async def interrupted(**kwargs):
        service._scripted_speech_interrupted = True
        service._session_active = True

    service._wait_for_playback = interrupted
    assert await service._play_scripted_speech(payload()) == {"status": "interrupted"}
    service.player.clear.assert_not_called()
    assert service._session_active is True
    service = make_service()

    async def failed(**kwargs):
        service.player.playback_failed = True

    service._wait_for_playback = failed
    assert await service._play_scripted_speech(payload()) == {"status": "failed"}


@pytest.mark.parametrize(
    "bad",
    [
        {"sample_rate": True, "pcm_base64": "AQAA"},
        {"sample_rate": 24000, "pcm_base64": "bad!"},
        {"sample_rate": 24000, "pcm_base64": "YQ=="},
        {"sample_rate": 24000, "pcm_base64": ""},
    ],
)
async def test_invalid_audio_rejected_before_playback(bad):
    service = make_service()
    with pytest.raises(ValueError):
        await service._play_scripted_speech(bad)
    service.player.enqueue.assert_not_called()
