from __future__ import annotations

import numpy as np
import pytest

from jarvis_voice.detector import (
    BLOCK_SAMPLES,
    Analysis,
    BargeInDetector,
    UtteranceSegmenter,
    VoiceActivityDetector,
)
from jarvis_voice.hardware import LITE_PID, USB_4MIC_PID, XVF3800_PID, profile_for_pid


def block(value: int = 0) -> bytes:
    return np.full(BLOCK_SAMPLES, value, dtype="<i2").tobytes()


def test_vad_requires_one_exact_80ms_block():
    detector = VoiceActivityDetector()
    with pytest.raises(ValueError, match="expected"):
        detector.analyze(b"\0\0")
    assert detector.analyze(block()).rms == 0.0


def test_vad_energy_gate_silences_quiet_broadband_noise():
    """webrtcvad flags quiet broadband noise (echo-cancel comfort noise, appliance
    ambience) as speech, which kept utterances open to the max cap. Blocks under
    the profile speech floor must report zero speech ratio while their RMS stays
    observable; the same noise above the floor is still analyzed."""
    rng = np.random.default_rng(5)
    noise = np.clip(rng.standard_normal(BLOCK_SAMPLES) * 130, -32768, 32767).astype("<i2")
    gated = VoiceActivityDetector(min_rms=250.0).analyze(noise.tobytes())
    assert gated.speech_ratio == 0.0
    assert not gated.speech
    assert gated.rms > 0.0
    loud = np.clip(rng.standard_normal(BLOCK_SAMPLES) * 400, -32768, 32767).astype("<i2")
    assert VoiceActivityDetector(min_rms=250.0).analyze(loud.tobytes()).rms >= 250.0


def test_segmenter_adds_preroll_and_closes_on_silence():
    segmenter = UtteranceSegmenter(silence_ms=160, max_seconds=10)
    quiet = Analysis(0.0, 0.0)
    speech = Analysis(1.0, 2000.0)
    segmenter.process(block(), quiet)
    segmenter.process(block(), quiet)
    assert not segmenter.process(block(1000), speech).started
    started = segmenter.process(block(1000), speech)
    assert len(started.started) == 4
    assert not segmenter.process(block(), quiet).ended
    assert segmenter.process(block(), quiet).ended


class FirmwareVoice:
    def __init__(self, voice: bool = True) -> None:
        self.voice = voice

    def is_voice(self, *, max_age_seconds: float = 0.25) -> bool:
        return self.voice


class Playback:
    def __init__(self, samples: np.ndarray | None) -> None:
        self.samples = samples

    def recent_playback(self) -> np.ndarray | None:
        return self.samples


def speech_like(
    samples: int, seed: int = 7, pitch_hz: float = 180.0, cadence_hz: float = 3.1
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(samples, dtype=np.float64) / 16000.0
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * cadence_hz * t)
    wave = np.sin(2 * np.pi * pitch_hz * t) + 0.4 * rng.standard_normal(samples)
    return np.clip(envelope * wave * 9000, -32768, 32767).astype("<i2")


def trigger_after(detector: BargeInDetector, pcm: bytes, analysis: Analysis, blocks: int) -> bool:
    return any(detector.process(pcm, analysis) for _ in range(blocks))


def test_usb4_barge_in_needs_full_streak_of_loud_firmware_voice():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(profile, FirmwareVoice())
    loud = Analysis(0.0, profile.barge_min_rms + 1)
    for _ in range(profile.barge_consecutive_chunks - 1):
        assert detector.process(block(), loud) is False
    assert detector.process(block(), loud) is True
    assert detector.process(block(), loud) is False


def test_usb4_barge_in_falls_back_to_webrtc_when_firmware_vad_is_dead():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(profile, FirmwareVoice(voice=False))
    speech = Analysis(1.0, profile.barge_min_rms + 1)
    assert trigger_after(detector, block(), speech, profile.barge_consecutive_chunks) is True


def test_usb4_barge_in_ignores_quiet_echo_residual():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(profile, FirmwareVoice(voice=False))
    echo = Analysis(1.0, profile.barge_min_rms - 1)
    assert trigger_after(detector, block(), echo, 20) is False


def test_usb4_barge_in_ignores_loud_non_speech_wind():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(profile, FirmwareVoice(voice=False))
    wind = Analysis(0.2, profile.barge_min_rms * 3)
    assert trigger_after(detector, block(), wind, 20) is False


def test_barge_in_holdoff_delays_detection_after_playback_starts():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(profile, FirmwareVoice())
    loud = Analysis(1.0, profile.barge_min_rms + 1)
    detector.reset(holdoff_blocks=3)
    assert trigger_after(detector, block(), loud, 3) is False
    assert trigger_after(detector, block(), loud, profile.barge_consecutive_chunks) is True


def test_barge_in_rejects_loud_unconverged_echo_of_own_playback():
    profile = profile_for_pid(USB_4MIC_PID)
    played = speech_like(12800)
    detector = BargeInDetector(profile, FirmwareVoice(voice=False), Playback(played))
    echo = np.round(played[4000 : 4000 + BLOCK_SAMPLES] * 0.8).astype("<i2")
    loud_speechy = Analysis(1.0, 8000.0)
    assert trigger_after(detector, echo.tobytes(), loud_speechy, 20) is False
    assert detector.last_echo_correlation > 0.5


def test_barge_in_accepts_loud_speech_uncorrelated_with_playback():
    profile = profile_for_pid(USB_4MIC_PID)
    detector = BargeInDetector(
        profile, FirmwareVoice(voice=False), Playback(speech_like(12800, seed=1))
    )
    user = speech_like(BLOCK_SAMPLES, seed=2, pitch_hz=317.0, cadence_hz=4.7)
    loud_speechy = Analysis(1.0, 8000.0)
    assert (
        trigger_after(detector, user.tobytes(), loud_speechy, profile.barge_consecutive_chunks)
        is True
    )
    assert detector.last_echo_correlation < 0.3


def test_own_playback_echo_flags_echo_and_passes_novel_speech():
    profile = profile_for_pid(USB_4MIC_PID)
    played = speech_like(12800)
    detector = BargeInDetector(profile, None, Playback(played))
    echo = np.round(played[2000 : 2000 + BLOCK_SAMPLES] * 0.5).astype("<i2")
    assert detector.is_own_playback_echo(echo.tobytes()) is True
    user = speech_like(BLOCK_SAMPLES, seed=3, pitch_hz=317.0, cadence_hz=4.7)
    assert detector.is_own_playback_echo(user.tobytes()) is False


@pytest.mark.parametrize("product_id", [LITE_PID, XVF3800_PID])
def test_profiles_without_firmware_vad_barge_on_loud_uncorrelated_speech(product_id):
    """Lite and XVF3800 rely on WebRTC ratio + echo correlation alone; real speech
    modestly above the profile floor must trigger within one streak."""
    profile = profile_for_pid(product_id)
    detector = BargeInDetector(profile, None, Playback(speech_like(12800, seed=1)))
    user = speech_like(BLOCK_SAMPLES, seed=2, pitch_hz=317.0, cadence_hz=4.7)
    speech = Analysis(1.0, profile.barge_min_rms + 100.0)
    assert trigger_after(detector, user.tobytes(), speech, profile.barge_consecutive_chunks) is True


def test_lite_barge_in_rejects_loud_unconverged_echo():
    """Before the software AEC converges, Lite echo residual is loud and speech-like;
    only the playback correlation guard separates it from a real barge-in."""
    profile = profile_for_pid(LITE_PID)
    played = speech_like(12800)
    detector = BargeInDetector(profile, None, Playback(played))
    echo = np.round(played[4000 : 4000 + BLOCK_SAMPLES] * 0.9).astype("<i2")
    loud_speechy = Analysis(1.0, 6000.0)
    assert trigger_after(detector, echo.tobytes(), loud_speechy, 20) is False
    assert detector.last_echo_correlation > 0.5


def test_firmware_voice_bypasses_echo_correlation_check():
    profile = profile_for_pid(USB_4MIC_PID)
    played = speech_like(12800)
    detector = BargeInDetector(profile, FirmwareVoice(voice=True), Playback(played))
    echo = played[:BLOCK_SAMPLES]
    loud = Analysis(0.0, 8000.0)
    assert trigger_after(detector, echo.tobytes(), loud, profile.barge_consecutive_chunks)
