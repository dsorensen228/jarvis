"""Coordinator behavior: roster listeners and optimistic color state."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from govee_openapi.api import (
    GoveeCapability,
    GoveeDevice,
    GoveeOpenApiClient,
    GoveeRateLimitError,
    GoveeState,
)
from govee_openapi.const import (
    CAP_COLOR,
    CAP_ON_OFF,
    CAP_RANGE,
    INSTANCE_BRIGHTNESS,
    INSTANCE_COLOR_RGB,
    INSTANCE_COLOR_TEMP,
    INSTANCE_POWER,
)
from govee_openapi.coordinator import GoveeCoordinator
from govee_openapi.light import GoveeLight
from homeassistant.components.light import ColorMode


def _bulb(device_id: str = "aa:bb") -> GoveeDevice:
    return GoveeDevice(
        device_id=device_id,
        sku="H6008",
        name="Test bulb",
        capabilities=[
            GoveeCapability(CAP_ON_OFF, INSTANCE_POWER, {}),
            GoveeCapability(CAP_RANGE, INSTANCE_BRIGHTNESS, {}),
            GoveeCapability(CAP_COLOR, INSTANCE_COLOR_RGB, {}),
            GoveeCapability(
                CAP_COLOR, INSTANCE_COLOR_TEMP, {"range": {"min": 2000, "max": 9000}}
            ),
        ],
    )


@pytest.fixture
def coordinator(mock_hass):
    entry = MagicMock()
    entry.entry_id = "test"
    # Drop post-command refresh tasks in unit tests (avoids lingering asyncio work).
    entry.async_create_background_task = lambda _hass, coro, name: None
    client = MagicMock(spec=GoveeOpenApiClient)
    coord = GoveeCoordinator(mock_hass, entry, client, state_interval=300)
    coord.async_set_updated_data(
        {
            "aa:bb": GoveeState(
                values={
                    INSTANCE_COLOR_TEMP: 4000,
                    INSTANCE_COLOR_RGB: 0xFF0000,
                }
            )
        }
    )
    coord.devices = {"aa:bb": _bulb()}
    coord._schedule_device_refresh = MagicMock()
    return coord


@pytest.mark.asyncio
async def test_rgb_command_clears_kelvin_cache(coordinator) -> None:
    coordinator.client.async_control = AsyncMock()
    device = coordinator.devices["aa:bb"]
    await coordinator.async_send(device, CAP_COLOR, INSTANCE_COLOR_RGB, 0x00FF00)
    state = coordinator.state("aa:bb")
    assert state.value(INSTANCE_COLOR_RGB) == 0x00FF00
    assert INSTANCE_COLOR_TEMP not in state.values
    assert GoveeLight(coordinator, device).color_mode == ColorMode.RGB


@pytest.mark.asyncio
async def test_kelvin_command_clears_rgb_cache(coordinator) -> None:
    coordinator.client.async_control = AsyncMock()
    device = coordinator.devices["aa:bb"]
    await coordinator.async_send(device, CAP_COLOR, INSTANCE_COLOR_TEMP, 2700)
    state = coordinator.state("aa:bb")
    assert state.value(INSTANCE_COLOR_TEMP) == 2700
    assert INSTANCE_COLOR_RGB not in state.values
    assert GoveeLight(coordinator, device).color_mode == ColorMode.COLOR_TEMP


def test_white_mode_survives_poll_with_both_color_values(coordinator):
    # Live H6008 response: Kelvin 2700 and its RGB equivalent are both nonzero.
    coordinator.data["aa:bb"] = GoveeState(
        values={
            INSTANCE_COLOR_TEMP: 2700,
            INSTANCE_COLOR_RGB: 16754263,
        }
    )
    light = GoveeLight(coordinator, coordinator.devices["aa:bb"])
    assert light.color_mode == ColorMode.COLOR_TEMP
    coordinator.data["aa:bb"].values[INSTANCE_COLOR_TEMP] = 0
    assert light.color_mode == ColorMode.RGB


@pytest.mark.asyncio
async def test_device_listener_fires_when_roster_grows(coordinator) -> None:
    seen: list[str] = []

    def listener() -> None:
        seen.append("ping")

    coordinator.async_add_device_listener(listener)
    coordinator.client.async_devices = AsyncMock(return_value=[_bulb(), _bulb("cc:dd")])
    await coordinator.async_load_devices(force=True)
    assert seen == ["ping"]
    assert set(coordinator.devices) == {"aa:bb", "cc:dd"}


@pytest.mark.asyncio
async def test_rate_limit_mid_poll_keeps_prior_states(coordinator) -> None:
    second = _bulb("cc:dd")
    coordinator.devices = {"aa:bb": _bulb(), "cc:dd": second}
    coordinator.async_set_updated_data(
        {
            "aa:bb": GoveeState(values={INSTANCE_POWER: 1}),
            "cc:dd": GoveeState(values={INSTANCE_POWER: 0}),
        }
    )

    async def state_side_effect(device):
        if device.device_id == "cc:dd":
            raise GoveeRateLimitError("limited")
        return GoveeState(values={INSTANCE_POWER: 1})

    coordinator.client.async_devices = AsyncMock(
        return_value=list(coordinator.devices.values())
    )
    coordinator.client.async_state = AsyncMock(side_effect=state_side_effect)
    result = await coordinator._async_update_data()
    assert result["aa:bb"].value(INSTANCE_POWER) == 1
    assert result["cc:dd"].value(INSTANCE_POWER) == 0
