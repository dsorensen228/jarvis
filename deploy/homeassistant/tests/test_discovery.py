"""Platform entity discovery when the Govee roster grows."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from govee_openapi.api import GoveeCapability, GoveeDevice
from govee_openapi.const import (
    CAP_ON_OFF,
    CAP_TOGGLE,
    DOMAIN,
    INSTANCE_POWER,
    SOCKET_PREFIX,
)
from govee_openapi.coordinator import GoveeCoordinator
from govee_openapi.discovery import async_setup_roster_listener_multi
from govee_openapi.switch import GoveePowerSwitch, GoveeSocketSwitch


def _plug(device_id: str, sockets: int = 2) -> GoveeDevice:
    caps = [GoveeCapability(CAP_ON_OFF, INSTANCE_POWER, {})]
    for index in range(1, sockets + 1):
        caps.append(GoveeCapability(CAP_TOGGLE, f"{SOCKET_PREFIX}{index}", {}))
    return GoveeDevice(device_id=device_id, sku="H5082", name="Plug", capabilities=caps)


@pytest.mark.asyncio
async def test_switch_listener_adds_new_plug_entities(mock_hass) -> None:
    mock_hass.data = {}
    entry = MagicMock()
    entry.entry_id = "entry-1"
    entry.async_on_unload = MagicMock()
    coordinator = MagicMock(spec=GoveeCoordinator)
    devices: dict[str, GoveeDevice] = {"plug-a": _plug("plug-a")}
    coordinator.devices = devices
    coordinator.async_add_device_listener = (
        GoveeCoordinator.async_add_device_listener.__get__(
            coordinator, GoveeCoordinator
        )
    )
    coordinator._device_listeners = []
    coordinator._notify_device_listeners = (
        GoveeCoordinator._notify_device_listeners.__get__(coordinator, GoveeCoordinator)
    )

    added_batches: list[list] = []

    def async_add_entities(entities):
        added_batches.append(list(entities))

    from govee_openapi.switch import _switch_entities

    remove = async_setup_roster_listener_multi(
        mock_hass,
        entry,
        coordinator,
        "switch",
        async_add_entities,
        _switch_entities,
    )
    assert len(added_batches) == 1
    assert len(added_batches[0]) == 3  # main + 2 sockets

    devices["plug-b"] = _plug("plug-b")
    coordinator._notify_device_listeners()
    assert len(added_batches) == 2
    assert len(added_batches[1]) == 3
    assert isinstance(added_batches[1][0], (GoveePowerSwitch, GoveeSocketSwitch))
    coordinator._notify_device_listeners()
    assert (
        len(added_batches) == 2
    )  # polling the same roster must not duplicate entities
    remove()
    assert coordinator._device_listeners == []

    # HA unloads all platform entities on a config-entry reload. Reusing the same
    # hass and entry must rebuild them, including the dynamically discovered plug.
    remove_reloaded = async_setup_roster_listener_multi(
        mock_hass, entry, coordinator, "switch", async_add_entities, _switch_entities
    )
    assert len(added_batches) == 3
    assert len(added_batches[2]) == 6
    remove_reloaded()


def test_single_entity_listener_rebuilds_after_reload(mock_hass):
    from govee_openapi.discovery import async_setup_roster_listener

    entry = MagicMock()
    coordinator = MagicMock()
    coordinator.devices = {"a": _plug("a")}
    callbacks = []
    coordinator.async_add_device_listener.side_effect = lambda cb: callbacks.append(
        cb
    ) or (lambda: callbacks.remove(cb))
    batches = []

    def setup():
        return async_setup_roster_listener(
            mock_hass,
            entry,
            coordinator,
            "light",
            lambda entities: batches.append(entities),
            lambda device: True,
            lambda coord, device: device,
            lambda device: device.device_id,
        )

    remove = setup()
    callbacks[0]()
    assert len(batches) == 1
    remove()
    coordinator.devices["b"] = _plug("b")
    remove = setup()
    assert [len(batch) for batch in batches] == [1, 2]
    remove()
