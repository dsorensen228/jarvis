from __future__ import annotations

import asyncio
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from jarvis_api.auth import current_user
from jarvis_api.banter import BanterUnavailable, ScriptRequest, ScriptResponse
from jarvis_api.banter_triggers import BanterStatus, PollResponse, RobotPoll

router = APIRouter(prefix="/v1/banter", tags=["banter"])


@router.post("/poll", response_model=PollResponse)
async def poll_trigger(
    body: RobotPoll, request: Request, user: Dict[str, Any] = Depends(current_user)
) -> PollResponse:
    try:
        return request.app.state.banter.poll(user["id"], body)
    except BanterUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/devices/{response_device_id}", response_model=BanterStatus)
async def demo_status(
    response_device_id: str, request: Request, user: Dict[str, Any] = Depends(current_user)
) -> BanterStatus:
    return request.app.state.banter.triggers.status(user["id"], response_device_id)


@router.post("/devices/{response_device_id}/trigger", response_model=BanterStatus)
async def trigger_demo(
    response_device_id: str, request: Request, user: Dict[str, Any] = Depends(current_user)
) -> BanterStatus:
    service = request.app.state.banter
    try:
        if not service.triggers.status(user["id"], response_device_id).available:
            raise BanterUnavailable("Sherman is offline, busy, or not idle")
        await service.voices.scripted_speech_ready(user["id"], response_device_id)
        return service.triggers.queue(user["id"], response_device_id)
    except (RuntimeError, asyncio.TimeoutError) as exc:
        raise HTTPException(
            status_code=409, detail=str(exc) or "response speaker timed out"
        ) from exc


@router.post("/scripts", response_model=ScriptResponse)
async def create_script(
    body: ScriptRequest, request: Request, user: Dict[str, Any] = Depends(current_user)
) -> ScriptResponse:
    try:
        return await request.app.state.banter.create(user["id"], body)
    except BanterUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/scripts/{script_id}/replies/{exchange_index}")
async def play_reply(
    script_id: str,
    exchange_index: int,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    try:
        return await request.app.state.banter.reply(user["id"], script_id, exchange_index)
    except BanterUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
