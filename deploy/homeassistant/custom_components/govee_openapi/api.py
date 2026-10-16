"""Async client for the Govee OpenAPI capability model."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp

from .const import (
    CAP_COLOR,
    CAP_ON_OFF,
    CAP_RANGE,
    CAP_TOGGLE,
    DEFAULT_MAX_KELVIN,
    DEFAULT_MIN_KELVIN,
    INSTANCE_BRIGHTNESS,
    INSTANCE_COLOR_RGB,
    INSTANCE_COLOR_TEMP,
    INSTANCE_ONLINE,
    INSTANCE_POWER,
    REQUEST_SPACING_SECONDS,
    SOCKET_PREFIX,
)

_LOGGER = logging.getLogger(__name__)

BASE_URL = "https://openapi.api.govee.com/router/api/v1"
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=20)


class GoveeError(Exception):
    """A Govee request failed."""


class GoveeAuthError(GoveeError):
    """The API key was rejected."""


class GoveeRateLimitError(GoveeError):
    """The account or device hit a Govee rate limit."""


# OpenAPI documents per-endpoint limits; honor Retry-After with a sane ceiling.
MAX_RATE_LIMIT_COOLDOWN_SECONDS = 300.0


def _reason(body: dict[str, Any]) -> str:
    """Govee's own description of a failure.

    A rejected control puts the reason in ``msg`` at the top level and again in
    ``capability.state.errorMsg``; ``message`` is only used by some endpoints. The
    text is what tells an operator the difference between a device that is offline
    and a value the device would not take.
    """
    for candidate in (body.get("msg"), body.get("message")):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    capability = body.get("capability")
    if isinstance(capability, dict):
        state = capability.get("state")
        if isinstance(state, dict):
            error = state.get("errorMsg")
            if isinstance(error, str) and error.strip():
                return error.strip()
    return ""


@dataclass
class GoveeCapability:
    """One capability advertised by a device."""

    type: str
    instance: str
    parameters: dict[str, Any] = field(default_factory=dict)

    @property
    def is_socket(self) -> bool:
        return self.type == CAP_TOGGLE and self.instance.startswith(SOCKET_PREFIX)

    def int_range(self, fallback: tuple[int, int]) -> tuple[int, int]:
        """Read the advertised numeric range, falling back when Govee omits it."""
        raw = self.parameters.get("range")
        if not isinstance(raw, dict):
            return fallback
        try:
            return int(raw["min"]), int(raw["max"])
        except (KeyError, TypeError, ValueError):
            return fallback


@dataclass
class GoveeDevice:
    """A device as advertised by ``/user/devices``."""

    device_id: str
    sku: str
    name: str
    capabilities: list[GoveeCapability]

    def capability(self, cap_type: str, instance: str) -> GoveeCapability | None:
        for capability in self.capabilities:
            if capability.type == cap_type and capability.instance == instance:
                return capability
        return None

    @property
    def supports_brightness(self) -> bool:
        return self.capability(CAP_RANGE, INSTANCE_BRIGHTNESS) is not None

    @property
    def supports_rgb(self) -> bool:
        return self.capability(CAP_COLOR, INSTANCE_COLOR_RGB) is not None

    @property
    def supports_color_temp(self) -> bool:
        return self.capability(CAP_COLOR, INSTANCE_COLOR_TEMP) is not None

    @property
    def supports_power(self) -> bool:
        return self.capability(CAP_ON_OFF, INSTANCE_POWER) is not None

    @property
    def kelvin_range(self) -> tuple[int, int]:
        """The device's own Kelvin bounds.

        These genuinely differ per SKU (2000-9000 on an H6008, 2700-6500 on an
        H600D), so reporting one blanket range would make Home Assistant offer
        temperatures the bulb rejects.
        """
        capability = self.capability(CAP_COLOR, INSTANCE_COLOR_TEMP)
        if capability is None:
            return DEFAULT_MIN_KELVIN, DEFAULT_MAX_KELVIN
        return capability.int_range((DEFAULT_MIN_KELVIN, DEFAULT_MAX_KELVIN))

    @property
    def toggles(self) -> list[GoveeCapability]:
        return [item for item in self.capabilities if item.type == CAP_TOGGLE]


@dataclass
class GoveeState:
    """Latest known capability values for one device."""

    values: dict[str, int] = field(default_factory=dict)
    online: bool | None = None

    def value(self, instance: str) -> int | None:
        return self.values.get(instance)

    def is_on(self, instance: str) -> bool | None:
        raw = self.values.get(instance)
        return None if raw is None else bool(raw)


class GoveeOpenApiClient:
    """Minimal client covering the device, state, and control endpoints."""

    def __init__(self, session: aiohttp.ClientSession, api_key: str) -> None:
        self._session = session
        self._api_key = api_key
        # Govee rate-limits per device and per account, so serialise requests and
        # space them out rather than firing 42 state reads concurrently.
        self._gate = asyncio.Lock()
        self._rate_limited_until: float | None = None

    async def async_devices(self) -> list[GoveeDevice]:
        payload = await self._request("GET", "/user/devices")
        raw = payload if isinstance(payload, list) else payload.get("devices", [])
        if not isinstance(raw, list):
            return []
        devices: list[GoveeDevice] = []
        for item in raw:
            device = self._parse_device(item)
            if device is not None:
                devices.append(device)
        return devices

    async def async_state(self, device: GoveeDevice) -> GoveeState:
        payload = await self._request(
            "POST",
            "/device/state",
            json={
                "requestId": uuid.uuid4().hex,
                "payload": {"sku": device.sku, "device": device.device_id},
            },
        )
        if not isinstance(payload, dict):
            raise GoveeError("Govee returned an invalid device state")
        state = GoveeState()
        for entry in payload.get("capabilities") or []:
            if not isinstance(entry, dict):
                continue
            instance = entry.get("instance")
            raw_state = entry.get("state")
            if not isinstance(instance, str) or not isinstance(raw_state, dict):
                continue
            value = raw_state.get("value")
            if instance == INSTANCE_ONLINE:
                state.online = bool(value)
                continue
            if isinstance(value, bool):
                state.values[instance] = int(value)
            elif isinstance(value, int):
                state.values[instance] = value
        return state

    async def async_control(
        self, device: GoveeDevice, cap_type: str, instance: str, value: Any
    ) -> None:
        await self._request(
            "POST",
            "/device/control",
            json={
                "requestId": uuid.uuid4().hex,
                "payload": {
                    "sku": device.sku,
                    "device": device.device_id,
                    "capability": {"type": cap_type, "instance": instance, "value": value},
                },
            },
        )

    async def async_verify(self) -> int:
        """Confirm the key works and report how many devices it can see."""
        return len(await self.async_devices())

    async def _wait_for_rate_limit(self) -> None:
        if self._rate_limited_until is None:
            return
        delay = self._rate_limited_until - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

    def _apply_rate_limit(self, response: aiohttp.ClientResponse) -> None:
        retry_after = response.headers.get("Retry-After", "").strip()
        seconds = _retry_after_seconds(retry_after)
        if seconds is None:
            seconds = 60.0
        seconds = min(seconds, MAX_RATE_LIMIT_COOLDOWN_SECONDS)
        self._rate_limited_until = time.monotonic() + seconds

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        async with self._gate:
            await self._wait_for_rate_limit()
            try:
                response = await self._session.request(
                    method,
                    f"{BASE_URL}{path}",
                    headers={"Govee-API-Key": self._api_key, "Content-Type": "application/json"},
                    timeout=REQUEST_TIMEOUT,
                    **kwargs,
                )
                async with response:
                    if response.status in (401, 403):
                        raise GoveeAuthError("Govee rejected the API key")
                    if response.status == 429:
                        self._apply_rate_limit(response)
                        raise GoveeRateLimitError("Govee rate limit reached")
                    response.raise_for_status()
                    body = await response.json(content_type=None)
            except GoveeError:
                raise
            except asyncio.TimeoutError as err:
                raise GoveeError(f"Govee request to {path} timed out") from err
            except aiohttp.ClientError as err:
                raise GoveeError(f"Govee request to {path} failed: {err}") from err
            finally:
                await asyncio.sleep(REQUEST_SPACING_SECONDS)

        if not isinstance(body, dict):
            raise GoveeError(f"Govee returned a non-object response for {path}")
        try:
            code = int(body.get("code", 200))
        except (TypeError, ValueError):
            code = -1
        if code in (401, 403):
            raise GoveeAuthError("Govee rejected the API key")
        if code not in (0, 200):
            raise GoveeError(_reason(body) or f"Govee request to {path} failed")
        payload = body.get("payload")
        if payload is None:
            payload = body.get("data", {})
        return payload

    @staticmethod
    def _parse_device(raw: Any) -> GoveeDevice | None:
        if not isinstance(raw, dict):
            return None
        device_id = str(raw.get("device") or "")
        sku = str(raw.get("sku") or raw.get("model") or "")
        if not device_id or not sku:
            return None
        capabilities = [
            GoveeCapability(
                type=str(item.get("type") or ""),
                instance=str(item.get("instance") or ""),
                parameters=item.get("parameters") if isinstance(item.get("parameters"), dict) else {},
            )
            for item in raw.get("capabilities") or []
            if isinstance(item, dict) and item.get("type") and item.get("instance")
        ]
        return GoveeDevice(
            device_id=device_id,
            sku=sku,
            name=str(raw.get("deviceName") or raw.get("device_name") or device_id),
            capabilities=capabilities,
        )


def _retry_after_seconds(header_value: str) -> float | None:
    if not header_value:
        return None
    try:
        return max(0.0, float(header_value))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(header_value)
        if retry_at.tzinfo is None:
            return None
        return max(0.0, retry_at.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None
