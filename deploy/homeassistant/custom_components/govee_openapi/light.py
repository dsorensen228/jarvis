"""Govee lights exposed from the OpenAPI capability model."""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import ATTR_BRIGHTNESS, ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import GoveeDevice
from .const import (
    CAP_COLOR,
    CAP_ON_OFF,
    CAP_RANGE,
    DOMAIN,
    INSTANCE_BRIGHTNESS,
    INSTANCE_COLOR_RGB,
    INSTANCE_COLOR_TEMP,
    INSTANCE_POWER,
)
from .coordinator import GoveeCoordinator
from .discovery import async_setup_roster_listener
from .entity import GoveeEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: GoveeCoordinator = hass.data[DOMAIN][entry.entry_id]
    remove = async_setup_roster_listener(
        hass,
        entry,
        coordinator,
        "light",
        async_add_entities,
        lambda device: device.supports_power and device.supports_brightness,
        lambda coord, device: GoveeLight(coord, device),
        lambda device: device.device_id,
    )
    entry.async_on_unload(remove)


def _rgb_to_int(red: int, green: int, blue: int) -> int:
    return (red << 16) | (green << 8) | blue


def _int_to_rgb(value: int) -> tuple[int, int, int]:
    return (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF


class GoveeLight(GoveeEntity, LightEntity):
    """A Govee bulb, strip, or lamp addressed through its main power switch."""

    _attr_name = None

    def __init__(self, coordinator: GoveeCoordinator, device: GoveeDevice) -> None:
        super().__init__(coordinator, device)
        self._attr_unique_id = device.device_id
        modes: set[ColorMode] = set()
        if device.supports_rgb:
            modes.add(ColorMode.RGB)
        if device.supports_color_temp:
            modes.add(ColorMode.COLOR_TEMP)
        if not modes:
            modes.add(ColorMode.BRIGHTNESS)
        self._attr_supported_color_modes = modes
        self._attr_min_color_temp_kelvin, self._attr_max_color_temp_kelvin = (
            device.kelvin_range
        )

    @property
    def is_on(self) -> bool | None:
        return self.state_values.is_on(INSTANCE_POWER)

    @property
    def brightness(self) -> int | None:
        percent = self.state_values.value(INSTANCE_BRIGHTNESS)
        if percent is None:
            return None
        return max(0, min(255, round(percent * 255 / 100)))

    @property
    def rgb_color(self) -> tuple[int, int, int] | None:
        raw = self.state_values.value(INSTANCE_COLOR_RGB)
        return None if raw is None else _int_to_rgb(raw)

    @property
    def color_temp_kelvin(self) -> int | None:
        raw = self.state_values.value(INSTANCE_COLOR_TEMP)
        return raw or None

    @property
    def color_mode(self) -> ColorMode | None:
        modes = self._attr_supported_color_modes or set()
        # Govee reports the RGB equivalent alongside a positive Kelvin value in
        # white mode. RGB mode is indicated by zero/absent Kelvin, not RGB presence.
        if ColorMode.COLOR_TEMP in modes and self.state_values.value(
            INSTANCE_COLOR_TEMP
        ):
            return ColorMode.COLOR_TEMP
        if ColorMode.RGB in modes:
            return ColorMode.RGB
        return ColorMode.BRIGHTNESS

    async def async_turn_on(self, **kwargs: Any) -> None:
        device = self.device
        if device is None:
            return
        # Govee applies colour and brightness to a powered bulb, so bring it up
        # first when it is off or its power is unknown.
        if self.is_on is not True:
            await self.coordinator.async_send(device, CAP_ON_OFF, INSTANCE_POWER, 1)

        if ATTR_BRIGHTNESS in kwargs:
            percent = max(1, min(100, round(int(kwargs[ATTR_BRIGHTNESS]) * 100 / 255)))
            await self.coordinator.async_send(
                device, CAP_RANGE, INSTANCE_BRIGHTNESS, percent
            )

        if (rgb := kwargs.get("rgb_color")) is not None:
            red, green, blue = (max(0, min(255, int(part))) for part in rgb)
            await self.coordinator.async_send(
                device, CAP_COLOR, INSTANCE_COLOR_RGB, _rgb_to_int(red, green, blue)
            )
        elif (kelvin := kwargs.get("color_temp_kelvin")) is not None:
            low, high = device.kelvin_range
            await self.coordinator.async_send(
                device, CAP_COLOR, INSTANCE_COLOR_TEMP, max(low, min(high, int(kelvin)))
            )

    async def async_turn_off(self, **kwargs: Any) -> None:
        device = self.device
        if device is not None:
            await self.coordinator.async_send(device, CAP_ON_OFF, INSTANCE_POWER, 0)
