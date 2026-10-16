"""Govee switches: plug power plus every individually addressable socket."""

from __future__ import annotations

import re
from typing import Any

from homeassistant.components.switch import SwitchDeviceClass, SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import GoveeCapability, GoveeDevice
from .const import CAP_ON_OFF, DOMAIN, INSTANCE_POWER, SOCKET_PREFIX
from .coordinator import GoveeCoordinator
from .discovery import async_setup_roster_listener_multi
from .entity import GoveeEntity

# "socketToggle2" reads as "Socket 2"; "dreamViewToggle" as "Dream view".
_SOCKET_NUMBER = re.compile(rf"^{SOCKET_PREFIX}(\d+)$")


def _switch_entities(coordinator: GoveeCoordinator) -> list[tuple[str, SwitchEntity]]:
    entities: list[tuple[str, SwitchEntity]] = []
    for device in coordinator.devices.values():
        # A dimmable device is already a light; a plug's main power is a switch.
        if device.supports_power and not device.supports_brightness:
            entities.append((device.device_id, GoveePowerSwitch(coordinator, device)))
        # Only sockets become switches. Govee's state endpoint never reports the
        # decorative toggles (gradient, dreamView, pillarLight, baseLight), so
        # they would be permanently "unknown" write-only entities.
        for capability in device.toggles:
            if capability.is_socket:
                unique_id = f"{device.device_id}_{capability.instance}"
                entities.append(
                    (unique_id, GoveeSocketSwitch(coordinator, device, capability))
                )
    return entities


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: GoveeCoordinator = hass.data[DOMAIN][entry.entry_id]
    remove = async_setup_roster_listener_multi(
        hass,
        entry,
        coordinator,
        "switch",
        async_add_entities,
        _switch_entities,
    )
    entry.async_on_unload(remove)


def _socket_label(instance: str) -> str:
    match = _SOCKET_NUMBER.match(instance)
    return f"Socket {match.group(1)}" if match else instance


class GoveeSwitchBase(GoveeEntity, SwitchEntity):
    """One on/off capability instance on a Govee device."""

    _cap_type: str
    _instance: str

    @property
    def is_on(self) -> bool | None:
        return self.state_values.is_on(self._instance)

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._async_apply(1)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._async_apply(0)

    async def _async_apply(self, value: int) -> None:
        device = self.device
        if device is not None:
            await self.coordinator.async_send(device, self._cap_type, self._instance, value)


class GoveePowerSwitch(GoveeSwitchBase):
    """The main power switch of a non-dimmable device such as a smart plug."""

    _attr_name = None
    _attr_device_class = SwitchDeviceClass.OUTLET
    _cap_type = CAP_ON_OFF
    _instance = INSTANCE_POWER

    def __init__(self, coordinator: GoveeCoordinator, device: GoveeDevice) -> None:
        super().__init__(coordinator, device)
        self._attr_unique_id = device.device_id


class GoveeSocketSwitch(GoveeSwitchBase):
    """One individually addressable socket on a multi-outlet plug."""

    _attr_device_class = SwitchDeviceClass.OUTLET

    def __init__(
        self, coordinator: GoveeCoordinator, device: GoveeDevice, capability: GoveeCapability
    ) -> None:
        super().__init__(coordinator, device)
        self._cap_type = capability.type
        self._instance = capability.instance
        self._attr_unique_id = f"{device.device_id}_{capability.instance}"
        self._attr_name = _socket_label(capability.instance)
