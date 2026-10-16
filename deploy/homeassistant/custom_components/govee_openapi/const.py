"""Constants for the Govee OpenAPI integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "govee_openapi"

CONF_STATE_INTERVAL = "state_interval_seconds"

# OpenAPI limits (developer.govee.com, 2026): device/state 30/min/device;
# user/devices 30/min/account. Default interval keeps ~42 devices well under
# per-device caps while staying fresher than legacy 10-minute polling.
DEFAULT_STATE_INTERVAL = 300
MIN_STATE_INTERVAL = 120
DEVICE_LIST_INTERVAL = timedelta(hours=6)

# Space requests so a full-house state sweep stays under burst limits (12/sec account).
REQUEST_SPACING_SECONDS = 0.15

# A command is accepted before the bulb reports the new value, so re-read the one
# device that changed instead of waiting out the poll interval.
COMMAND_REFRESH_DELAY = 3.0

CAP_ON_OFF = "devices.capabilities.on_off"
CAP_TOGGLE = "devices.capabilities.toggle"
CAP_RANGE = "devices.capabilities.range"
CAP_COLOR = "devices.capabilities.color_setting"

INSTANCE_POWER = "powerSwitch"
INSTANCE_BRIGHTNESS = "brightness"
INSTANCE_COLOR_RGB = "colorRgb"
INSTANCE_COLOR_TEMP = "colorTemperatureK"
INSTANCE_ONLINE = "online"

SOCKET_PREFIX = "socketToggle"

DEFAULT_MIN_KELVIN = 2000
DEFAULT_MAX_KELVIN = 9000
