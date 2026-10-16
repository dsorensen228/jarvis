"""HTTP clients for the isolated faster-whisper and Kokoro services."""

from __future__ import annotations

import io
import logging
import re
import wave
from dataclasses import dataclass
from typing import Optional, Tuple

import httpx

from jarvis_api.config import Settings

logger = logging.getLogger(__name__)

_KNOWN_ASR_ARTIFACT = re.compile(r"^thank\s+you[.!?]*$", re.IGNORECASE)

# Fast, deterministic markup cleanup before Kokoro. Prefer plain speech in the
# agent prompt; this catches leftovers without another model call.
_FENCED_CODE = re.compile(r"```[\w+-]*\n?(.*?)```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]+)`")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_HEADING = re.compile(r"^#{1,6}\s*", re.MULTILINE)
_BOLD = re.compile(r"(\*\*|__)(.+?)\1", re.DOTALL)
_ITALIC = re.compile(r"(?<!\w)(\*|_)([^*_\n]+?)\1(?!\w)")
_STRIKE = re.compile(r"~~(.+?)~~", re.DOTALL)
_LEFTOVER_MARKERS = re.compile(r"[*`~]+")
_BULLET = re.compile(r"^\s*[-•*]\s+", re.MULTILINE)
_NUMBERED = re.compile(r"^\s*\d+\.\s+", re.MULTILINE)
_HTML_TAG = re.compile(r"</?[a-zA-Z][^>]*>")
_SPACES = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


class SpeechUnavailable(RuntimeError):
    pass


def speakable_text(text: str) -> str:
    """Strip common markup so TTS hears words instead of symbol names."""
    if not text:
        return ""
    out = str(text)
    out = _FENCED_CODE.sub(r"\1", out)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _IMAGE.sub(r"\1", out)
    out = _LINK.sub(r"\1", out)
    out = _HEADING.sub("", out)
    out = _BOLD.sub(r"\2", out)
    out = _ITALIC.sub(r"\2", out)
    out = _STRIKE.sub(r"\1", out)
    out = _BULLET.sub("", out)
    out = _NUMBERED.sub("", out)
    out = _HTML_TAG.sub("", out)
    out = _LEFTOVER_MARKERS.sub("", out)
    out = _SPACES.sub(" ", out)
    out = _BLANK_LINES.sub("\n\n", out)
    return out.strip()


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str
    duration_seconds: float


class SpeechService:
    def __init__(self, settings: Settings) -> None:
        timeout = httpx.Timeout(settings.speech_request_timeout_seconds, connect=5.0)
        self._asr = httpx.AsyncClient(base_url=settings.asr_url, timeout=timeout)
        self._tts = httpx.AsyncClient(base_url=settings.tts_url, timeout=timeout)

    async def close(self) -> None:
        await self._asr.aclose()
        await self._tts.aclose()

    async def transcribe_pcm16(
        self, pcm: bytes, sample_rate: int = 16000, language: Optional[str] = "en"
    ) -> Transcript:
        if not pcm:
            return Transcript("", language or "", 0.0)
        try:
            response = await self._asr.post(
                "/v1/transcribe",
                params={"sample_rate": sample_rate, "language": language or ""},
                content=pcm,
                headers={"Content-Type": "application/octet-stream"},
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SpeechUnavailable(f"faster-whisper service failed: {exc}") from exc
        text = str(body.get("text", "")).strip()
        if _is_known_asr_artifact(text):
            logger.info("discarded known faster-whisper artifact")
            text = ""
        return Transcript(
            text,
            str(body.get("language", language or "")),
            float(body.get("duration_seconds", len(pcm) / float(sample_rate * 2))),
        )

    async def synthesize_pcm16(self, text: str) -> Tuple[bytes, int]:
        spoken = speakable_text(text)
        if not spoken:
            return b"", 24000
        try:
            response = await self._tts.post("/v1/synthesize", json={"text": spoken})
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise SpeechUnavailable(f"Kokoro service failed: {exc}") from exc
        sample_rate = int(response.headers.get("x-sample-rate", "24000"))
        return response.content, sample_rate

    async def ready(self) -> dict:
        async def probe(client: httpx.AsyncClient) -> bool:
            try:
                return (await client.get("/health/ready", timeout=2.0)).status_code == 200
            except httpx.HTTPError:
                return False

        return {"asr": await probe(self._asr), "tts": await probe(self._tts)}


def _is_known_asr_artifact(text: str) -> bool:
    return _KNOWN_ASR_ARTIFACT.fullmatch(text.strip()) is not None


def wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()
