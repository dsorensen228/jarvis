# Jarvis Home Assistant custom components

## Govee OpenAPI (`govee_openapi`)

Cloud capability integration for Govee bulbs and multi-socket plugs (H5082). Use this
instead of `govee_light_local` when devices are cloud-only or expose per-socket toggles.

### Setup

1. Create a Govee OpenAPI key in the Govee developer portal for the household account.
2. In Home Assistant: **Settings → Devices & services → Add integration → Govee OpenAPI**.
3. Enter the API key. One config entry covers the whole account (singleton per HA instance).

### Adding new devices

Govee devices appear in HA automatically:

- The integration refreshes the device roster at most every six hours and on each startup.
- When Govee adds a bulb or plug to the account, new `light.*` / `switch.*` entities are
  created on the next roster refresh without re-adding the integration.
- State polling interval is configurable under **Configure** on the integration (default five
  minutes). Lower values are fresher but consume more of the OpenAPI per-device quota.

### Re-authentication

If the API key expires or is revoked, HA marks the entry **Reauth required**. Open the
integration, choose **Reconfigure** / follow the reauth flow, and submit a new key. The same
config entry, entity IDs, and options are preserved; the integration reloads after a valid key.

### Deploy to Uno Q

From this directory on the Mac mini:

```bash
HA_SSH_HOST=arduino@192.0.2.35 ./install-custom-components.sh
```

The script syncs `custom_components/`, compiles Python in the `homeassistant` container, and
restarts HA only when the content hash changes.

### Tests

```bash
cd deploy/homeassistant
uv sync
uv run pytest
```

Uses Home Assistant 2026.9.3 and `pytest-homeassistant-custom-component` (scoped venv, not the
monorepo root Python).
