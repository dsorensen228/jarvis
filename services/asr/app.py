"""Dedicated faster-whisper service; VAD and turn boundaries stay on client devices."""

import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from faster_whisper import WhisperModel

model = None
WHISPER_SAMPLE_RATE = 16000


def resample_for_whisper(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Convert raw client PCM to Whisper's fixed 16 kHz input rate."""
    if sample_rate == WHISPER_SAMPLE_RATE or samples.size < 2:
        return samples
    output_size = max(1, round(samples.size * WHISPER_SAMPLE_RATE / sample_rate))
    source_positions = np.arange(samples.size, dtype=np.float64)
    target_positions = (
        np.arange(output_size, dtype=np.float64) * sample_rate / WHISPER_SAMPLE_RATE
    )
    return np.interp(target_positions, source_positions, samples).astype(np.float32)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    model = WhisperModel(
        os.getenv("WHISPER_MODEL", "Systran/faster-distil-whisper-large-v3"),
        device=os.getenv("WHISPER_DEVICE", "cuda"),
        compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8_float16"),
    )
    yield
    model = None


app = FastAPI(title="Jarvis faster-whisper", lifespan=lifespan)


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready():
    if model is None:
        raise HTTPException(status_code=503, detail="model is not loaded")
    return {"status": "ok"}


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    sample_rate: int = Query(16000, ge=8000, le=48000),
    language: str = Query("en", max_length=16),
):
    pcm = await request.body()
    if not pcm or len(pcm) % 2:
        raise HTTPException(status_code=400, detail="body must be PCM signed 16-bit mono audio")
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    whisper_samples = resample_for_whisper(samples, sample_rate)
    segments, info = model.transcribe(
        whisper_samples,
        language=language or None,
        beam_size=1,
        best_of=1,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "text": text,
        "language": getattr(info, "language", None) or language,
        "duration_seconds": len(samples) / float(sample_rate),
    }
