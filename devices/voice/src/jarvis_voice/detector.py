"""Local WebRTC VAD, utterance segmentation, and conservative barge-in cues."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import sqrt
from typing import Protocol

import numpy as np
import webrtcvad

from jarvis_voice.hardware import HardwareProfile

SAMPLE_RATE = 16000
FRAME_MS = 10
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
BLOCK_MS = 80
BLOCK_SAMPLES = SAMPLE_RATE * BLOCK_MS // 1000


@dataclass(frozen=True)
class Analysis:
    speech_ratio: float
    rms: float

    @property
    def speech(self) -> bool:
        return self.speech_ratio > 0.0


class FirmwareVad(Protocol):
    def is_voice(self, *, max_age_seconds: float = 0.25) -> bool: ...


class PlaybackReference(Protocol):
    def recent_playback(self) -> np.ndarray | None: ...


ECHO_CORRELATION_LIMIT = 0.30


def echo_correlation(mic: np.ndarray, reference: np.ndarray) -> float:
    """Peak normalized cross-correlation of one mic block against recent playback.

    The AEC residual of our own speaker output stays strongly correlated with the
    source signal (~0.5 measured on the ReSpeaker USB 4-mic), while genuine user
    speech is uncorrelated with it. This separates the two even while the on-board
    AEC is still converging after a restart, when residual levels alone look like
    loud speech.
    """
    if reference.size < mic.size:
        return 0.0
    mic_f = mic.astype(np.float64)
    ref_f = reference.astype(np.float64)
    mic_f -= mic_f.mean()
    ref_f -= ref_f.mean()
    mic_energy = float((mic_f**2).sum())
    if mic_energy <= 0.0:
        return 0.0
    size = 1
    while size < ref_f.size + mic_f.size:
        size <<= 1
    spectrum = np.fft.rfft(ref_f, size) * np.conj(np.fft.rfft(mic_f, size))
    lags = ref_f.size - mic_f.size + 1
    corr = np.fft.irfft(spectrum, size)[:lags]
    cumulative = np.concatenate(([0.0], np.cumsum(ref_f**2)))
    window_energy = cumulative[mic_f.size : mic_f.size + lags] - cumulative[:lags]
    valid = window_energy > 0.0
    if not np.any(valid):
        return 0.0
    scores = np.abs(corr[valid]) / np.sqrt(window_energy[valid] * mic_energy)
    return float(scores.max())


class VoiceActivityDetector:
    """WebRTC VAD with an energy gate.

    webrtcvad classifies broadband noise as speech: measured 65-86% speech-positive
    frames on *idle* voice devices (echo-cancel comfort noise at 94 RMS, appliance
    ambience at 1524 RMS). Ungated, that keeps utterances open to the 20 s cap and
    opens phantom segments, so blocks quieter than the profile's speech floor
    report a zero speech ratio.
    """

    def __init__(self, aggressiveness: int = 2, min_rms: float = 0.0) -> None:
        self._vad = webrtcvad.Vad(aggressiveness)
        self._min_rms = min_rms

    def analyze(self, pcm: bytes) -> Analysis:
        samples = np.frombuffer(pcm, dtype="<i2")
        if samples.size != BLOCK_SAMPLES:
            raise ValueError(f"expected {BLOCK_SAMPLES} mono samples, got {samples.size}")
        rms = sqrt(float(np.mean(samples.astype(np.float64) ** 2))) if samples.size else 0.0
        if rms < self._min_rms:
            return Analysis(0.0, rms)
        speech_frames = 0
        frames = 0
        for offset in range(0, samples.size, FRAME_SAMPLES):
            frame = samples[offset : offset + FRAME_SAMPLES]
            if frame.size != FRAME_SAMPLES:
                break
            frames += 1
            if self._vad.is_speech(frame.tobytes(), SAMPLE_RATE):
                speech_frames += 1
        return Analysis(speech_frames / frames if frames else 0.0, rms)


@dataclass(frozen=True)
class SegmentUpdate:
    started: tuple[bytes, ...] = ()
    audio: bytes | None = None
    ended: bool = False


class UtteranceSegmenter:
    """Turn fixed 80 ms blocks into one locally bounded utterance."""

    def __init__(self, silence_ms: int, max_seconds: int) -> None:
        self._silence_blocks = max(1, round(silence_ms / BLOCK_MS))
        self._max_blocks = max(1, round(max_seconds * 1000 / BLOCK_MS))
        self._pre_roll: deque[bytes] = deque(maxlen=3)
        self._onset: deque[bytes] = deque(maxlen=2)
        self._active = False
        self._silence = 0
        self._blocks = 0

    @property
    def active(self) -> bool:
        return self._active

    def reset(self) -> None:
        self._pre_roll.clear()
        self._onset.clear()
        self._active = False
        self._silence = 0
        self._blocks = 0

    def process(self, pcm: bytes, analysis: Analysis) -> SegmentUpdate:
        if not self._active:
            if analysis.speech_ratio >= 0.5:
                self._onset.append(pcm)
            else:
                self._onset.clear()
                self._pre_roll.append(pcm)
            if len(self._onset) < 2:
                return SegmentUpdate()
            self._active = True
            self._blocks = len(self._onset)
            start = tuple(self._pre_roll) + tuple(self._onset)
            self._pre_roll.clear()
            self._onset.clear()
            return SegmentUpdate(started=start)

        self._blocks += 1
        quiet = analysis.speech_ratio <= 0.25
        self._silence = self._silence + 1 if quiet else 0
        ended = self._silence >= self._silence_blocks or self._blocks >= self._max_blocks
        return SegmentUpdate(audio=pcm, ended=ended)


class BargeInDetector:
    """Trigger on sustained, loud, non-echo speech while the assistant is talking.

    A block counts toward barge-in only when all of these hold:
    - RMS clears the profile floor, rejecting the steady-state AEC residual of our
      own playback plus ambient noise;
    - it is speech-like: the on-chip firmware VAD (post-AEC, never asserted by our
      own playback in measurement) confirms voice, or the WebRTC ratio clears the
      profile floor AND the block does not correlate with recently played audio
      (which catches loud echo residual while the AEC is still converging);
    - the streak of such blocks spans ``barge_consecutive_chunks`` (~320 ms),
      rejecting wind gusts, thumps, and other transients.

    A short hold-off after playback starts skips trailing user syllables and
    echo-path onset transients.
    """

    def __init__(
        self,
        profile: HardwareProfile,
        firmware_vad: FirmwareVad | None = None,
        playback: PlaybackReference | None = None,
    ) -> None:
        self._profile = profile
        self._firmware_vad = firmware_vad
        self._playback = playback
        self._streak = 0
        self._holdoff = 0
        self.last_echo_correlation = 0.0

    def reset(self, holdoff_blocks: int = 0) -> None:
        self._streak = 0
        self._holdoff = max(0, holdoff_blocks)

    def process(self, pcm: bytes, analysis: Analysis) -> bool:
        if self._holdoff:
            self._holdoff -= 1
            self._streak = 0
            return False
        active = analysis.rms >= self._profile.barge_min_rms and self._is_user_speech(pcm, analysis)
        self._streak = self._streak + 1 if active else 0
        if self._streak < self._profile.barge_consecutive_chunks:
            return False
        self._streak = 0
        return True

    def is_own_playback_echo(self, pcm: bytes) -> bool:
        """Whether this block correlates with audio we recently played ourselves."""
        reference = self._playback.recent_playback() if self._playback is not None else None
        if reference is None:
            return False
        self.last_echo_correlation = echo_correlation(np.frombuffer(pcm, dtype="<i2"), reference)
        return self.last_echo_correlation >= ECHO_CORRELATION_LIMIT

    def _is_user_speech(self, pcm: bytes, analysis: Analysis) -> bool:
        if self._firmware_vad is not None and self._firmware_vad.is_voice():
            return True
        if analysis.speech_ratio < self._profile.barge_min_ratio:
            return False
        return not self.is_own_playback_echo(pcm)
