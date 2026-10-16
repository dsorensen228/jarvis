from __future__ import annotations

import asyncio
import socket
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from jarvis_camera.capture import Frame
from jarvis_camera.config import Settings

AddressResolver = Callable[..., list[tuple[Any, ...]]]


def registration_url(
    public_url: str,
    resolver: AddressResolver = socket.getaddrinfo,
) -> str:
    """Resolve mDNS callback names before handing them to a containerized API."""
    parsed = urlsplit(public_url)
    hostname = parsed.hostname or ""
    if not hostname.endswith(".local"):
        return public_url
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = resolver(hostname, port, socket.AF_INET, socket.SOCK_STREAM)
    if not addresses:
        raise RuntimeError(f"could not resolve camera callback host {hostname}")
    address = str(addresses[0][4][0])
    netloc = f"{address}:{parsed.port}" if parsed.port is not None else address
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


class JarvisApi:
    def __init__(
        self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.api_url,
            timeout=httpx.Timeout(30.0, connect=10.0),
            transport=transport,
        )
        self.access_token: str | None = None
        self.refresh_token: str | None = None

    async def close(self) -> None:
        await self.client.aclose()

    async def login(self) -> None:
        response = await self.client.post(
            "/v1/auth/token",
            json={"username": self.settings.username, "password": self.settings.password},
        )
        response.raise_for_status()
        body = response.json()
        self.access_token = str(body["access_token"])
        self.refresh_token = str(body["refresh_token"])

    async def _refresh(self) -> bool:
        if not self.refresh_token:
            return False
        response = await self.client.post(
            "/v1/auth/refresh", json={"refresh_token": self.refresh_token}
        )
        if not response.is_success:
            return False
        body = response.json()
        self.access_token = str(body["access_token"])
        self.refresh_token = str(body["refresh_token"])
        return True

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if not self.access_token:
            await self.login()
        headers = dict(kwargs.pop("headers", {}))
        headers["Authorization"] = f"Bearer {self.access_token}"
        response = await self.client.request(method, path, headers=headers, **kwargs)
        if response.status_code == 401 and await self._refresh():
            headers["Authorization"] = f"Bearer {self.access_token}"
            response = await self.client.request(method, path, headers=headers, **kwargs)
        response.raise_for_status()
        return response

    async def register(self, connected: bool = True, degraded_reason: str | None = None) -> None:
        callback_url = await asyncio.to_thread(registration_url, self.settings.public_url)
        await self.request(
            "PUT",
            f"/v1/devices/{self.settings.device_id}/registration",
            json={
                "callback_token": self.settings.callback_token,
                "name": self.settings.name,
                "kind": "camera",
                "room": self.settings.room,
                "base_url": callback_url,
                "metadata": {
                    "connected": connected,
                    "camera_model": "imx500",
                    "resolution": [self.settings.width, self.settings.height],
                    "person_detection": self.settings.person_detection,
                    "detector_degraded_reason": degraded_reason,
                    "person_alert_text": self.settings.person_alert_text,
                },
            },
        )

    async def heartbeat(self, connected: bool, ready: bool, sequence: int) -> None:
        await self.request(
            "POST",
            f"/v1/devices/{self.settings.device_id}/heartbeat",
            json={"connected": connected, "ready": ready, "frame_sequence": sequence},
        )

    async def post_person_event(self, frame: Frame, confidence: float) -> str:
        event_id = str(uuid.uuid4())
        data = {
            "event_id": event_id,
            "event_type": "person_detected",
            "captured_at": frame.captured_at,
            "confidence": str(confidence),
        }
        files = {"frame": (f"{event_id}.jpg", frame.jpeg, "image/jpeg")}
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                await self.request(
                    "POST",
                    f"/v1/devices/{self.settings.device_id}/camera/events",
                    data=data,
                    files=files,
                )
                return event_id
            except (httpx.HTTPError, RuntimeError) as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(2**attempt)
        raise RuntimeError(f"camera event upload failed: {last_error}")
