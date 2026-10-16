"""Turn Home Assistant entities into provider-neutral Jarvis devices."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List, Optional, Tuple

from jarvis_api.smarthome.model import (
    DOMAIN_LIGHT,
    DOMAIN_MEDIA_PLAYER,
    DOMAIN_REMOTE,
    DOMAIN_SWITCH,
    MAIN_COMPONENT,
    SUPPORTED_DOMAINS,
    capabilities_for,
    kelvin_range,
)

# Our Govee component names a socket entity "<device> Socket 2"; the unique id
# behind it ends in socketToggle2. Either way the trailing number is the socket.
_SOCKET_SUFFIX = re.compile(r"_socket_(\d+)$")

# Device ids have always been derived from a short provider name plus the vendor's
# own id. Mapping the Home Assistant integration back onto that name means every
# already-imported device keeps the id its room assignment, user label, and any
# scheduled reference points at, with no row rewriting at all.
ID_NAMESPACES = {"govee_openapi": "govee"}


def id_namespace(integration: str) -> str:
    return ID_NAMESPACES.get(integration, integration)


def stable_device_id(integration: str, external_id: str) -> str:
    """Deterministic Jarvis id for a device Home Assistant reports."""
    namespace = id_namespace(integration)
    digest = hashlib.sha256(f"{namespace}:{external_id}".encode())
    return digest.hexdigest()[:32]


def _entity_domain(entity_id: str) -> str:
    return entity_id.split(".", 1)[0]


def _socket_index(entity_id: str) -> Optional[int]:
    match = _SOCKET_SUFFIX.search(entity_id)
    return int(match.group(1)) if match else None


def _component_name(friendly_name: str, device_name: str) -> str:
    """The part of the entity name that is not just the device name."""
    friendly = (friendly_name or "").strip()
    device = (device_name or "").strip()
    if friendly and device and friendly.lower().startswith(device.lower()):
        remainder = friendly[len(device) :].strip(" -_")
        return remainder
    return "" if friendly == device else friendly


def _identifier(row: Dict[str, Any]) -> Tuple[str, str]:
    """``(integration, vendor id)`` from Home Assistant's device identifiers."""
    identifiers = row.get("identifiers")
    if isinstance(identifiers, list):
        pairs = sorted(
            (str(entry[0]), str(entry[1]))
            for entry in identifiers
            if isinstance(entry, (list, tuple)) and len(entry) >= 2
        )
        # HA device identifiers are a set. Preserve the original vendor namespace
        # when a device also acquires an identifier from another integration.
        for pair in pairs:
            if pair[0] in {"govee_openapi", "roku"}:
                return pair
        if pairs:
            return pairs[0]
    return "", ""


def group_by_device(
    registry: List[Dict[str, Any]], states: Dict[str, Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Collapse Home Assistant entities into one neutral device each.

    A Roku exposes a ``media_player`` and a ``remote`` entity, and a dual smart
    plug exposes one switch per socket. Grouping on the Home Assistant device
    keeps those as a single Jarvis device with several components, which is what
    the existing clients already expect from Govee compound outlets.
    """
    grouped: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for row in sorted(registry, key=lambda item: str(item.get("entity_id") or "")):
        entity_id = str(row.get("entity_id") or "")
        domain = _entity_domain(entity_id)
        if domain not in SUPPORTED_DOMAINS:
            continue
        integration, external_id = _identifier(row)
        device_key = str(row.get("device_id") or "") or entity_id
        if not external_id:
            # Without a device identifier the entity is its own device and the
            # entity id is the only stable handle it has.
            integration, external_id = integration or "home_assistant", device_key

        if device_key not in grouped:
            order.append(device_key)
            grouped[device_key] = {
                "ha_device_id": str(row.get("device_id") or ""),
                "integration": integration,
                "external_id": external_id,
                "source_name": str(row.get("device_name") or row.get("friendly_name") or entity_id),
                "model": str(row.get("model") or ""),
                "manufacturer": str(row.get("manufacturer") or ""),
                "area": str(row.get("area") or ""),
                "components": [],
            }

        state = states.get(entity_id) or {}
        attributes = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}
        socket_index = _socket_index(entity_id)
        component: Dict[str, Any] = {
            "key": MAIN_COMPONENT if socket_index is None else f"socket_{socket_index}",
            "entity_id": entity_id,
            "domain": domain,
            "name": _component_name(
                str(row.get("friendly_name") or ""), grouped[device_key]["source_name"]
            ),
            "capabilities": capabilities_for(domain, attributes),
        }
        if domain == DOMAIN_LIGHT:
            bounds = kelvin_range(attributes)
            if bounds is not None:
                component["min_kelvin"], component["max_kelvin"] = bounds
        grouped[device_key]["components"].append(component)

    devices = []
    for device_key in order:
        device = grouped[device_key]
        device["components"].sort(key=_component_sort_key)
        assigned = set()
        for component in device["components"]:
            key = component["key"]
            if key in assigned:
                key = component["domain"]
                if key in assigned or key != DOMAIN_REMOTE:
                    suffix = hashlib.sha256(component["entity_id"].encode()).hexdigest()[:12]
                    key = f"{component['domain']}_{suffix}"
            component["key"] = key
            assigned.add(key)
        device["capabilities"] = sorted(
            {
                capability
                for component in device["components"]
                for capability in component["capabilities"]
            }
        )
        device["id"] = stable_device_id(device["integration"], device["external_id"])
        devices.append(device)
    return devices


def _component_sort_key(component: Dict[str, Any]) -> Tuple[int, str, str]:
    """Main first, then sockets in order, with control domains ahead of remotes."""
    domain_rank = {
        DOMAIN_LIGHT: 0,
        DOMAIN_SWITCH: 0,
        DOMAIN_MEDIA_PLAYER: 0,
        DOMAIN_REMOTE: 1,
    }.get(component["domain"], 2)
    is_main = 0 if component["key"] == MAIN_COMPONENT else 1
    return (domain_rank + is_main * 10, component["key"], component["entity_id"])


def primary_component(
    device: Dict[str, Any], domain: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """The component a caller means when it does not name one."""
    components = device.get("components") or []
    candidates = [
        component
        for component in components
        if isinstance(component, dict) and (domain is None or component.get("domain") == domain)
    ]
    for component in candidates:
        if component.get("key") == MAIN_COMPONENT:
            return component
    return candidates[0] if candidates else None


def find_component(device: Dict[str, Any], key: str) -> Optional[Dict[str, Any]]:
    wanted = (key or "").strip() or MAIN_COMPONENT
    for component in device.get("components") or []:
        if isinstance(component, dict) and component.get("key") == wanted:
            return component
    return None


def retain_component_keys(previous: List[Dict[str, Any]], current: List[Dict[str, Any]]) -> None:
    """Adding another entity must not retarget saved component references."""
    by_entity = {item["entity_id"]: item for item in current}
    retained = set()
    used = set()
    for old in previous:
        entity_id, key = old.get("entity_id"), old.get("key")
        if entity_id in by_entity and key and key not in used:
            by_entity[entity_id]["key"] = key
            retained.add(entity_id)
            used.add(key)
    for item in current:
        if item["entity_id"] in retained:
            continue
        if item["key"] in used:
            suffix = hashlib.sha256(item["entity_id"].encode()).hexdigest()[:12]
            item["key"] = f"{item['domain']}_{suffix}"
        used.add(item["key"])
    current.sort(key=_component_sort_key)
