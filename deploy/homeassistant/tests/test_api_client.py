"""Unit tests for the Govee OpenAPI HTTP client."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import pytest

from govee_openapi.api import (
    GoveeAuthError,
    GoveeOpenApiClient,
    GoveeRateLimitError,
    _retry_after_seconds,
)
from govee_openapi.const import REQUEST_SPACING_SECONDS


class _FakeResponse:
    def __init__(self, status: int, body: dict[str, Any], headers: dict[str, str] | None = None):
        self.status = status
        self._body = body
        self.headers = headers or {}

    async def json(self, *, content_type=None):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise aiohttp.ClientResponseError(
                request_info=None,
                history=(),
                status=self.status,
                message="error",
                headers=self.headers,
            )


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]):
        self._responses = responses
        self._index = 0
        self.requests: list[tuple[str, str]] = []

    async def request(self, method: str, url: str, **kwargs):
        self.requests.append((method, url))
        response = self._responses[min(self._index, len(self._responses) - 1)]
        self._index += 1
        return response


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("30", 30.0),
        ("", None),
        ("not-a-number", None),
    ],
)
def test_retry_after_seconds(header: str, expected: float | None) -> None:
    assert _retry_after_seconds(header) == expected


@pytest.mark.asyncio
async def test_429_sets_cooldown_and_raises() -> None:
    session = _FakeSession(
        [
            _FakeResponse(429, {}, headers={"Retry-After": "0"}),
            _FakeResponse(
                200,
                {"code": 200, "payload": {"devices": []}},
            ),
        ]
    )
    client = GoveeOpenApiClient(session, "key")
    with pytest.raises(GoveeRateLimitError):
        await client.async_devices()

    # Second call should wait for cooldown before hitting the network again.
    await client.async_devices()
    assert len(session.requests) == 2


@pytest.mark.asyncio
async def test_invalid_api_key_raises_auth_error() -> None:
    session = _FakeSession([_FakeResponse(401, {})])
    client = GoveeOpenApiClient(session, "bad")
    with pytest.raises(GoveeAuthError):
        await client.async_devices()


@pytest.mark.asyncio
async def test_request_spacing_applied() -> None:
    session = _FakeSession(
        [
            _FakeResponse(200, {"code": 200, "payload": {"devices": []}}),
            _FakeResponse(200, {"code": 200, "payload": {"devices": []}}),
        ]
    )
    client = GoveeOpenApiClient(session, "key")
    start = asyncio.get_event_loop().time()
    await client.async_devices()
    await client.async_devices()
    elapsed = asyncio.get_event_loop().time() - start
    assert elapsed >= REQUEST_SPACING_SECONDS
