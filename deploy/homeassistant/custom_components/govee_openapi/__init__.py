"""Govee OpenAPI integration.

Home Assistant's built-in ``govee_light_local`` only reaches LAN-capable lights.
This integration speaks the Govee cloud capability model instead, which is what
covers the cloud-only bulbs and the individually addressable sockets on an H5082
dual smart plug.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_KEY, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import GoveeOpenApiClient
from .const import CONF_STATE_INTERVAL, DEFAULT_STATE_INTERVAL, DOMAIN
from .coordinator import GoveeCoordinator

PLATFORMS = [Platform.LIGHT, Platform.SWITCH]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    client = GoveeOpenApiClient(async_get_clientsession(hass), entry.data[CONF_API_KEY])
    coordinator = GoveeCoordinator(
        hass,
        entry,
        client,
        int(entry.options.get(CONF_STATE_INTERVAL, DEFAULT_STATE_INTERVAL)),
    )
    # Platforms build their entity lists from the roster, so it has to exist
    # before they are forwarded.
    await coordinator.async_load_devices(force=True)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coordinator: GoveeCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_shutdown()
    return unloaded


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
