from __future__ import annotations

import asyncio
import hashlib
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional

import httpx
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import StreamingResponse

from jarvis_api.auth import current_user
from jarvis_api.domain import DeviceCreate, DevicePatch, DeviceRegistration, utc_now
from jarvis_api.push import PERSON_DETECTED_PUSH_TYPE, notify_person_detected

router = APIRouter(prefix="/v1/devices", tags=["devices"])
DEFAULT_PERSON_DETECTED_ALERT = "Someone's at the door."


async def _device_response(
    request: Request, owner_id: str, device: Dict[str, Any]
) -> Dict[str, Any]:
    credential = await request.app.state.store.get_secret("device_callback", device["id"])
    return {
        **device,
        "user_id": owner_id,
        "callback_configured": bool(credential and credential["owner_id"] == owner_id),
    }


@router.get("")
async def list_devices(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    devices = await request.app.state.store.list_entities("device", user["id"])
    return [await _device_response(request, user["id"], device) for device in devices]


@router.post("", status_code=201)
async def create_device(
    body: DeviceCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    encrypted = (
        request.app.state.vault.encrypt({"token": body.callback_token})
        if body.callback_token is not None
        else None
    )
    created = await request.app.state.store.save_device(
        user["id"], body.dict(exclude={"callback_token"}), encrypted_callback_token=encrypted
    )
    return await _device_response(request, user["id"], created)


@router.patch("/{device_id}")
async def patch_device(
    device_id: str,
    body: DevicePatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    changes = {
        key: value
        for key, value in body.dict(exclude_unset=True, exclude={"callback_token"}).items()
        if value is not None or key == "base_url"
    }
    encrypted = (
        request.app.state.vault.encrypt({"token": body.callback_token})
        if body.callback_token is not None
        else None
    )
    updated = await request.app.state.store.save_device(
        user["id"], changes, device_id=device_id, encrypted_callback_token=encrypted
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="device not found")
    return await _device_response(request, user["id"], updated)


@router.delete("/{device_id}", status_code=204, response_class=Response)
async def delete_device(
    device_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    if not await request.app.state.store.delete_entity("device", device_id, user["id"]):
        raise HTTPException(status_code=404, detail="device not found")
    return Response(status_code=204)


@router.post("/{device_id}/commands")
async def command_device(
    device_id: str,
    body: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    device = await _device(request, user["id"], device_id)
    if not device.get("base_url"):
        raise HTTPException(status_code=409, detail="device has no callback URL")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                device["base_url"].rstrip("/") + "/v1/commands",
                json=body,
                headers=await _callback_headers(request, user["id"], device_id),
            )
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"device callback failed: {exc}") from exc


@router.get("/{device_id}/camera/snapshot")
async def camera_snapshot(
    device_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    device = await _device(request, user["id"], device_id)
    if device.get("kind") != "camera" or not device.get("base_url"):
        raise HTTPException(status_code=409, detail="device is not a configured camera")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                device["base_url"].rstrip("/") + "/v1/camera/snapshot",
                headers=await _callback_headers(request, user["id"], device_id),
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"camera callback failed: {exc}") from exc
    return Response(response.content, media_type=response.headers.get("content-type", "image/jpeg"))


@router.put("/{device_id}/registration")
async def register_callback(
    device_id: str,
    body: DeviceRegistration,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, str]:
    device = await request.app.state.store.get_entity("device", device_id, user["id"])
    if device is None and (body.name is None or body.base_url is None):
        raise HTTPException(
            status_code=404,
            detail="device not found; name and base_url are required for first registration",
        )
    data = body.dict(exclude_none=True, exclude={"callback_token"})
    data["metadata"] = {**(body.metadata or {}), "last_seen_at": utc_now().isoformat()}
    if device is None:
        data.setdefault("room", "")
    saved = await request.app.state.store.save_device(
        user["id"],
        data,
        device_id=device_id,
        create=True,
        reported=True,
        encrypted_callback_token=request.app.state.vault.encrypt({"token": body.callback_token}),
    )
    if saved is None:
        raise HTTPException(status_code=404, detail="device not found")
    return {"status": "registered"}


@router.post("/{device_id}/heartbeat")
async def heartbeat(
    device_id: str,
    body: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    await _device(request, user["id"], device_id)
    updated = await request.app.state.store.save_device(
        user["id"],
        {"metadata": {"last_heartbeat_at": utc_now().isoformat(), "health": body}},
        device_id=device_id,
        reported=True,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="device not found")
    return {"status": "ok", "device": updated}


@router.post("/{device_id}/camera/stream-session")
async def create_camera_stream_session(
    device_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    device = await _device(request, user["id"], device_id)
    if device.get("kind") != "camera" or not device.get("base_url"):
        raise HTTPException(status_code=409, detail="device is not a configured camera")
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expires_in = 900
    expires_at = (utc_now() + timedelta(seconds=expires_in)).isoformat()
    await request.app.state.vault.put(
        "camera_stream_session",
        token_hash,
        user["id"],
        {"device_id": device_id, "expires_at": expires_at},
        expires_at=expires_at,
    )
    return {
        "stream_path": f"/v1/devices/{device_id}/camera/stream",
        "snapshot_path": f"/v1/devices/{device_id}/camera/snapshot",
        "camera_token": token,
        "expires_in": expires_in,
    }


@router.get("/{device_id}/camera/stream")
async def camera_stream(
    device_id: str,
    request: Request,
    camera_token: str = Query(..., min_length=20, max_length=500),
) -> StreamingResponse:
    owner_id = await _stream_session_owner(request, device_id, camera_token)
    device = await _device(request, owner_id, device_id)
    if device.get("kind") != "camera" or not device.get("base_url"):
        raise HTTPException(status_code=409, detail="device is not a configured camera")
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None))
    try:
        upstream = await client.send(
            client.build_request(
                "GET",
                device["base_url"].rstrip("/") + "/v1/camera/stream",
                headers=await _callback_headers(request, owner_id, device_id),
            ),
            stream=True,
        )
        upstream.raise_for_status()
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"camera callback failed: {exc}") from exc

    async def chunks() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        chunks(),
        media_type=upstream.headers.get(
            "content-type", "multipart/x-mixed-replace; boundary=frame"
        ),
    )


@router.post("/{device_id}/camera/events", status_code=201)
async def camera_event(
    device_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    event_id: str = Form(..., min_length=1, max_length=200),
    event_type: str = Form("doorbell", min_length=1, max_length=100),
    captured_at: str = Form(""),
    confidence: Optional[float] = Form(None),
    frame: Optional[UploadFile] = File(None),
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    device = await _device(request, user["id"], device_id)
    if device.get("kind") != "camera":
        raise HTTPException(status_code=409, detail="device is not a camera")
    storage_id = hashlib.sha256(f"{device_id}:{event_id}".encode()).hexdigest()
    existing = await request.app.state.store.get_entity("camera_event", storage_id, user["id"])
    if existing is not None:
        return existing
    frame_path = None
    if frame is not None:
        if frame.content_type != "image/jpeg":
            raise HTTPException(status_code=415, detail="camera event frame must be image/jpeg")
        content = await frame.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="camera event frame exceeds 10 MiB")
        if (
            len(content) < 4
            or not content.startswith(b"\xff\xd8")
            or not content.endswith(b"\xff\xd9")
        ):
            raise HTTPException(status_code=422, detail="camera event frame is not a valid JPEG")
        relative = Path("camera-events") / user["id"] / (storage_id + ".jpg")
        destination = request.app.state.settings.asset_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        frame_path = str(relative)
    created = await request.app.state.store.create_entity(
        "camera_event",
        user["id"],
        {
            "event_id": event_id,
            "device_id": device_id,
            "event_type": event_type,
            "captured_at": captured_at or utc_now().isoformat(),
            "confidence": confidence,
            "frame_path": frame_path,
        },
        entity_id=storage_id,
    )
    if event_type == "person_detected":
        background_tasks.add_task(
            _alert_person_detection,
            request.app,
            user["id"],
            device_id,
            storage_id,
            _person_alert_text(device),
        )
    return created


def _person_alert_text(camera: Dict[str, Any]) -> str:
    configured = str((camera.get("metadata") or {}).get("person_alert_text") or "").strip()
    if configured:
        return configured[:300]
    room = str(camera.get("room") or "").strip().lower()
    return f"Someone's at the {room}." if room else DEFAULT_PERSON_DETECTED_ALERT


async def _alert_person_detection(
    app: Any, user_id: str, device_id: str, event_id: str, alert_text: str
) -> None:
    await asyncio.gather(
        _announce_person_detection(app, user_id, event_id, alert_text, camera_device_id=device_id),
        _push_person_detection(app, user_id, device_id, event_id, alert_text),
        return_exceptions=True,
    )


async def _announce_person_detection(
    app: Any,
    user_id: str,
    event_id: str,
    alert_text: str,
    *,
    camera_device_id: Optional[str] = None,
) -> None:
    devices = await app.state.store.list_entities("device", user_id, limit=1000)
    eligible_ids = {
        str(device["id"])
        for device in devices
        if device.get("kind") == "voice"
        and bool((device.get("metadata") or {}).get("doorbell_alerts_enabled"))
    }
    try:
        announced_to = await app.state.voice_connections.announce(
            user_id, eligible_ids, alert_text, camera_device_id=camera_device_id
        )
        announcement = {
            "status": "sent" if announced_to else "no_connected_targets",
            "text": alert_text,
            "device_ids": announced_to,
            "processed_at": utc_now().isoformat(),
        }
    except Exception as exc:
        announcement = {
            "status": "error",
            "detail": str(exc)[:500],
            "processed_at": utc_now().isoformat(),
        }
    await app.state.store.update_entity(
        "camera_event", event_id, user_id, {"announcement": announcement}
    )


async def _push_person_detection(
    app: Any, user_id: str, device_id: str, event_id: str, alert_text: str
) -> None:
    try:
        mobile_push = await notify_person_detected(
            store=app.state.store,
            push_client=app.state.push,
            user_id=user_id,
            device_id=device_id,
            event_id=event_id,
            alert_text=alert_text,
        )
    except Exception as exc:
        mobile_push = {
            "status": "error",
            "detail": str(exc)[:500],
        }
    mobile_push = {
        **mobile_push,
        "type": PERSON_DETECTED_PUSH_TYPE,
        "text": alert_text,
        "processed_at": utc_now().isoformat(),
    }
    await app.state.store.update_entity(
        "camera_event", event_id, user_id, {"mobile_push": mobile_push}
    )


async def _device(request: Request, user_id: str, device_id: str) -> Dict[str, Any]:
    device = await request.app.state.store.get_entity("device", device_id, user_id)
    if device is None:
        raise HTTPException(status_code=404, detail="device not found")
    return device


async def _callback_headers(request: Request, owner_id: str, device_id: str) -> Dict[str, str]:
    credential = await request.app.state.vault.get("device_callback", device_id, owner_id)
    if credential is None or not credential.get("token"):
        return {}
    return {"Authorization": "Bearer {}".format(credential["token"])}


async def _stream_session_owner(request: Request, device_id: str, token: str) -> str:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    session = await request.app.state.vault.get("camera_stream_session", token_hash)
    if session is None or session.get("device_id") != device_id:
        raise HTTPException(status_code=401, detail="invalid camera stream token")
    if session.get("expires_at", "") <= utc_now().isoformat():
        await request.app.state.vault.delete("camera_stream_session", token_hash)
        raise HTTPException(status_code=401, detail="expired camera stream token")
    return str(session["_owner_id"])
