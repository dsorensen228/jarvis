"""Local account and JWT authentication for a self-hosted Jarvis instance."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import timedelta
from typing import Any, Dict, Optional

import jwt
from fastapi import Depends, HTTPException, Request, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from starlette.concurrency import run_in_threadpool

from jarvis_api.config import Settings
from jarvis_api.domain import TokenPair, utc_now
from jarvis_api.store import SqliteStore

bearer = HTTPBearer(auto_error=False)


def _password_hash(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return "{}:{}".format(
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def _password_matches(password: str, encoded: str) -> bool:
    try:
        salt_text, digest_text = encoded.split(":", 1)
        salt = base64.urlsafe_b64decode(salt_text.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_text.encode("ascii"))
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return hmac.compare_digest(actual, expected)


class AuthService:
    def __init__(self, store: SqliteStore, settings: Settings) -> None:
        self.store = store
        self.settings = settings

    async def bootstrap(self) -> None:
        users = await self.store.list_all_entities("user")
        if users or not self.settings.bootstrap_password:
            return
        await self.create_user(
            self.settings.bootstrap_username,
            self.settings.bootstrap_password,
            "Jarvis owner",
            is_admin=True,
        )

    async def create_user(
        self, username: str, password: str, name: str, is_admin: bool = False
    ) -> Dict[str, Any]:
        normalized = username.strip().lower()
        users = await self.store.list_all_entities("user")
        if any(user.get("username") == normalized for user in users):
            raise ValueError("username already exists")
        return await self.store.create_entity(
            "user",
            "system",
            {
                "username": normalized,
                "name": name.strip() or normalized,
                "password_hash": _password_hash(password),
                "is_admin": is_admin,
                "settings": {},
            },
        )

    async def authenticate(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        normalized = username.strip().lower()
        for user in await self.store.list_all_entities("user"):
            if user.get("username") == normalized and _password_matches(
                password, user.get("password_hash", "")
            ):
                return user
        return None

    async def authenticate_google(self, token: str) -> Optional[Dict[str, Any]]:
        """Verify an allowlisted Google identity and map it to the local owner account."""
        if not self.settings.google_client_id or not self.settings.google_login_subjects:
            raise RuntimeError("Google login is not configured")
        try:
            claims = await run_in_threadpool(
                google_id_token.verify_oauth2_token,
                token,
                google_requests.Request(),
                self.settings.google_client_id,
            )
        except ValueError:
            return None
        except google_auth_exceptions.TransportError as exc:
            raise RuntimeError(
                "Google login temporarily unavailable (could not reach Google certificate servers)"
            ) from exc
        subject = str(claims.get("sub") or "")
        if subject not in self.settings.google_login_subjects:
            return None
        if claims.get("email_verified") is not True:
            return None
        normalized_owner = self.settings.bootstrap_username.strip().lower()
        for user in await self.store.list_all_entities("user"):
            if user.get("username") == normalized_owner:
                return user
        return None

    async def issue_tokens(self, user: Dict[str, Any]) -> TokenPair:
        now = utc_now()
        expires = now + timedelta(minutes=self.settings.access_token_minutes)
        access = jwt.encode(
            {
                "sub": user["id"],
                "username": user["username"],
                "admin": bool(user.get("is_admin")),
                "iat": int(now.timestamp()),
                "exp": int(expires.timestamp()),
                "iss": "jarvis",
            },
            self.settings.jwt_secret,
            algorithm="HS256",
        )
        refresh = secrets.token_urlsafe(48)
        refresh_hash = hashlib.sha256(refresh.encode("utf-8")).hexdigest()
        refresh_expiry = now + timedelta(days=self.settings.refresh_token_days)
        await self.store.put_secret(
            "refresh",
            refresh_hash,
            user["id"],
            json.dumps({"username": user["username"]}),
            refresh_expiry.isoformat(),
        )
        return TokenPair(
            access_token=access,
            refresh_token=refresh,
            expires_in=self.settings.access_token_minutes * 60,
        )

    async def refresh(self, refresh_token: str) -> Optional[TokenPair]:
        token_hash = hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()
        record = await self.store.get_secret("refresh", token_hash)
        if record is None:
            return None
        if record.get("expires_at") and record["expires_at"] <= utc_now().isoformat():
            await self.store.delete_secret("refresh", token_hash)
            return None
        await self.store.delete_secret("refresh", token_hash)
        user = await self.store.get_entity("user", record["owner_id"])
        return await self.issue_tokens(user) if user else None

    async def revoke_refresh(self, refresh_token: str) -> None:
        token_hash = hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()
        await self.store.delete_secret("refresh", token_hash)

    def decode_access_token(self, token: str) -> Dict[str, Any]:
        try:
            return jwt.decode(
                token,
                self.settings.jwt_secret,
                algorithms=["HS256"],
                issuer="jarvis",
            )
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token"
            ) from exc


def get_auth(request: Request) -> AuthService:
    return request.app.state.auth


async def current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> Dict[str, Any]:
    if credentials is None:
        raise HTTPException(status_code=401, detail="bearer token required")
    auth: AuthService = request.app.state.auth
    claims = auth.decode_access_token(credentials.credentials)
    user = await request.app.state.store.get_entity("user", claims["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="user no longer exists")
    return user


async def websocket_user(websocket: WebSocket, token: Optional[str] = None) -> Dict[str, Any]:
    token = token or websocket.query_params.get("token")
    if not token:
        authorization = websocket.headers.get("authorization", "")
        if authorization.lower().startswith("bearer "):
            token = authorization[7:]
    if not token:
        raise HTTPException(status_code=401, detail="bearer token required")
    claims = websocket.app.state.auth.decode_access_token(token)
    user = await websocket.app.state.store.get_entity("user", claims["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="user no longer exists")
    return user


def public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    result = {
        "id": user["id"],
        "username": user["username"],
        "name": user.get("name", ""),
        "is_admin": bool(user.get("is_admin")),
        "settings": user.get("settings", {}),
        "created_at": user["created_at"],
        "updated_at": user["updated_at"],
    }
    if user.get("avatar_path"):
        result["avatar_url"] = "/v1/users/{}/avatar".format(user["id"])
    return result
