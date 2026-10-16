from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from jarvis_voice.local_commands import exact_light_command
from jarvis_voice.service import VoiceDeviceService, VoicePhase


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("lights on", "on"),
        ("lights off", "off"),
        ("Lights On", "on"),
        ("  LIGHTS OFF  ", "off"),
        ("lights on.", "on"),
        ("lights off!", "off"),
        ("turn the lights on", None),
        ("lights on please", None),
        ("office lights off", None),
        ("", None),
        ("hello", None),
    ],
)
def test_exact_light_command_matches_only_bare_phrases(text, expected):
    assert exact_light_command(text) == expected


def _make_service():
    instance = object.__new__(VoiceDeviceService)
    instance._phase = VoicePhase.THINKING
    instance._session_active = True
    instance._activating = False
    instance._follow_up_deadline = 0.0
    instance._announcement_active = False
    instance._scripted_speech_active = False
    instance._scripted_speech_interrupted = False
    instance._last_conversation_activity = 1.0
    instance.settings = SimpleNamespace(room="office")
    instance.events = SimpleNamespace(set_voice_state=AsyncMock())
    instance.protocol = SimpleNamespace(
        connected=True,
        cancel_response=AsyncMock(),
        configure_conversation=AsyncMock(),
    )
    instance.player = SimpleNamespace(clear=Mock())
    instance.segmenter = SimpleNamespace(reset=Mock())
    instance.barge = SimpleNamespace(reset=Mock())
    instance.wakeword = SimpleNamespace(reset=Mock())
    instance.api = SimpleNamespace(json=AsyncMock(return_value={"succeeded": 1}))
    instance._transition = AsyncMock()
    instance._stop_session = AsyncMock()
    return instance


@pytest.mark.asyncio
async def test_transcription_final_short_circuits_exact_lights_on():
    service = _make_service()

    await service._on_backend_event("transcription.final", {"text": "lights on"})

    service.events.set_voice_state.assert_awaited_once_with(transcript="lights on")
    service.protocol.cancel_response.assert_awaited_once()
    service.api.json.assert_awaited_once_with(
        "POST",
        "/v1/smart-devices/control",
        body={
            "scope": "room",
            "selector": "office",
            "action": "turn_on",
            "parameters": {},
        },
    )
    service._stop_session.assert_awaited_once_with(cancel_backend=False)
    service.protocol.configure_conversation.assert_awaited_once_with(None)
    assert service._last_conversation_activity == 0.0


@pytest.mark.asyncio
async def test_transcription_final_short_circuits_exact_lights_off():
    service = _make_service()

    await service._on_backend_event("transcription.final", {"text": "Lights off."})

    service.api.json.assert_awaited_once_with(
        "POST",
        "/v1/smart-devices/control",
        body={
            "scope": "room",
            "selector": "office",
            "action": "turn_off",
            "parameters": {},
        },
    )
    service.protocol.cancel_response.assert_awaited_once()


@pytest.mark.asyncio
async def test_transcription_final_ignores_non_exact_light_phrases():
    service = _make_service()

    await service._on_backend_event("transcription.final", {"text": "turn the lights on"})

    service.events.set_voice_state.assert_awaited_once_with(transcript="turn the lights on")
    service.protocol.cancel_response.assert_not_awaited()
    service.api.json.assert_not_awaited()
    service._stop_session.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_light_short_circuit_requires_configured_room():
    service = _make_service()
    service.settings = SimpleNamespace(room="")

    await service._on_backend_event("transcription.final", {"text": "lights on"})

    service.protocol.cancel_response.assert_not_awaited()
    service.api.json.assert_not_awaited()
    service._stop_session.assert_not_awaited()
