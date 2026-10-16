from __future__ import annotations

import pytest

from jarvis_api.speech import SpeechService, _is_known_asr_artifact, speakable_text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("**not available**", "not available"),
        ("*softly* unavailable", "softly unavailable"),
        ("Status: __offline__", "Status: offline"),
        ("Use `room_lights_off` now", "Use room_lights_off now"),
        ("## Heading\nPlain answer", "Heading\nPlain answer"),
        ("See [docs](https://example.com) please", "See docs please"),
        ("- first\n- second", "first\nsecond"),
        ("1. alpha\n2. beta", "alpha\nbeta"),
        ("Already plain speech.", "Already plain speech."),
        ("****", ""),
        ("  **bold**  ", "bold"),
    ],
)
def test_speakable_text_strips_markup_for_tts(raw, expected):
    assert speakable_text(raw) == expected


def test_speakable_text_does_not_mangle_apostrophes_or_hyphenated_words():
    assert speakable_text("It's well-known, isn't it?") == "It's well-known, isn't it?"


@pytest.mark.asyncio
async def test_synthesize_sends_speakable_text_to_kokoro():
    posted = {}

    class Response:
        content = b"\x01\x00" * 8
        headers = {"x-sample-rate": "24000"}

        @staticmethod
        def raise_for_status():
            return None

    class Tts:
        @staticmethod
        async def post(path, json):
            posted["path"] = path
            posted["json"] = json
            return Response()

    service = SpeechService.__new__(SpeechService)
    service._tts = Tts()

    pcm, sample_rate = await service.synthesize_pcm16("**not available**")

    assert pcm == Response.content
    assert sample_rate == 24000
    assert posted["path"] == "/v1/synthesize"
    assert posted["json"] == {"text": "not available"}


@pytest.mark.parametrize(
    "text",
    ["thank you", "Thank you.", " THANK   YOU! ", "thank you???"],
)
def test_known_whisper_thank_you_artifact_is_exactly_matched(text):
    assert _is_known_asr_artifact(text)


@pytest.mark.parametrize(
    "text",
    ["thank you for the help", "no thank you", "thanks", "thank you, Jarvis"],
)
def test_real_phrases_containing_thank_you_are_not_discarded(text):
    assert not _is_known_asr_artifact(text)


@pytest.mark.asyncio
async def test_transcription_discards_artifact_before_callers_receive_it():
    class Response:
        @staticmethod
        def raise_for_status():
            return None

        @staticmethod
        def json():
            return {
                "text": "Thank you.",
                "language": "en",
                "duration_seconds": 1.2,
            }

    class Asr:
        @staticmethod
        async def post(*args, **kwargs):
            return Response()

    service = SpeechService.__new__(SpeechService)
    service._asr = Asr()

    transcript = await service.transcribe_pcm16(b"\x00\x00" * 1600)

    assert transcript.text == ""
    assert transcript.language == "en"
