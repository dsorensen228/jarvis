from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from jarvis_api.auth import websocket_user
from jarvis_api.voice import voice_websocket

router = APIRouter(prefix="/v1", tags=["realtime"])


@router.websocket("/events")
async def events(websocket: WebSocket) -> None:
    try:
        user = await websocket_user(websocket)
    except HTTPException:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    connection_id = await websocket.app.state.events.connect(user["id"], websocket)
    try:
        await websocket.send_json({"type": "session.ready", "data": {}})
        while True:
            event: Dict[str, Any] = await websocket.receive_json()
            if event.get("type") == "ping":
                await websocket.send_json({"type": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        await websocket.app.state.events.disconnect(user["id"], connection_id)


@router.websocket("/voice")
async def voice(websocket: WebSocket) -> None:
    await voice_websocket(websocket)
