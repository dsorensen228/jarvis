from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from jarvis_voice.service import VoiceDeviceService, VoicePhase


def make_service():
    instance = object.__new__(VoiceDeviceService)
    instance._phase = VoicePhase.IDLE
    instance._session_active = False
    instance._activating = False
    instance._interactions_muted = False
    instance._follow_up_deadline = 0.0
    instance._announcement_active = False
    instance._scripted_speech_active = False
    instance._scripted_speech_interrupted = False
    instance._coding_prompt = SimpleNamespace(active=False)
    instance.player = SimpleNamespace(clear=Mock())
    instance.segmenter = SimpleNamespace(reset=Mock())
    instance.barge = SimpleNamespace(reset=Mock())
    instance.wakeword = SimpleNamespace(reset=Mock(), process=Mock(return_value=False))
    instance.protocol = SimpleNamespace(connected=False, cancel_response=AsyncMock())
    instance._transition = AsyncMock()
    instance._publish_state = AsyncMock()
    instance._activate = AsyncMock()
    instance._stop_session = AsyncMock()
    return instance


@pytest.mark.asyncio
async def test_ui_state_includes_interactions_muted():
    service = make_service()
    service.protocol = SimpleNamespace(connected=True)
    assert service.ui_state == {
        "active": False,
        "phase": "idle",
        "connected": True,
        "interactions_muted": False,
    }
    service._interactions_muted = True
    assert service.ui_state["interactions_muted"] is True


@pytest.mark.asyncio
async def test_set_interactions_muted_stops_active_session_and_publishes():
    service = make_service()
    service._session_active = True

    await service.set_interactions_muted(True)

    assert service._interactions_muted is True
    service._stop_session.assert_awaited_once_with(cancel_backend=True)
    service._publish_state.assert_not_awaited()


@pytest.mark.asyncio
async def test_set_interactions_muted_false_publishes_without_stopping():
    service = make_service()
    service._interactions_muted = True

    await service.set_interactions_muted(False)

    assert service._interactions_muted is False
    service._stop_session.assert_not_awaited()
    service._publish_state.assert_awaited_once()


@pytest.mark.asyncio
async def test_toggle_session_ignores_start_while_muted():
    service = make_service()
    service._interactions_muted = True

    await service.toggle_session()

    service._activate.assert_not_awaited()
    service._stop_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_session_still_stops_while_muted():
    service = make_service()
    # Real toggle_session calls the real _stop_session; restore it for this case.
    service._session_active = True
    service._stop_session = AsyncMock()
    service._activate = AsyncMock()

    await VoiceDeviceService.toggle_session(service)

    service._stop_session.assert_awaited_once_with(cancel_backend=True)
    service._activate.assert_not_awaited()
