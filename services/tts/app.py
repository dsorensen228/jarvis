"""Dedicated Kokoro service returning mono PCM16 for low-overhead streaming."""

import os
from contextlib import asynccontextmanager
from typing import Protocol

import numpy as np
from fastapi import FastAPI, HTTPException, Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel, Field

JARVIS_LANGUAGE = "en-gb"
JARVIS_VOICE_COMPONENTS = (("bm_george", 0.65), ("bm_daniel", 0.35))
DEFAULT_SPEECH_SPEED = 1.2


class VoiceModel(Protocol):
    def get_voice_style(self, name: str) -> np.ndarray: ...


def build_jarvis_voice(model: VoiceModel) -> np.ndarray:
    """Create Jarvis's fixed voice embedding from two British male voices."""
    components = [
        (name, weight, model.get_voice_style(name))
        for name, weight in JARVIS_VOICE_COMPONENTS
    ]
    expected_shape = components[0][2].shape
    if any(style.shape != expected_shape for _, _, style in components):
        raise RuntimeError("Jarvis voice components have incompatible shapes")

    voice = np.zeros(expected_shape, dtype=np.float32)
    for _, weight, style in components:
        voice += style.astype(np.float32, copy=False) * weight
    return voice


kokoro: Kokoro | None = None
jarvis_voice: np.ndarray | None = None
speech_speed = DEFAULT_SPEECH_SPEED


class SynthesisRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global jarvis_voice, kokoro, speech_speed
    model_dir = os.getenv("KOKORO_MODEL_DIR", "/models")
    speech_speed = float(os.getenv("KOKORO_SPEED", str(DEFAULT_SPEECH_SPEED)))
    if not 0.5 <= speech_speed <= 2.0:
        raise RuntimeError("KOKORO_SPEED must be between 0.5 and 2.0")
    kokoro = Kokoro(
        os.path.join(model_dir, "kokoro-v1.0.onnx"),
        os.path.join(model_dir, "voices-v1.0.bin"),
    )
    jarvis_voice = build_jarvis_voice(kokoro)
    yield
    jarvis_voice = None
    kokoro = None


app = FastAPI(title="Jarvis Kokoro", lifespan=lifespan)


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready():
    if kokoro is None or jarvis_voice is None:
        raise HTTPException(status_code=503, detail="model is not loaded")
    return {
        "status": "ok",
        "voice": "jarvis",
        "language": JARVIS_LANGUAGE,
        "components": [
            {"name": name, "weight": weight}
            for name, weight in JARVIS_VOICE_COMPONENTS
        ],
        "speed": speech_speed,
    }


@app.post("/v1/synthesize")
async def synthesize(body: SynthesisRequest):
    if kokoro is None or jarvis_voice is None:
        raise HTTPException(status_code=503, detail="model is not loaded")
    samples, sample_rate = kokoro.create(
        body.text,
        voice=jarvis_voice,
        speed=speech_speed,
        lang=JARVIS_LANGUAGE,
    )
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return Response(
        pcm,
        media_type="audio/L16",
        headers={"X-Sample-Rate": str(sample_rate), "X-Channels": "1"},
    )
