"""Personal integrations. Smart home lives in :mod:`jarvis_api.api.smart_home`."""

from __future__ import annotations

import hashlib
from typing import Any, Dict

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse

from jarvis_api.auth import current_user
from jarvis_api.integrations.gmail import GmailNotConfigured, GmailNotConnected

router = APIRouter(prefix="/v1", tags=["integrations"])


@router.get("/integrations")
async def statuses(
    request: Request, user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, Any]:
    return await request.app.state.integrations.statuses(user["id"])


@router.post("/integrations/gmail/connect")
async def connect_gmail(
    request: Request, user: Dict[str, Any] = Depends(current_user)
) -> Dict[str, str]:
    try:
        url = await request.app.state.integrations.gmail.authorization_url(user["id"])
    except GmailNotConfigured as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"authorization_url": url}


@router.get("/integrations/gmail/callback")
async def gmail_callback(state: str, code: str, request: Request) -> Response:
    try:
        await request.app.state.integrations.gmail.exchange_code(state, code)
    except (httpx.HTTPError, ValueError, GmailNotConfigured) as exc:
        detail = "token_exchange_failed" if isinstance(exc, httpx.HTTPError) else "invalid_state"
        return RedirectResponse(
            f"{request.app.state.settings.web_app_url}/gmail-oauth-complete?error={detail}",
            status_code=303,
        )
    return RedirectResponse(
        f"{request.app.state.settings.web_app_url}/gmail-oauth-complete?status=connected",
        status_code=303,
    )


@router.delete("/integrations/gmail", status_code=204, response_class=Response)
async def disconnect_gmail(
    request: Request, user: Dict[str, Any] = Depends(current_user)
) -> Response:
    await request.app.state.integrations.gmail.disconnect(user["id"])
    return Response(status_code=204)


@router.get("/integrations/gmail/messages")
async def search_gmail(
    request: Request,
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(10, ge=1, le=25),
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        return await request.app.state.integrations.gmail.search(user["id"], q, limit)
    except (httpx.HTTPError, GmailNotConfigured, GmailNotConnected) as exc:
        raise _integration_error(exc) from exc


@router.get("/integrations/gmail/messages/{message_id}")
async def read_gmail(
    message_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        return await request.app.state.integrations.gmail.read(user["id"], message_id)
    except (httpx.HTTPError, GmailNotConfigured, GmailNotConnected) as exc:
        raise _integration_error(exc) from exc


@router.get("/integrations/gmail/alerts")
async def gmail_alerts(
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    try:
        messages = await request.app.state.integrations.gmail.search(user["id"], "is:unread", 20)
    except (httpx.HTTPError, GmailNotConfigured, GmailNotConnected) as exc:
        raise _integration_error(exc) from exc
    dismissed = {
        row.get("message_id")
        for row in await request.app.state.store.list_entities(
            "gmail_alert_dismissal", user["id"], limit=1000
        )
    }
    return [message for message in messages if message.get("id") not in dismissed]


@router.delete("/integrations/gmail/alerts/{message_id}", status_code=204)
async def dismiss_gmail_alert(
    message_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    entity_id = hashlib.sha256(message_id.encode("utf-8")).hexdigest()
    if (
        await request.app.state.store.get_entity("gmail_alert_dismissal", entity_id, user["id"])
        is None
    ):
        await request.app.state.store.create_entity(
            "gmail_alert_dismissal",
            user["id"],
            {"message_id": message_id},
            entity_id=entity_id,
        )
    return Response(status_code=204)


def _integration_error(exc: Exception) -> HTTPException:
    if isinstance(exc, GmailNotConfigured):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, GmailNotConnected):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, httpx.HTTPError):
        return HTTPException(status_code=502, detail=f"integration request failed: {exc}")
    return HTTPException(status_code=400, detail=str(exc))
