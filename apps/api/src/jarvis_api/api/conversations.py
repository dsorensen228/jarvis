from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Any, AsyncIterator, Dict, Literal, Optional

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from jarvis_api.auth import current_user
from jarvis_api.domain import ChatRequest, ConversationCreate, ConversationPatch

router = APIRouter(prefix="/v1", tags=["conversations"])


@router.get("/conversations")
async def list_conversations(
    request: Request,
    limit: int = Query(200, ge=1, le=1000),
    exclude_source: Optional[Literal["voice"]] = None,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.store.list_entities(
        "conversation", user["id"], limit=limit, exclude_source=exclude_source
    )


@router.delete("/conversations")
async def clear_conversations(
    request: Request,
    exclude_source: Optional[Literal["voice"]] = None,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, int]:
    deleted = await request.app.state.store.delete_all_conversations(
        user["id"], exclude_source=exclude_source
    )
    return {"deleted": deleted}


@router.post("/conversations", status_code=201)
async def create_conversation(
    body: ConversationCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.store.create_entity(
        "conversation",
        user["id"],
        {"title": body.title, "project_id": body.project_id, "message_count": 0, "source": "chat"},
    )


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    conversation = await request.app.state.store.get_entity(
        "conversation", conversation_id, user["id"]
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    conversation["messages"] = await request.app.state.store.list_messages(
        user["id"], conversation_id, limit=500
    )
    return conversation


@router.patch("/conversations/{conversation_id}")
async def patch_conversation(
    conversation_id: str,
    body: ConversationPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    changes = body.dict(exclude_unset=True)
    if changes.get("title") is None:
        changes.pop("title", None)
    updated = await request.app.state.store.mutate_entity(
        "conversation", conversation_id, user["id"], lambda current: {**current, **changes}
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return updated


@router.delete("/conversations/{conversation_id}", status_code=204, response_class=Response)
async def delete_conversation(
    conversation_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    deleted = await request.app.state.store.delete_entity(
        "conversation", conversation_id, user["id"]
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="conversation not found")
    await request.app.state.store.delete_messages(user["id"], conversation_id)
    return Response(status_code=204)


@router.post("/chat")
async def chat(
    body: ChatRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        result = await request.app.state.agent.run(
            user["id"],
            body.message,
            conversation_id=body.conversation_id,
            attachments=body.attachments,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "conversation_id": result.conversation_id,
        "response": result.text,
        "message": result.message,
    }


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue()
        cancel = asyncio.Event()

        async def emit(event: str, data: Dict[str, Any]) -> None:
            await queue.put((event, data))

        async def run() -> None:
            try:
                await request.app.state.agent.run(
                    user["id"],
                    body.message,
                    conversation_id=body.conversation_id,
                    emit=emit,
                    cancel_event=cancel,
                    attachments=body.attachments,
                )
            except Exception as exc:
                await queue.put(("error", {"detail": str(exc)}))
            finally:
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
            # Starlette cancels the surrounding scope on HTTP disconnect. Wait
            # outside that cancellation so upstream sockets and durable writes
            # can finish closing after the agent's single explicit cancellation.
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
