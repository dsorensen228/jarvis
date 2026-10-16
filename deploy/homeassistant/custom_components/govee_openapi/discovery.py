"""Register platform entities when the Govee device roster grows."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import Entity

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .api import GoveeDevice
    from .coordinator import GoveeCoordinator

    EntityFactory = Callable[[GoveeCoordinator, GoveeDevice], Entity]
else:
    EntityFactory = Callable[..., Entity]


@callback
def async_setup_roster_listener(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: GoveeCoordinator,
    platform: str,
    async_add_entities: AddEntitiesCallback,
    should_add: Callable[[GoveeDevice], bool],
    build_entity: EntityFactory,
    unique_id_for: Callable[[GoveeDevice], str],
) -> Callable[[], None]:
    """Add entities once at setup and again whenever the roster gains devices."""

    # Deduplicate within this platform's lifetime only. Reload unloads every
    # entity, so the next setup must add them again under the same unique IDs.
    known: set[str] = set()

    @callback
    def _discover() -> None:
        new_entities: list[Entity] = []
        for device in coordinator.devices.values():
            if not should_add(device):
                continue
            unique_id = unique_id_for(device)
            if unique_id in known:
                continue
            known.add(unique_id)
            new_entities.append(build_entity(coordinator, device))
        if new_entities:
            async_add_entities(new_entities)

    _discover()
    return coordinator.async_add_device_listener(_discover)


@callback
def async_setup_roster_listener_multi(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: GoveeCoordinator,
    platform: str,
    async_add_entities: AddEntitiesCallback,
    build_entities: Callable[[GoveeCoordinator], list[tuple[str, Entity]]],
) -> Callable[[], None]:
    """Like ``async_setup_roster_listener`` when one device maps to many entities."""

    known: set[str] = set()

    @callback
    def _discover() -> None:
        new_entities: list[Entity] = []
        for unique_id, entity in build_entities(coordinator):
            if unique_id in known:
                continue
            known.add(unique_id)
            new_entities.append(entity)
        if new_entities:
            async_add_entities(new_entities)

    _discover()
    return coordinator.async_add_device_listener(_discover)
