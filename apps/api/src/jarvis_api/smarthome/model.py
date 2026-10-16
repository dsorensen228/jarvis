"""Provider-neutral smart-home model.

Home Assistant owns device integrations, discovery, and state. Everything above
this module speaks the vocabulary defined here and never a vendor's own, so a new
device class only has to be taught to the adapter.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

PLATFORM = "home_assistant"

# Neutral capabilities. A device only advertises what its Home Assistant entity
# genuinely supports, so a caller never has to guess.
CAP_POWER = "power"
CAP_BRIGHTNESS = "brightness"
CAP_COLOR = "color"
CAP_COLOR_TEMPERATURE = "color_temperature"
CAP_VOLUME = "volume"
CAP_MUTE = "mute"
CAP_PLAYBACK = "playback"
CAP_APP_LAUNCH = "app_launch"
CAP_REMOTE_KEYS = "remote_keys"
CAP_TEXT_INPUT = "text_input"
CAP_SEARCH = "search"
CAP_CHANNEL_TUNE = "channel_tune"
CAP_FIND_REMOTE = "find_remote"

DOMAIN_LIGHT = "light"
DOMAIN_SWITCH = "switch"
DOMAIN_MEDIA_PLAYER = "media_player"
DOMAIN_REMOTE = "remote"
SUPPORTED_DOMAINS = (DOMAIN_LIGHT, DOMAIN_SWITCH, DOMAIN_MEDIA_PLAYER, DOMAIN_REMOTE)

# The component a caller addresses when it does not name one. Individually
# switchable sockets on a multi-outlet plug get their own component key.
MAIN_COMPONENT = "main"

# Home Assistant media_player feature bits (homeassistant.components.media_player).
FEATURE_PAUSE = 1
FEATURE_VOLUME_SET = 4
FEATURE_VOLUME_MUTE = 8
FEATURE_TURN_ON = 128
FEATURE_TURN_OFF = 256
FEATURE_PLAY_MEDIA = 512
FEATURE_VOLUME_STEP = 1024
FEATURE_SELECT_SOURCE = 2048
FEATURE_PLAY = 16384

# Neutral remote keys mapped to the command names Home Assistant's remote
# platform accepts. Home Assistant rejects an unknown command outright, so the
# allowed set is closed rather than passed through.
REMOTE_KEYS: Dict[str, str] = {
    "home": "home",
    "back": "back",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "select": "select",
    "rewind": "reverse",
    "fast_forward": "forward",
    "replay": "replay",
    "info": "info",
    "channel_up": "channel_up",
    "channel_down": "channel_down",
    "enter": "enter",
    "backspace": "backspace",
    "search": "search",
    "find_remote": "find_remote",
    "input_av1": "input_av1",
    "input_hdmi1": "input_hdmi1",
    "input_hdmi2": "input_hdmi2",
    "input_hdmi3": "input_hdmi3",
    "input_hdmi4": "input_hdmi4",
    "input_tuner": "input_tuner",
    "play": "play",
    "power": "power",
    "volume_up": "volume_up",
    "volume_down": "volume_down",
    "volume_mute": "volume_mute",
}


class SmartHomeError(Exception):
    """A smart-home request could not be satisfied."""


class SmartHomeUnavailable(SmartHomeError):
    """Home Assistant or the target device is not reachable right now."""


def component_key_for(entity_id: str, socket_index: Optional[int]) -> str:
    """Stable component key. Sockets are numbered; everything else is the main one."""
    del entity_id
    return MAIN_COMPONENT if socket_index is None else f"socket_{socket_index}"


def light_capabilities(attributes: Dict[str, Any]) -> List[str]:
    """Truthful light capabilities read from Home Assistant's own attributes."""
    capabilities = [CAP_POWER]
    modes = attributes.get("supported_color_modes")
    modes = [str(mode) for mode in modes] if isinstance(modes, list) else []
    if modes and modes != ["onoff"]:
        capabilities.append(CAP_BRIGHTNESS)
    if any(mode in {"rgb", "rgbw", "rgbww", "hs", "xy"} for mode in modes):
        capabilities.append(CAP_COLOR)
    if "color_temp" in modes:
        capabilities.append(CAP_COLOR_TEMPERATURE)
    return capabilities


def media_player_capabilities(attributes: Dict[str, Any]) -> List[str]:
    """Truthful media capabilities derived from the reported feature bitmask."""
    try:
        features = int(attributes.get("supported_features") or 0)
    except (TypeError, ValueError):
        features = 0
    capabilities: List[str] = []
    if features & (FEATURE_TURN_ON | FEATURE_TURN_OFF):
        capabilities.append(CAP_POWER)
    if features & (FEATURE_VOLUME_STEP | FEATURE_VOLUME_SET):
        capabilities.append(CAP_VOLUME)
    if features & FEATURE_VOLUME_MUTE:
        capabilities.append(CAP_MUTE)
    if features & (FEATURE_PLAY | FEATURE_PAUSE | FEATURE_PLAY_MEDIA):
        capabilities.append(CAP_PLAYBACK)
    if features & FEATURE_SELECT_SOURCE:
        capabilities.append(CAP_APP_LAUNCH)
    return capabilities


def capabilities_for(domain: str, attributes: Dict[str, Any]) -> List[str]:
    if domain == DOMAIN_LIGHT:
        return light_capabilities(attributes)
    if domain == DOMAIN_SWITCH:
        return [CAP_POWER]
    if domain == DOMAIN_MEDIA_PLAYER:
        return media_player_capabilities(attributes)
    if domain == DOMAIN_REMOTE:
        return [CAP_POWER, CAP_REMOTE_KEYS]
    return []


def live_components(
    device: Dict[str, Any], states: Dict[str, Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Refresh controls from HA state, including already imported Roku devices.

    Roku's generic media feature mask advertises TV volume commands even on
    players without a TV. Its device class and diagnostic entities are the
    additional evidence needed before exposing those controls.
    """
    components = [dict(item) for item in device.get("components") or [] if isinstance(item, dict)]
    roku = device.get("integration") == "roku"
    tv = False
    for component in components:
        state = states.get(str(component.get("entity_id") or "")) or {}
        attrs = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}
        component["integration"] = device.get("integration") or ""
        if state and is_reachable(str(state.get("state") or "")):
            component["capabilities"] = capabilities_for(component["domain"], attrs)
        else:
            component["capabilities"] = list(component.get("capabilities") or [])
        if roku and component["domain"] == DOMAIN_MEDIA_PLAYER:
            tv = attrs.get("device_class") == "tv"
            caps = [cap for cap in component["capabilities"] if cap != CAP_CHANNEL_TUNE]
            if not tv:
                caps = [cap for cap in caps if cap not in {CAP_VOLUME, CAP_MUTE}]
            caps.append(CAP_SEARCH)
            try:
                features = int(attrs.get("supported_features") or 0)
            except (TypeError, ValueError):
                features = 0
            if tv and features & FEATURE_PLAY_MEDIA:
                caps.append(CAP_CHANNEL_TUNE)
            component["capabilities"] = sorted(set(caps))
    for component in components:
        if not roku or component["domain"] != DOMAIN_REMOTE:
            continue
        caps = component["capabilities"] + [CAP_TEXT_INPUT]
        keys = set(REMOTE_KEYS)
        keys.discard("find_remote")
        if not tv:
            keys -= {"volume_up", "volume_down", "volume_mute", "channel_up", "channel_down"}
            keys = {key for key in keys if not key.startswith("input_")}
        diagnostic = states.get(str(component.get("find_remote_entity_id") or "")) or {}
        if diagnostic.get("state") == "on":
            caps.append(CAP_FIND_REMOTE)
            keys.add("find_remote")
        else:
            caps = [cap for cap in caps if cap != CAP_FIND_REMOTE]
        component["capabilities"] = sorted(set(caps))
        component["supported_keys"] = sorted(keys)
    return components


def kelvin_range(attributes: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    """The device's own Kelvin bounds; these differ per model."""
    low = attributes.get("min_color_temp_kelvin")
    high = attributes.get("max_color_temp_kelvin")
    try:
        if low is None or high is None:
            return None
        return int(low), int(high)
    except (TypeError, ValueError):
        return None


def percent_from_brightness(raw: Any) -> Optional[int]:
    """Home Assistant reports 0-255; the Jarvis contract has always been percent."""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return max(0, min(100, round(value * 100 / 255)))


def brightness_from_percent(percent: int) -> int:
    return max(1, min(255, round(max(1, min(100, percent)) * 255 / 100)))


def rgb_from_attributes(attributes: Dict[str, Any]) -> Optional[List[int]]:
    raw = attributes.get("rgb_color")
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        return None
    try:
        return [max(0, min(255, int(part))) for part in raw]
    except (TypeError, ValueError):
        return None


def power_from_state(state: str) -> Optional[bool]:
    """``None`` means genuinely unknown rather than off."""
    normalized = (state or "").strip().lower()
    if normalized in {"on", "playing", "paused", "idle", "buffering"}:
        return True
    if normalized in {"off", "standby"}:
        return False
    return None


def is_reachable(state: str) -> bool:
    return (state or "").strip().lower() not in {"unavailable", ""}


_LEGACY_LIGHT_CAPABILITY_INSTANCES = frozenset({"brightness", "colorRgb", "colorTemperatureK"})


def legacy_is_light(row: Dict[str, Any]) -> bool:
    """Whether a pre-HA vendor row belonged in Jarvis bulk light control."""
    provider = str(row.get("provider") or row.get("legacy_provider") or "")
    if provider == "roku":
        return False
    if provider != "govee":
        return bool(row.get("is_light"))
    capabilities = row.get("capabilities") or row.get("legacy_capabilities") or []
    if isinstance(capabilities, list):
        for capability in capabilities:
            if not isinstance(capability, dict):
                continue
            if capability.get("instance") in _LEGACY_LIGHT_CAPABILITY_INSTANCES:
                return True
    sku = str(row.get("sku") or row.get("legacy_sku") or "").strip()
    return sku == "H5083"
