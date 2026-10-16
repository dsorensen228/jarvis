"""Authenticated HTTP access to the Jarvis API."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx


class JarvisApiClient:
    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
        self._token = ""
        self._token_expires_at = 0.0
        self._login_lock = asyncio.Lock()

    @property
    def voice_websocket_url(self) -> str:
        parsed = urlsplit(self.base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        base_path = parsed.path.rstrip("/")
        return urlunsplit((scheme, parsed.netloc, f"{base_path}/v1/voice", "", ""))

    async def access_token(self, *, force: bool = False) -> str:
        if not force and self._token and time.monotonic() < self._token_expires_at:
            return self._token
        async with self._login_lock:
            if not force and self._token and time.monotonic() < self._token_expires_at:
                return self._token
            response = await self._http.post(
                "/v1/auth/token",
                json={"username": self.username, "password": self.password},
            )
            response.raise_for_status()
            payload = response.json()
            self._token = str(payload["access_token"])
            expires_in = max(60, int(payload.get("expires_in", 900)))
            self._token_expires_at = time.monotonic() + max(30, expires_in - 60)
            return self._token

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        token = await self.access_token()
        request_headers = dict(headers or {})
        request_headers["Authorization"] = f"Bearer {token}"
        response = await self._http.request(
            method,
            path,
            params=params,
            json=json,
            content=content,
            headers=request_headers,
            timeout=30.0 if timeout is None else timeout,
        )
        if response.status_code == 401:
            token = await self.access_token(force=True)
            request_headers["Authorization"] = f"Bearer {token}"
            response = await self._http.request(
                method,
                path,
                params=params,
                json=json,
                content=content,
                headers=request_headers,
                timeout=30.0 if timeout is None else timeout,
            )
        response.raise_for_status()
        return response

    async def json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        response = await self.request(method, path, params=params, json=body)
        return response.json()

    async def close(self) -> None:
        await self._http.aclose()
