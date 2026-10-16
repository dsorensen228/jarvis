"""Shared entity plumbing for Govee OpenAPI devices."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import GoveeDevice, GoveeState
from .const import DOMAIN
from .coordinator import GoveeCoordinator


class GoveeEntity(CoordinatorEntity[GoveeCoordinator]):
    """Base class tying one capability instance to a Govee device."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: GoveeCoordinator, device: GoveeDevice) -> None:
        super().__init__(coordinator)
        self._device_id = device.device_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device.device_id)},
            manufacturer="Govee",
            model=device.sku,
            name=device.name,
        )

    @property
    def device(self) -> GoveeDevice | None:
        return self.coordinator.device(self._device_id)

    @property
    def state_values(self) -> GoveeState:
        return self.coordinator.state(self._device_id)

    @property
    def available(self) -> bool:
        """Available while the last poll produced a state for this device.

        Govee's own ``online`` flag reports false on plugs that still accept
        commands, so it is surfaced as an attribute instead of being allowed to
        hide a working entity.
        """
        return (
            self.coordinator.last_update_success
            and self.device is not None
            and self._device_id in (self.coordinator.data or {})
        )

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        online = self.state_values.online
        return {"govee_reported_online": online} if online is not None else {}
