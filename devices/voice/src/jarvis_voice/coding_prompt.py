"""Bounded in-memory recording for manually initiated coding prompts."""

from __future__ import annotations


class PromptRecorder:
    def __init__(self, max_bytes: int) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self._max_bytes = max_bytes
        self._chunks: list[bytes] = []
        self._size = 0
        self._active = False
        self._overflowed = False

    @property
    def active(self) -> bool:
        return self._active

    @property
    def overflowed(self) -> bool:
        return self._overflowed

    def start(self) -> None:
        if self._active:
            raise RuntimeError("a coding prompt is already being recorded")
        self._chunks.clear()
        self._size = 0
        self._overflowed = False
        self._active = True

    def push(self, pcm: bytes) -> None:
        if not self._active or not pcm:
            return
        remaining = self._max_bytes - self._size
        if remaining <= 0:
            self._overflowed = True
            return
        chunk = pcm[:remaining]
        self._chunks.append(chunk)
        self._size += len(chunk)
        if len(chunk) < len(pcm):
            self._overflowed = True

    def stop(self) -> bytes:
        if not self._active:
            raise RuntimeError("no coding prompt recording is active")
        self._active = False
        pcm = b"".join(self._chunks)
        self._chunks.clear()
        self._size = 0
        return pcm

    def cancel(self) -> None:
        self._active = False
        self._chunks.clear()
        self._size = 0
        self._overflowed = False
