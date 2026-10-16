"""Config and reauth flows."""

from __future__ import annotations

import importlib
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import CONF_API_KEY
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from govee_openapi.const import DOMAIN


def _config_flow_module():
    return importlib.import_module("custom_components.govee_openapi.config_flow")


@pytest.mark.asyncio
async def test_reauth_updates_key_and_preserves_entry(
    hass, hass_config_dir, enable_custom_integrations
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_API_KEY: "old-key"},
        unique_id=DOMAIN,
    )
    entry.add_to_hass(hass)
    client_cls = _config_flow_module().GoveeOpenApiClient

    with patch.object(client_cls, "async_verify", new=AsyncMock(return_value=3)):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": "reauth", "entry_id": entry.entry_id},
        )

    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"

    with patch.object(client_cls, "async_verify", new=AsyncMock(return_value=3)):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_API_KEY: "new-valid-key"}
        )

    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_API_KEY] == "new-valid-key"


@pytest.mark.asyncio
async def test_reauth_rejects_invalid_key(
    hass, hass_config_dir, enable_custom_integrations
) -> None:
    from custom_components.govee_openapi.api import GoveeAuthError

    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_API_KEY: "old-key"},
        unique_id=DOMAIN,
    )
    entry.add_to_hass(hass)
    client_cls = _config_flow_module().GoveeOpenApiClient

    with patch.object(
        client_cls, "async_verify", new=AsyncMock(side_effect=GoveeAuthError("nope"))
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": "reauth", "entry_id": entry.entry_id},
        )
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_API_KEY: "bad-key"}
        )

    assert result["type"] == FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}
    assert entry.data[CONF_API_KEY] == "old-key"
