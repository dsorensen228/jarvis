from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, Query, Request, Response

from jarvis_api.auth import current_user
from jarvis_api.speech import wav_bytes

router = APIRouter(prefix="/v1/speech", tags=["speech"])


@router.post("/transcribe")
async def transcribe(
    request: Request,
    pcm: bytes = Body(..., media_type="application/octet-stream"),
    sample_rate: int = Query(16000, ge=8000, le=48000),
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    transcript = await request.app.state.speech.transcribe_pcm16(pcm, sample_rate)
    return {
        "text": transcript.text,
        "language": transcript.language,
        "duration_seconds": transcript.duration_seconds,
    }


@router.post("/synthesize")
async def synthesize(
    request: Request,
    text: str = Body(..., embed=True, min_length=1, max_length=4000),
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    pcm, sample_rate = await request.app.state.speech.synthesize_pcm16(text)
    return Response(wav_bytes(pcm, sample_rate), media_type="audio/wav")
