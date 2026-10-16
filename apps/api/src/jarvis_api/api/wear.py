from __future__ import annotations

import asyncio
import base64
import json
from contextlib import suppress
from typing import Any, AsyncIterator, Dict

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from jarvis_api.auth import current_user
from jarvis_api.domain import WearChatRequest
from jarvis_api.speech import SpeechUnavailable

router = APIRouter(prefix="/v1/wear", tags=["wearable"])


@router.post(
    "/chat",
    response_model=Dict[str, Any],
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def wearable_chat(
    body: WearChatRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    """One low-round-trip turn for constrained Wear OS clients.

    The watch performs speech recognition locally, while the API owns the agent
    turn and Kokoro synthesis. Accept: text/event-stream delivers text before
    synthesis completes. Audio is raw mono signed 16-bit little-endian PCM.
    """
    accepted = request.headers.get("accept", "").lower().split(",")
    if any(value.split(";", 1)[0].strip() == "text/event-stream" for value in accepted):
        return _stream_chat(body, request, user)

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


def _stream_chat(
    body: WearChatRequest, request: Request, user: Dict[str, Any]
) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue()
        cancel = asyncio.Event()

        async def emit(event: str, data: Dict[str, Any]) -> None:
            if event == "response.text.delta":
                await queue.put((event, data))

        async def run() -> None:
            try:
                result = await request.app.state.agent.run(
                    user["id"],
                    body.message,
                    conversation_id=body.conversation_id,
                    emit=emit,
                    cancel_event=cancel,
                )
                await queue.put(
                    (
                        "response.completed",
                        {"conversation_id": result.conversation_id, "response": result.text},
                    )
                )
                pcm, sample_rate = await request.app.state.speech.synthesize_pcm16(result.text)
                await queue.put(
                    (
                        "response.audio",
                        {
                            "audio_base64": base64.b64encode(pcm).decode("ascii"),
                            "audio_encoding": "pcm_s16le",
                            "sample_rate": sample_rate,
                        },
                    )
                )
            except Exception as exc:
                await queue.put(("error", {"message": str(exc)}))
            finally:
                await queue.put(("turn.done", {}))
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if item is None:
                    break
                event, data = item
                encoded = json.dumps(data, ensure_ascii=False, default=str)
                yield f"event: {event}\ndata: {encoded}\n\n"
        finally:
            cancel.set()
            # Shield upstream cleanup from Starlette's HTTP-disconnect cancellation.
            with anyio.CancelScope(shield=True):
                if not task.done():
                    task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
