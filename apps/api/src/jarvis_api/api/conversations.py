from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from jarvis_api.auth import current_user
from jarvis_api.domain import ChatRequest, ConversationCreate, ConversationPatch

router = APIRouter(prefix="/v1", tags=["conversations"])


@router.get("/conversations")
async def list_conversations(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    return await request.app.state.store.list_entities("conversation", user["id"])


@router.post("/conversations", status_code=201)
async def create_conversation(
    body: ConversationCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.store.create_entity(
        "conversation",
        user["id"],
        {"title": body.title, "project_id": body.project_id, "message_count": 0},
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
    updated = await request.app.state.store.update_entity(
        "conversation", conversation_id, user["id"], body.dict(exclude_none=True)
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
            user["id"], body.message, conversation_id=body.conversation_id
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
                )
            except Exception as exc:
                await queue.put(("error", {"detail": str(exc)}))
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                event, data = item
                encoded = json.dumps(data, ensure_ascii=False, default=str)
                yield f"event: {event}\ndata: {encoded}\n\n"
        finally:
            cancel.set()
            if not task.done():
                task.cancel()

    return StreamingResponse(events(), media_type="text/event-stream")
