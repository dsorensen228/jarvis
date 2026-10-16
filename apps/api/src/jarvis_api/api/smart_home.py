"""One provider-neutral smart-home API: platform, devices, rooms, and control."""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from jarvis_api.auth import current_user
from jarvis_api.domain import (
    LightControlRequest,
    RoomCreate,
    RoomPatch,
    SmartDevicePatch,
    SmartHomeCommand,
)
from jarvis_api.smarthome.model import SmartHomeError, SmartHomeUnavailable

router = APIRouter(prefix="/v1", tags=["smart-home"])


def _service(request: Request) -> Any:
    return request.app.state.smart_home


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, SmartHomeUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, SmartHomeError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/smart-home")
async def smart_home_status(
    request: Request, user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, Any]:
    """Platform health. Never exposes the Home Assistant token."""
    return await _service(request).status(user["id"])


@router.post("/smart-home/sync")
async def sync_smart_home(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    """Import or refresh every device Home Assistant provides."""
    try:
        return await _service(request).sync(user["id"])
    except SmartHomeError as exc:
        raise _error(exc) from exc


@router.get("/smart-devices")
async def list_smart_devices(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    return await _service(request).list_devices(user["id"])


@router.post("/smart-devices/control")
async def control_lights(
    body: LightControlRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        return await _service(request).control_lights(
            user["id"], body.scope, body.selector, body.action, body.parameters
        )
    except SmartHomeError as exc:
        raise _error(exc) from exc


@router.patch("/smart-devices/{device_id}")
async def patch_smart_device(
    device_id: str,
    body: SmartDevicePatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    patch = body.dict(exclude_none=True)
    if not patch:
        raise HTTPException(status_code=400, detail="no changes supplied")
    if "is_light" in patch:
        patch["light_scope_version"] = 1
    updated = await request.app.state.store.update_entity(
        "smart_device", device_id, user["id"], patch
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="smart device not found")
    return await _service(request).device_state(user["id"], device_id)


@router.delete("/smart-devices/{device_id}", status_code=204, response_class=Response)
async def delete_smart_device(
    device_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    deleted = await request.app.state.store.delete_entity("smart_device", device_id, user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="smart device not found")
    return Response(status_code=204)


@router.post("/smart-devices/{device_id}/commands")
async def command_smart_device(
    device_id: str,
    body: SmartHomeCommand,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    parameters = dict(body.parameters)
    if body.component:
        parameters["component"] = body.component
    try:
        return await _service(request).control_device(
            user["id"], device_id, body.action, parameters
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="smart device not found") from exc
    except SmartHomeError as exc:
        raise _error(exc) from exc


@router.get("/smart-devices/{device_id}/state")
async def smart_device_state(
    device_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        return await _service(request).device_state(user["id"], device_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="smart device not found") from exc
    except SmartHomeError as exc:
        raise _error(exc) from exc


@router.get("/rooms")
async def list_rooms(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    explicit = await request.app.state.store.list_entities("room", user["id"], limit=1000)
    devices = await request.app.state.store.list_entities("smart_device", user["id"], limit=1000)
    names = {str(room.get("name", "")).strip() for room in explicit}
    names.update(str(device.get("room", "")).strip() for device in devices)
    names.discard("")
    return [
        {
            "id": name,
            "name": name,
            "device_count": sum(1 for device in devices if device.get("room") == name),
        }
        for name in sorted(names, key=str.lower)
    ]


@router.post("/rooms", status_code=201)
async def create_room(
    body: RoomCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    name = body.name.strip()
    entity_id = _room_id(name)
    existing = await request.app.state.store.get_entity("room", entity_id, user["id"])
    if existing is None:
        await request.app.state.store.create_entity(
            "room", user["id"], {"name": name}, entity_id=entity_id
        )
    return {"id": name, "name": name, "device_count": 0}


@router.patch("/rooms/{room_name}")
async def rename_room(
    room_name: str,
    body: RoomPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    new_name = body.name.strip()
    devices = await request.app.state.store.list_entities("smart_device", user["id"], limit=1000)
    changed = 0
    for device in devices:
        if device.get("room") == room_name:
            await request.app.state.store.update_entity(
                "smart_device", device["id"], user["id"], {"room": new_name}
            )
            changed += 1
    await request.app.state.store.delete_entity("room", _room_id(room_name), user["id"])
    new_id = _room_id(new_name)
    if await request.app.state.store.get_entity("room", new_id, user["id"]) is None:
        await request.app.state.store.create_entity(
            "room", user["id"], {"name": new_name}, entity_id=new_id
        )
    return {"id": new_name, "name": new_name, "device_count": changed}


@router.delete("/rooms/{room_name}", status_code=204, response_class=Response)
async def delete_room(
    room_name: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    devices = await request.app.state.store.list_entities("smart_device", user["id"], limit=1000)
    for device in devices:
        if device.get("room") == room_name:
            await request.app.state.store.update_entity(
                "smart_device", device["id"], user["id"], {"room": ""}
            )
    await request.app.state.store.delete_entity("room", _room_id(room_name), user["id"])
    return Response(status_code=204)


@router.get("/rooms/{room_name}/lights")
async def room_lights(
    room_name: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    """Aggregate light power for a room, for the touchscreen and phone toggles."""
    try:
        return await _service(request).room_lights_power(user["id"], room_name)
    except SmartHomeError as exc:
        raise _error(exc) from exc


@router.get("/rooms/{room_name}/display")
async def room_display(
    room_name: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Optional[Dict[str, Any]]:
    """The display a room's media requests belong to, resolved once server-side."""
    try:
        return await _service(request).resolve_room_display(user["id"], room_name)
    except SmartHomeError as exc:
        raise _error(exc) from exc


def _room_id(name: str) -> str:
    return hashlib.sha256(name.strip().lower().encode("utf-8")).hexdigest()
