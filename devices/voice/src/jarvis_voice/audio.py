"""PortAudio capture and low-latency interruptible PCM playback."""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import pi
from typing import Any

import audioop
import numpy as np

from jarvis_voice.detector import BLOCK_SAMPLES
from jarvis_voice.hardware import HardwareProfile

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AudioDevices:
    input_index: int | None
    input_name: str
    output_index: int | None
    output_name: str


def _pick_device(
    devices: Sequence[Mapping[str, Any]],
    *,
    direction: str,
    override: str,
    hints: Iterable[str],
) -> tuple[int | None, str]:
    if override.strip().lower() == "default":
        return None, "default"
    channels_key = "max_input_channels" if direction == "input" else "max_output_channels"
    candidates = [
        (index, str(device.get("name", "")))
        for index, device in enumerate(devices)
        if int(device.get(channels_key, 0)) > 0
    ]
    needles = (override,) if override else tuple(hints)
    for needle in needles:
        lowered = needle.lower()
        matches = [(index, name) for index, name in candidates if lowered in name.lower()]
        if matches:
            if len(matches) > 1:
                logger.warning(
                    "multiple %s devices match %r; using %s",
                    direction,
                    needle,
                    matches[0][1],
                )
            return matches[0]
    choices = ", ".join(f"{index}:{name}" for index, name in candidates) or "none"
    wanted = override or "/".join(hints)
    raise RuntimeError(f"no {direction} device matches {wanted!r}; available: {choices}")


def resolve_audio_devices(
    profile: HardwareProfile,
    input_override: str = "",
    output_override: str = "",
) -> AudioDevices:
    import sounddevice as sd

    devices = list(sd.query_devices())
    input_index, input_name = _pick_device(
        devices,
        direction="input",
        override=input_override,
        hints=profile.input_name_hints,
    )
    output_index, output_name = _pick_device(
        devices,
        direction="output",
        override=output_override,
        hints=profile.output_name_hints,
    )
    sd.check_input_settings(
        device=input_index,
        channels=profile.capture_channels,
        dtype="int16",
        samplerate=profile.capture_sample_rate,
    )
    sd.check_output_settings(
        device=output_index,
        channels=1,
        dtype="int16",
        samplerate=profile.playback_sample_rate,
    )
    resolved = AudioDevices(input_index, input_name, output_index, output_name)
    logger.info("audio input: %s (%s)", input_name, input_index)
    logger.info("audio output: %s (%s)", output_name, output_index)
    return resolved


class AudioInput:
    def __init__(self, profile: HardwareProfile, device_index: int | None) -> None:
        self._profile = profile
        self._device_index = device_index
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=32)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stream: Any | None = None
        self.dropped_blocks = 0

    def start(self) -> None:
        import sounddevice as sd

        self._loop = asyncio.get_running_loop()

        def callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
            del time_info
            if status:
                logger.warning("audio capture status: %s", status)
            if frames != BLOCK_SAMPLES:
                logger.warning(
                    "audio capture returned %d frames; expected %d",
                    frames,
                    BLOCK_SAMPLES,
                )
            raw = bytes(indata)
            if self._profile.capture_channels > 1:
                samples = np.frombuffer(raw, dtype="<i2").reshape(
                    -1, self._profile.capture_channels
                )
                raw = samples[:, self._profile.capture_channel_index].astype("<i2").tobytes()
            assert self._loop is not None
            self._loop.call_soon_threadsafe(self._offer, raw)

        self._stream = sd.RawInputStream(
            samplerate=self._profile.capture_sample_rate,
            blocksize=BLOCK_SAMPLES,
            device=self._device_index,
            channels=self._profile.capture_channels,
            dtype="int16",
            latency="low",
            callback=callback,
        )
        self._stream.start()

    def _offer(self, block: bytes) -> None:
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self.dropped_blocks += 1
        self._queue.put_nowait(block)

    async def read(self) -> bytes:
        return await self._queue.get()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


@dataclass(frozen=True)
class _PlaybackMessage:
    kind: str
    generation: int
    pcm: bytes = b""
    source_rate: int = 16000


class AudioPlayer:
    REFERENCE_SECONDS = 0.8

    def __init__(self, sample_rate: int, device_index: int | None) -> None:
        self.sample_rate = sample_rate
        self.device_index = device_index
        self._messages: queue.Queue[_PlaybackMessage] = queue.Queue(maxsize=256)
        self._generation = 0
        self._lock = threading.Lock()
        self._playing = threading.Event()
        self._failed = threading.Event()
        self.output_latency_seconds = 0.2
        self._closed = threading.Event()
        self._reference_lock = threading.Lock()
        self._reference = b""
        self._reference_limit = int(sample_rate * self.REFERENCE_SECONDS) * 2
        self._thread = threading.Thread(target=self._run, name="jarvis-playback", daemon=True)
        self._thread.start()

    @property
    def is_playing(self) -> bool:
        return self._playing.is_set()

    @property
    def playback_failed(self) -> bool:
        return self._failed.is_set()

    def start_response(self, source_rate: int) -> None:
        if self.playback_failed:
            raise RuntimeError("audio playback worker unavailable")
        self.clear()
        generation = self._current_generation()
        self._playing.set()
        self._messages.put_nowait(
            _PlaybackMessage("start", generation, source_rate=int(source_rate))
        )

    def enqueue(self, pcm: bytes) -> None:
        if not pcm:
            return
        generation = self._current_generation()
        try:
            self._messages.put_nowait(_PlaybackMessage("audio", generation, pcm=pcm))
        except queue.Full:
            logger.error("playback queue overflow; cancelling response audio")
            self.clear()

    def finish_response(self) -> None:
        try:
            self._messages.put_nowait(_PlaybackMessage("finish", self._current_generation()))
        except queue.Full:
            logger.error("playback queue overflow at response boundary")
            self.clear()

    def play_clip(self, pcm: bytes, source_rate: int | None = None) -> None:
        self.start_response(source_rate or self.sample_rate)
        self.enqueue(pcm)
        self.finish_response()

    def clear(self) -> None:
        with self._lock:
            self._generation += 1
        self._playing.clear()
        while True:
            try:
                self._messages.get_nowait()
            except queue.Empty:
                break

    def close(self) -> None:
        self.clear()
        self._closed.set()
        self._messages.put_nowait(_PlaybackMessage("close", self._current_generation()))
        self._thread.join(timeout=3.0)

    def _current_generation(self) -> int:
        with self._lock:
            return self._generation

    def _reference_append(self, pcm: bytes) -> None:
        with self._reference_lock:
            self._reference = (self._reference + pcm)[-self._reference_limit :]

    def recent_playback(self) -> np.ndarray | None:
        """Recently played 16 kHz mono samples, for echo rejection in barge-in."""
        with self._reference_lock:
            data = self._reference
        if len(data) < 2:
            return None
        samples = np.frombuffer(data, dtype="<i2")
        if not samples.any():
            return None
        return samples

    def _run(self) -> None:
        import sounddevice as sd

        current_generation = -1
        source_rate = self.sample_rate
        rate_state: Any = None
        frame_bytes = self.sample_rate * 20 // 1000 * 2
        try:
            with sd.RawOutputStream(
                samplerate=self.sample_rate,
                blocksize=0,
                device=self.device_index,
                channels=1,
                dtype="int16",
                latency="low",
            ) as stream:
                self.output_latency_seconds = float(stream.latency)
                while not self._closed.is_set():
                    message = self._messages.get()
                    if message.kind == "close":
                        return
                    if message.generation != self._current_generation():
                        continue
                    if message.kind == "start":
                        current_generation = message.generation
                        source_rate = message.source_rate
                        rate_state = None
                        continue
                    if message.kind == "finish":
                        if message.generation == current_generation:
                            self._playing.clear()
                        continue
                    if message.kind != "audio" or message.generation != current_generation:
                        continue
                    pcm = message.pcm
                    if source_rate != self.sample_rate:
                        pcm, rate_state = audioop.ratecv(
                            pcm,
                            2,
                            1,
                            source_rate,
                            self.sample_rate,
                            rate_state,
                        )
                    for offset in range(0, len(pcm), frame_bytes):
                        if message.generation != self._current_generation():
                            break
                        frame = pcm[offset : offset + frame_bytes]
                        stream.write(frame)
                        self._reference_append(frame)
        except Exception:
            logger.exception("audio playback worker failed")
            self._failed.set()
            self._playing.clear()


def wake_chime(sample_rate: int = 16000) -> bytes:
    duration = 0.11
    count = int(sample_rate * duration)
    t = np.arange(count, dtype=np.float64) / sample_rate
    envelope = np.minimum(1.0, np.minimum(t / 0.015, (duration - t) / 0.025))
    wave = 0.14 * envelope * (np.sin(2 * pi * 660 * t) + 0.55 * np.sin(2 * pi * 880 * t))
    return np.clip(wave * 32767, -32768, 32767).astype("<i2").tobytes()
