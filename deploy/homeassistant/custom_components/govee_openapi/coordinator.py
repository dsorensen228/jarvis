"""Polling coordinator for Govee OpenAPI devices."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import callback
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import (
    GoveeAuthError,
    GoveeDevice,
    GoveeError,
    GoveeOpenApiClient,
    GoveeRateLimitError,
    GoveeState,
)
from .const import (
    CAP_COLOR,
    COMMAND_REFRESH_DELAY,
    DEVICE_LIST_INTERVAL,
    DOMAIN,
    INSTANCE_COLOR_RGB,
    INSTANCE_COLOR_TEMP,
)

_LOGGER = logging.getLogger(__name__)


class GoveeCoordinator(DataUpdateCoordinator[dict[str, GoveeState]]):
    """Keeps one cached state per Govee device and funnels every command."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: GoveeOpenApiClient,
        state_interval: int,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=state_interval),
            config_entry=entry,
        )
        self.client = client
        self.devices: dict[str, GoveeDevice] = {}
        self._devices_fetched_at = None
        self._pending_refresh: dict[str, asyncio.Task[None]] = {}
        self._device_listeners: list[Callable[[], None]] = []

    async def async_load_devices(self, force: bool = False) -> None:
        """Refresh the device roster, which changes far less often than state."""
        now = dt_util.utcnow()
        if (
            not force
            and self._devices_fetched_at is not None
            and now - self._devices_fetched_at < DEVICE_LIST_INTERVAL
        ):
            return
        try:
            devices = await self.client.async_devices()
        except GoveeAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except GoveeError as err:
            if not self.devices:
                raise UpdateFailed(str(err)) from err
            # A transient list failure must not tear down working entities.
            _LOGGER.warning("Keeping the cached Govee device list: %s", err)
            return
        previous_ids = set(self.devices)
        self.devices = {device.device_id: device for device in devices}
        self._devices_fetched_at = now
        if set(self.devices) != previous_ids:
            self._notify_device_listeners()

    @callback
    def async_add_device_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Run ``listener`` whenever the device roster gains or loses entries."""

        self._device_listeners.append(listener)

        @callback
        def remove_listener() -> None:
            self._device_listeners.remove(listener)

        return remove_listener

    @callback
    def _notify_device_listeners(self) -> None:
        for listener in self._device_listeners:
            listener()

    async def _async_update_data(self) -> dict[str, GoveeState]:
        await self.async_load_devices()
        if not self.devices:
            return {}
        states: dict[str, GoveeState] = dict(self.data or {})
        failures: list[str] = []
        for device_id, device in self.devices.items():
            try:
                states[device_id] = await self.client.async_state(device)
            except GoveeAuthError as err:
                raise ConfigEntryAuthFailed(str(err)) from err
            except GoveeRateLimitError as err:
                _LOGGER.warning(
                    "Pausing Govee state refresh for %s: %s", device.name, err
                )
                return states
            except GoveeError as err:
                failures.append(f"{device.name}: {err}")
                # Drop the stale value so the entity reports unknown rather than
                # a confidently wrong cached state.
                states.pop(device_id, None)
        if failures and len(failures) == len(self.devices):
            raise UpdateFailed("; ".join(failures[:3]))
        for failure in failures:
            _LOGGER.debug("Govee state read failed for %s", failure)
        return states

    def device(self, device_id: str) -> GoveeDevice | None:
        return self.devices.get(device_id)

    def state(self, device_id: str) -> GoveeState:
        return (self.data or {}).get(device_id) or GoveeState()

    async def async_send(
        self, device: GoveeDevice, cap_type: str, instance: str, value: Any
    ) -> None:
        """Apply one capability, then optimistically record the new value."""
        try:
            await self.client.async_control(device, cap_type, instance, value)
        except GoveeAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except GoveeRateLimitError as err:
            raise HomeAssistantError(f"Govee rate limit: {err}") from err
        except GoveeError as err:
            raise HomeAssistantError(f"Govee rejected the command: {err}") from err
        states = dict(self.data or {})
        current = states.get(device.device_id) or GoveeState()
        merged = GoveeState(values=dict(current.values), online=current.online)
        if cap_type == CAP_COLOR and instance == INSTANCE_COLOR_RGB:
            merged.values.pop(INSTANCE_COLOR_TEMP, None)
        elif cap_type == CAP_COLOR and instance == INSTANCE_COLOR_TEMP:
            merged.values.pop(INSTANCE_COLOR_RGB, None)
        if isinstance(value, bool):
            merged.values[instance] = int(value)
        elif isinstance(value, int):
            merged.values[instance] = value
        states[device.device_id] = merged
        self.async_set_updated_data(states)
        self._schedule_device_refresh(device)

    def _schedule_device_refresh(self, device: GoveeDevice) -> None:
        """Re-read only the device that changed, coalescing rapid commands."""
        existing = self._pending_refresh.pop(device.device_id, None)
        if existing is not None and not existing.done():
            existing.cancel()

        async def runner() -> None:
            try:
                await asyncio.sleep(COMMAND_REFRESH_DELAY)
                state = await self.client.async_state(device)
            except asyncio.CancelledError:
                raise
            except GoveeError as err:
                _LOGGER.debug("Post-command Govee read failed for %s: %s", device.name, err)
                return
            states = dict(self.data or {})
            states[device.device_id] = state
            self.async_set_updated_data(states)
            self._pending_refresh.pop(device.device_id, None)

        self._pending_refresh[device.device_id] = self.config_entry.async_create_background_task(
            self.hass, runner(), f"{DOMAIN}-refresh-{device.device_id}"
        )

    async def async_shutdown(self) -> None:
        for task in list(self._pending_refresh.values()):
            task.cancel()
        self._pending_refresh.clear()
        await super().async_shutdown()
