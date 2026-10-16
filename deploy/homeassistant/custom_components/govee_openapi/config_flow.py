"""Config and options flow for the Govee OpenAPI integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_API_KEY
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import GoveeAuthError, GoveeError, GoveeOpenApiClient
from .const import (
    CONF_STATE_INTERVAL,
    DEFAULT_STATE_INTERVAL,
    DOMAIN,
    MIN_STATE_INTERVAL,
)


class GoveeOpenApiConfigFlow(ConfigFlow, domain=DOMAIN):
    """Collect and verify the Govee OpenAPI key."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            api_key = str(user_input[CONF_API_KEY]).strip()
            client = GoveeOpenApiClient(async_get_clientsession(self.hass), api_key)
            try:
                count = await client.async_verify()
            except GoveeAuthError:
                errors["base"] = "invalid_auth"
            except GoveeError:
                errors["base"] = "cannot_connect"
            else:
                if not count:
                    errors["base"] = "no_devices"
                else:
                    await self.async_set_unique_id(DOMAIN)
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=f"Govee ({count} devices)",
                        data={CONF_API_KEY: api_key},
                    )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_API_KEY): str}),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        reauth_entry = self._get_reauth_entry()
        if user_input is not None:
            api_key = str(user_input[CONF_API_KEY]).strip()
            client = GoveeOpenApiClient(async_get_clientsession(self.hass), api_key)
            try:
                count = await client.async_verify()
            except GoveeAuthError:
                errors["base"] = "invalid_auth"
            except GoveeError:
                errors["base"] = "cannot_connect"
            else:
                if not count:
                    errors["base"] = "no_devices"
                else:
                    return self.async_update_reload_and_abort(
                        reauth_entry,
                        data_updates={CONF_API_KEY: api_key},
                    )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_API_KEY): str}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> OptionsFlow:
        return GoveeOpenApiOptionsFlow()


class GoveeOpenApiOptionsFlow(OptionsFlow):
    """Tune the state polling interval against the Govee account quota."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_STATE_INTERVAL, DEFAULT_STATE_INTERVAL)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_STATE_INTERVAL, default=current): vol.All(
                        vol.Coerce(int), vol.Range(min=MIN_STATE_INTERVAL, max=3600)
                    )
                }
            ),
        )
