"""Translate neutral smart-home actions into Home Assistant service calls."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from jarvis_api.smarthome.discovery import find_component
from jarvis_api.smarthome.model import (
    CAP_APP_LAUNCH,
    CAP_BRIGHTNESS,
    CAP_COLOR,
    CAP_COLOR_TEMPERATURE,
    CAP_MUTE,
    CAP_PLAYBACK,
    CAP_POWER,
    CAP_REMOTE_KEYS,
    CAP_VOLUME,
    DOMAIN_LIGHT,
    DOMAIN_MEDIA_PLAYER,
    DOMAIN_REMOTE,
    DOMAIN_SWITCH,
    REMOTE_KEYS,
    SmartHomeError,
    brightness_from_percent,
)

# Every action a caller may request, and the neutral capability it needs. The set
# is closed so an unsupported request fails with a clear message instead of being
# forwarded to Home Assistant and rejected there.
ACTION_CAPABILITIES: Dict[str, str] = {
    "turn_on": CAP_POWER,
    "turn_off": CAP_POWER,
    "toggle": CAP_POWER,
    "brightness": CAP_BRIGHTNESS,
    "color": CAP_COLOR,
    "color_temperature": CAP_COLOR_TEMPERATURE,
    "volume_up": CAP_VOLUME,
    "volume_down": CAP_VOLUME,
    "mute": CAP_MUTE,
    "unmute": CAP_MUTE,
    "play": CAP_PLAYBACK,
    "pause": CAP_PLAYBACK,
    "play_pause": CAP_PLAYBACK,
    "launch_app": CAP_APP_LAUNCH,
    "key": CAP_REMOTE_KEYS,
}

LIGHT_ACTIONS = ("turn_on", "turn_off", "brightness", "color", "color_temperature")


class ServiceCall:
    """One Home Assistant service invocation."""

    __slots__ = ("domain", "service", "data")

    def __init__(self, domain: str, service: str, data: Dict[str, Any]) -> None:
        self.domain = domain
        self.service = service
        self.data = data

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ServiceCall):
            return NotImplemented
        return (self.domain, self.service, self.data) == (other.domain, other.service, other.data)

    def __repr__(self) -> str:
        return f"ServiceCall({self.domain!r}, {self.service!r}, {self.data!r})"


def resolve_app_source(hint: str, source_list: List[str]) -> Optional[str]:
    """Match an app the way Jarvis always has: case-insensitive substring, shortest wins.

    Home Assistant's ``select_source`` needs an exact source name or an app id, so
    the fuzzy step that users rely on ("put on netflix") stays here.
    """
    needle = (hint or "").strip().casefold()
    if not needle:
        return None
    sources = [str(source) for source in source_list if str(source).strip()]
    for source in sources:
        if source.casefold() == needle:
            return source
    matches = [source for source in sources if needle in source.casefold()]
    if not matches:
        return None
    return min(matches, key=lambda source: (len(source), source.casefold()))


def select_component(
    device: Dict[str, Any], action: str, component_key: str = ""
) -> Dict[str, Any]:
    """Pick the component that can carry this action."""
    normalized = (action or "").strip().lower()
    capability = ACTION_CAPABILITIES.get(normalized)
    if capability is None:
        raise SmartHomeError(f"unsupported smart-home action: {action}")

    label = device.get("name") or device.get("id") or "device"
    if component_key:
        component = find_component(device, component_key)
        if component is None:
            raise SmartHomeError(f"{label} has no component named {component_key!r}")
        if capability not in (component.get("capabilities") or []):
            raise SmartHomeError("{} cannot {}".format(component.get("name") or label, normalized))
        return component

    for component in device.get("components") or []:
        if isinstance(component, dict) and capability in (component.get("capabilities") or []):
            return component
    raise SmartHomeError(f"{label} cannot {normalized}")


def plan(
    component: Dict[str, Any],
    action: str,
    parameters: Dict[str, Any],
    attributes: Optional[Dict[str, Any]] = None,
) -> Tuple[ServiceCall, Dict[str, Any]]:
    """Build the service call for one action, plus what it means for the caller."""
    normalized = (action or "").strip().lower()
    entity_id = str(component.get("entity_id") or "")
    domain = str(component.get("domain") or "")
    attributes = attributes or {}
    target = {"entity_id": entity_id}

    if domain in (DOMAIN_LIGHT, DOMAIN_SWITCH):
        return _plan_light_or_switch(component, domain, normalized, parameters, target)
    if domain == DOMAIN_MEDIA_PLAYER:
        return _plan_media_player(normalized, parameters, attributes, target)
    if domain == DOMAIN_REMOTE:
        return _plan_remote(normalized, parameters, target)
    raise SmartHomeError(f"unsupported smart-home domain: {domain}")


def _plan_light_or_switch(
    component: Dict[str, Any],
    domain: str,
    action: str,
    parameters: Dict[str, Any],
    target: Dict[str, Any],
) -> Tuple[ServiceCall, Dict[str, Any]]:
    if action == "turn_off":
        return ServiceCall(domain, "turn_off", dict(target)), {"power": False}
    if action == "turn_on":
        return ServiceCall(domain, "turn_on", dict(target)), {"power": True}
    if action == "toggle":
        return ServiceCall(domain, "toggle", dict(target)), {}

    if action == "brightness":
        percent = _int_parameter(parameters, ("percent", "brightness"), "brightness percent")
        percent = max(1, min(100, percent))
        data = dict(target)
        data["brightness"] = brightness_from_percent(percent)
        return ServiceCall(DOMAIN_LIGHT, "turn_on", data), {"brightness_percent": percent}

    if action == "color":
        red, green, blue = _rgb_parameters(parameters)
        data = dict(target)
        data["rgb_color"] = [red, green, blue]
        return ServiceCall(DOMAIN_LIGHT, "turn_on", data), {"color": [red, green, blue]}

    if action == "color_temperature":
        kelvin = _int_parameter(parameters, ("kelvin", "color_temperature"), "kelvin")
        low = component.get("min_kelvin")
        high = component.get("max_kelvin")
        if isinstance(low, int) and isinstance(high, int) and low <= high:
            kelvin = max(low, min(high, kelvin))
        data = dict(target)
        data["color_temp_kelvin"] = kelvin
        return ServiceCall(DOMAIN_LIGHT, "turn_on", data), {"kelvin": kelvin}

    raise SmartHomeError("{} cannot {}".format(component.get("name") or "light", action))


def _plan_media_player(
    action: str,
    parameters: Dict[str, Any],
    attributes: Dict[str, Any],
    target: Dict[str, Any],
) -> Tuple[ServiceCall, Dict[str, Any]]:
    simple = {
        "turn_on": ("turn_on", {"power": True}),
        "turn_off": ("turn_off", {"power": False}),
        "toggle": ("toggle", {}),
        "volume_up": ("volume_up", {}),
        "volume_down": ("volume_down", {}),
        "play": ("media_play", {}),
        "pause": ("media_pause", {}),
        "play_pause": ("media_play_pause", {}),
    }
    if action in simple:
        service, outcome = simple[action]
        return ServiceCall(DOMAIN_MEDIA_PLAYER, service, dict(target)), outcome

    if action in ("mute", "unmute"):
        data = dict(target)
        data["is_volume_muted"] = action == "mute"
        return ServiceCall(DOMAIN_MEDIA_PLAYER, "volume_mute", data), {"muted": action == "mute"}

    if action == "launch_app":
        app_id = str(parameters.get("app_id") or "").strip()
        hint = str(parameters.get("app") or parameters.get("app_name") or "").strip()
        source_list = attributes.get("source_list")
        source_list = [str(item) for item in source_list] if isinstance(source_list, list) else []
        if app_id:
            # Home Assistant's Roku source selection accepts an app id directly.
            source = app_id
        else:
            source = resolve_app_source(hint, source_list)
            if source is None:
                available = ", ".join(sorted(source_list)[:12]) or "none reported"
                raise SmartHomeError(f"no installed app matches {hint!r} (available: {available})")
        data = dict(target)
        data["source"] = source
        return ServiceCall(DOMAIN_MEDIA_PLAYER, "select_source", data), {"app": source}

    raise SmartHomeError(f"a media player cannot {action}")


def _plan_remote(
    action: str, parameters: Dict[str, Any], target: Dict[str, Any]
) -> Tuple[ServiceCall, Dict[str, Any]]:
    if action in ("turn_on", "turn_off", "toggle"):
        outcome = {} if action == "toggle" else {"power": action == "turn_on"}
        return ServiceCall(DOMAIN_REMOTE, action, dict(target)), outcome
    if action != "key":
        raise SmartHomeError(f"a remote cannot {action}")
    raw = str(parameters.get("key") or "")
    requested = raw.strip().lower()
    # Home Assistant's native Roku remote accepts Lit_ text commands. Do not
    # lowercase or strip the text itself: spaces and capitalization are input.
    command = raw if raw.startswith("Lit_") and len(raw) > 4 else REMOTE_KEYS.get(requested)
    if command is None:
        raise SmartHomeError(
            "unsupported remote key {!r}; supported keys: {}".format(
                parameters.get("key"), ", ".join(sorted(REMOTE_KEYS))
            )
        )
    data = dict(target)
    data["command"] = command
    return ServiceCall(DOMAIN_REMOTE, "send_command", data), {"key": requested}


def _int_parameter(parameters: Dict[str, Any], names: Tuple[str, ...], label: str) -> int:
    for name in names:
        if name in parameters:
            try:
                return int(parameters[name])
            except (TypeError, ValueError):
                raise SmartHomeError(f"{label} must be a whole number") from None
    raise SmartHomeError(f"{label} is required")


def _rgb_parameters(parameters: Dict[str, Any]) -> Tuple[int, int, int]:
    raw = parameters.get("color") or parameters.get("rgb") or parameters.get("color_rgb")
    if isinstance(raw, (list, tuple)) and len(raw) == 3:
        values = list(raw)
    else:
        values = [parameters.get("red"), parameters.get("green"), parameters.get("blue")]
    if any(value is None for value in values):
        raise SmartHomeError("color requires red, green, and blue")
    try:
        return tuple(max(0, min(255, int(value))) for value in values)  # type: ignore[return-value]
    except (TypeError, ValueError):
        raise SmartHomeError("color components must be whole numbers") from None
