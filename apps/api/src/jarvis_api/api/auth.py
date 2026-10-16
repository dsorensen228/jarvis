from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse

from jarvis_api.auth import current_user, public_user
from jarvis_api.domain import (
    GoogleTokenRequest,
    PushTokenDelete,
    PushTokenRequest,
    RefreshRequest,
    TokenPair,
    TokenRequest,
    UserCreate,
    UserPatch,
)

router = APIRouter(prefix="/v1", tags=["identity"])


@router.post("/auth/token", response_model=TokenPair)
async def token(body: TokenRequest, request: Request) -> TokenPair:
    user = await request.app.state.auth.authenticate(body.username, body.password)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid username or password")
    return await request.app.state.auth.issue_tokens(user)


@router.post("/auth/google", response_model=TokenPair)
async def google_token(body: GoogleTokenRequest, request: Request) -> TokenPair:
    try:
        user = await request.app.state.auth.authenticate_google(body.google_id_token)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if user is None:
        raise HTTPException(status_code=401, detail="Google account is not authorized")
    return await request.app.state.auth.issue_tokens(user)


@router.post("/auth/refresh", response_model=TokenPair)
async def refresh(body: RefreshRequest, request: Request) -> TokenPair:
    pair = await request.app.state.auth.refresh(body.refresh_token)
    if pair is None:
        raise HTTPException(status_code=401, detail="invalid or expired refresh token")
    return pair


@router.post("/auth/logout", status_code=204, response_class=Response)
async def logout(body: RefreshRequest, request: Request) -> Response:
    await request.app.state.auth.revoke_refresh(body.refresh_token)
    return Response(status_code=204)


@router.post("/users", status_code=201)
async def create_user(
    body: UserCreate,
    request: Request,
    actor: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    if not actor.get("is_admin") and not request.app.state.settings.allow_registration:
        raise HTTPException(status_code=403, detail="registration is disabled")
    try:
        user = await request.app.state.auth.create_user(body.username, body.password, body.name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return public_user(user)


@router.get("/users")
async def list_users(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    del user
    return [public_user(row) for row in await request.app.state.store.list_all_entities("user")]


@router.get("/users/me")
async def me(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    return public_user(user)


@router.patch("/users/me")
async def patch_me(
    body: UserPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    patch = body.dict(exclude_none=True)
    if "settings" in patch:
        patch["settings"] = {**user.get("settings", {}), **patch["settings"]}
    updated = await request.app.state.store.update_entity("user", user["id"], "system", patch)
    if updated is None:
        raise HTTPException(status_code=404, detail="user not found")
    return public_user(updated)


@router.post("/users/me/avatar")
async def upload_avatar(
    request: Request,
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, str]:
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=415, detail="avatar must be an image")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
        suffix = ".jpg"
    relative = Path("avatars") / (user["id"] + suffix)
    destination = request.app.state.settings.asset_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="avatar exceeds 5 MiB")
    destination.write_bytes(content)
    updated = await request.app.state.store.update_entity(
        "user", user["id"], "system", {"avatar_path": str(relative)}
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="user not found")
    return {"avatar_url": "/v1/users/{}/avatar".format(user["id"])}


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: str, request: Request) -> FileResponse:
    user = await request.app.state.store.get_entity("user", user_id)
    if user is None or not user.get("avatar_path"):
        raise HTTPException(status_code=404, detail="avatar not found")
    path = (request.app.state.settings.asset_dir / user["avatar_path"]).resolve()
    if request.app.state.settings.asset_dir not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="avatar not found")
    return FileResponse(path)


@router.post("/users/me/push-tokens")
async def register_push_token(
    body: PushTokenRequest,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, str]:
    key = hashlib.sha256(
        "{}:{}:{}".format(body.provider, body.device_id or "", body.token).encode("utf-8")
    ).hexdigest()
    existing = await request.app.state.store.get_entity("push_token", key, user["id"])
    data = body.dict()
    if existing is None:
        await request.app.state.store.create_entity("push_token", user["id"], data, entity_id=key)
    else:
        await request.app.state.store.update_entity("push_token", key, user["id"], data)
    return {"status": "ok"}


@router.delete("/users/me/push-tokens")
async def unregister_push_token(
    body: PushTokenDelete,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Dict[str, Any]:
    rows = await request.app.state.store.list_entities("push_token", user["id"], limit=1000)
    matching = [
        row
        for row in rows
        if row.get("provider") == body.provider
        and (body.token is None or row.get("token") == body.token)
        and (body.device_id is None or row.get("device_id") == body.device_id)
    ]
    for row in matching:
        await request.app.state.store.delete_entity("push_token", row["id"], user["id"])
    return {"status": "ok", "deactivated": len(matching)}
