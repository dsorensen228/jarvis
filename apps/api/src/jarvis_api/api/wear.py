from __future__ import annotations

import base64
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from jarvis_api.auth import current_user
from jarvis_api.domain import WearChatRequest
from jarvis_api.speech import SpeechUnavailable

router = APIRouter(prefix="/v1/wear", tags=["wearable"])


@router.post("/chat")
async def wearable_chat(
    body: WearChatRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """One low-round-trip turn for constrained Wear OS clients.

    The watch performs speech recognition locally, while the API owns the agent
    turn and Kokoro synthesis. Audio is raw mono signed 16-bit little-endian PCM.
    """
    try:
        result = await request.app.state.agent.run(
            user["id"], body.message, conversation_id=body.conversation_id
        )
        pcm, sample_rate = await request.app.state.speech.synthesize_pcm16(result.text)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SpeechUnavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "conversation_id": result.conversation_id,
        "response": result.text,
        "audio_base64": base64.b64encode(pcm).decode("ascii"),
        "audio_encoding": "pcm_s16le",
        "sample_rate": sample_rate,
    }
