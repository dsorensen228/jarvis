"""The one provider-neutral smart-home service the rest of Jarvis talks to."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from jarvis_api.smarthome.client import HomeAssistantClient
from jarvis_api.smarthome.commands import (
    ACTION_CAPABILITIES,
    plan,
    select_component,
)
from jarvis_api.smarthome.discovery import group_by_device, primary_component, retain_component_keys
from jarvis_api.smarthome.model import (
    DOMAIN_MEDIA_PLAYER,
    MAIN_COMPONENT,
    PLATFORM,
    SmartHomeError,
    SmartHomeUnavailable,
    is_reachable,
    legacy_is_light,
    percent_from_brightness,
    power_from_state,
    rgb_from_attributes,
)

logger = logging.getLogger(__name__)

ENTITY_KIND = "smart_device"
MAX_DEVICES = 1000

# Fields the owner controls. Discovery must never clobber them.
USER_FIELDS = ("name", "room", "is_light", "component_labels", "primary_for_room")

# Fields discovery owns outright.
DISCOVERED_FIELDS = (
    "platform",
    "integration",
    "external_id",
    "ha_device_id",
    "source_name",
    "model",
    "manufacturer",
    "components",
    "capabilities",
)

LIGHT_CONTROL_CONCURRENCY = 8


class SmartHomeService:
    """Owns imported devices, their live state, and every control path."""

    def __init__(self, store: Any, client: HomeAssistantClient) -> None:
        self.store = store
        self.client = client

    @property
    def configured(self) -> bool:
        return self.client.configured

    # ---------------------------------------------------------------- status

    async def status(self, user_id: str) -> Dict[str, Any]:
        devices = await self._rows(user_id)
        status: Dict[str, Any] = {
            "platform": PLATFORM,
            "configured": self.configured,
            "connected": False,
            "device_count": len(devices),
            "imported_count": sum(1 for row in devices if row.get("components")),
            "orphaned_count": sum(1 for row in devices if not row.get("components")),
            "version": "",
            "error": "",
        }
        if not self.configured:
            status["error"] = "Home Assistant is not configured"
            return status
        try:
            status["version"] = await self.client.version()
            status["connected"] = True
        except SmartHomeError as exc:
            status["error"] = str(exc)
        return status

    # ------------------------------------------------------------------ sync

    async def sync(self, user_id: str) -> List[Dict[str, Any]]:
        """Import every supported Home Assistant device, preserving owner edits.

        Idempotent: a device already imported keeps its id, name, room, labels,
        and light membership, and a device Home Assistant can no longer see is
        retained and reported unavailable rather than dropped.
        """
        registry = await self.client.registry()
        states = await self.client.states()
        discovered = group_by_device(registry, states)

        existing = {row["id"]: row for row in await self._rows(user_id)}
        seen: List[str] = []

        for device in discovered:
            device_id = device.pop("id")
            seen.append(device_id)
            current = existing.get(device_id)
            payload = {key: device[key] for key in DISCOVERED_FIELDS if key in device}
            payload["platform"] = PLATFORM
            payload["light_scope_version"] = 1
            if current is None:
                await self._claim(user_id, device_id, device)
                await self.store.create_entity(
                    ENTITY_KIND,
                    user_id,
                    dict(payload, **self._defaults_for(device)),
                    entity_id=device_id,
                )
            else:
                retain_component_keys(current.get("components") or [], payload["components"])
                merged = self._carry_forward(current, payload)
                merged["is_light"] = self._resolve_is_light(current, device)
                await self.store.update_entity(ENTITY_KIND, device_id, user_id, merged)

        for device_id, row in existing.items():
            if device_id in seen or not row.get("components"):
                continue
            # Keep the record. A TV that is merely unplugged must not lose its
            # name, room, or the references that point at it.
            logger.info(
                "smart device %s is no longer reported by Home Assistant; retaining the record",
                row.get("name") or device_id,
            )
            await self.store.update_entity(
                ENTITY_KIND, device_id, user_id, {"ha_device_id": "", "components": []}
            )

        return await self.list_devices(user_id)

    async def _claim(self, user_id: str, device_id: str, device: Dict[str, Any]) -> None:
        """Fail clearly if another account already imported this device.

        Device ids are derived from the vendor id so that they survive the move to
        Home Assistant, which also means they are the same for every account. The
        store keys entities on ``(kind, id)``, so a second account importing the
        same device would otherwise hit a bare constraint violation.
        """
        existing = await self.store.get_entity(ENTITY_KIND, device_id)
        if existing is not None:
            raise SmartHomeError(
                "{} is already imported by another account".format(
                    device.get("source_name") or device_id
                )
            )

    def _defaults_for(self, device: Dict[str, Any]) -> Dict[str, Any]:
        name = str(device.get("source_name") or "")
        return {
            "name": name,
            "room": str(device.get("area") or ""),
            # A newly discovered switch is not swept into light control. Only an
            # explicit owner choice, or the migration of a device Jarvis already
            # treated as a light, sets this.
            "is_light": self._is_light_by_default(device),
            "component_labels": {},
        }

    @staticmethod
    def _is_light_by_default(device: Dict[str, Any]) -> bool:
        main = primary_component(device)
        return bool(main and main.get("domain") == "light")

    @staticmethod
    def _resolve_is_light(current: Dict[str, Any], device: Dict[str, Any]) -> bool:
        """Repair the initial migration once, then preserve the owner's choice."""
        if current.get("light_scope_version") == 1:
            return bool(current.get("is_light"))
        if SmartHomeService._is_light_by_default(device):
            return True
        sku = str(current.get("legacy_sku") or device.get("model") or "").strip()
        if sku == "H5083":
            return bool(current.get("is_light", True))
        if (
            current.get("legacy_provider") == "govee"
            or device.get("integration") == "govee_openapi"
        ):
            return legacy_is_light(
                {
                    "provider": "govee",
                    "sku": sku or current.get("legacy_sku"),
                    "legacy_capabilities": current.get("legacy_capabilities") or [],
                }
            )
        return bool(current.get("is_light"))

    @staticmethod
    def _carry_forward(current: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
        """Apply discovery without disturbing anything the owner set."""
        merged = dict(payload)
        for field in USER_FIELDS:
            if field in current:
                merged.pop(field, None)
        return merged

    # ------------------------------------------------------------------ read

    async def list_devices(self, user_id: str) -> List[Dict[str, Any]]:
        rows = await self._rows(user_id)
        states = await self._states_or_empty()
        return [self._present(row, states) for row in rows]

    async def get_device(self, user_id: str, device_id: str) -> Dict[str, Any]:
        row = await self.store.get_entity(ENTITY_KIND, device_id, user_id)
        if row is None:
            raise KeyError("smart device not found")
        return row

    async def device_state(self, user_id: str, device_id: str) -> Dict[str, Any]:
        row = await self.get_device(user_id, device_id)
        states = await self.client.states()
        return self._present(row, states)

    async def _rows(self, user_id: str) -> List[Dict[str, Any]]:
        return await self.store.list_entities(ENTITY_KIND, user_id, limit=MAX_DEVICES)

    async def _states_or_empty(self) -> Dict[str, Dict[str, Any]]:
        """A listing must still render when Home Assistant is down."""
        if not self.configured:
            return {}
        try:
            return await self.client.states()
        except SmartHomeError as exc:
            logger.warning("Home Assistant state read failed: %s", exc)
            return {}

    def _present(self, row: Dict[str, Any], states: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        labels = row.get("component_labels")
        labels = labels if isinstance(labels, dict) else {}
        components = []
        for component in row.get("components") or []:
            if not isinstance(component, dict):
                continue
            components.append(self._present_component(component, labels, states))
        powered = [item["power"] for item in components if item["power"] is not None]
        device = {
            "id": row["id"],
            "platform": row.get("platform") or PLATFORM,
            "integration": row.get("integration") or "",
            "external_id": row.get("external_id") or "",
            "name": row.get("name") or row.get("source_name") or row["id"],
            "source_name": row.get("source_name") or "",
            "room": row.get("room") or "",
            "model": row.get("model") or "",
            "manufacturer": row.get("manufacturer") or "",
            "is_light": bool(row.get("is_light")),
            "capabilities": list(row.get("capabilities") or []),
            "components": components,
            "available": any(item["available"] for item in components),
            "power": (any(powered) if powered else None),
        }
        if row.get("primary_for_room") is not None:
            device["primary_for_room"] = bool(row.get("primary_for_room"))
        return device

    @staticmethod
    def _present_component(
        component: Dict[str, Any],
        labels: Dict[str, Any],
        states: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Any]:
        entity_id = str(component.get("entity_id") or "")
        key = str(component.get("key") or MAIN_COMPONENT)
        state = states.get(entity_id) or {}
        raw_state = str(state.get("state") or "")
        attributes = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}
        reachable = bool(state) and is_reachable(raw_state)
        presented: Dict[str, Any] = {
            "key": key,
            "entity_id": entity_id,
            "domain": component.get("domain") or "",
            "name": str(labels.get(key) or component.get("name") or ""),
            "default_name": component.get("name") or "",
            "capabilities": list(component.get("capabilities") or []),
            "available": reachable,
            "power": power_from_state(raw_state) if reachable else None,
        }
        if component.get("min_kelvin") is not None:
            presented["min_kelvin"] = component.get("min_kelvin")
            presented["max_kelvin"] = component.get("max_kelvin")
        if not reachable:
            return presented
        brightness = percent_from_brightness(attributes.get("brightness"))
        if brightness is not None:
            presented["brightness_percent"] = brightness
        color = rgb_from_attributes(attributes)
        if color is not None:
            presented["color"] = color
        if attributes.get("color_temp_kelvin") is not None:
            presented["kelvin"] = attributes.get("color_temp_kelvin")
        if attributes.get("is_volume_muted") is not None:
            presented["muted"] = bool(attributes.get("is_volume_muted"))
        if attributes.get("source") is not None:
            presented["app"] = str(attributes.get("source"))
        if isinstance(attributes.get("source_list"), list):
            presented["apps"] = [str(item) for item in attributes["source_list"]]
        if component.get("domain") == DOMAIN_MEDIA_PLAYER:
            presented["playback_state"] = raw_state
        return presented

    # --------------------------------------------------------------- control

    async def control_device(
        self,
        user_id: str,
        device_id: str,
        action: str,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        row = await self.get_device(user_id, device_id)
        return await self._apply(row, action, dict(parameters or {}))

    async def _apply(
        self,
        row: Dict[str, Any],
        action: str,
        parameters: Dict[str, Any],
        states: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        normalized = str(action or "").strip().lower()
        if normalized not in ACTION_CAPABILITIES:
            raise SmartHomeError(f"unsupported smart-home action: {action}")
        if not row.get("components"):
            raise SmartHomeUnavailable(
                "{} is not currently provided by Home Assistant".format(
                    row.get("name") or row["id"]
                )
            )
        component_key = str(parameters.pop("component", "") or "").strip()
        component = select_component(row, normalized, component_key)

        # HA accepts service calls targeting unloaded/unavailable entities with
        # HTTP 200, but skips execution. Do not report that no-op as success.
        if states is None:
            states = await self.client.states()
        state = states.get(str(component.get("entity_id") or "")) or {}
        if not state or state.get("state") == "unavailable":
            raise SmartHomeUnavailable(
                "{} is unavailable in Home Assistant".format(row.get("name") or row["id"])
            )
        attributes = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}

        call, outcome = plan(component, normalized, parameters, attributes)
        await self.client.call_service(call.domain, call.service, call.data)
        return {
            "device_id": row["id"],
            "device": row.get("name") or row["id"],
            "component": component.get("key"),
            "entity_id": component.get("entity_id"),
            "action": normalized,
            "accepted": True,
            **outcome,
        }

    # ----------------------------------------------------------- light scope

    async def control_lights(
        self,
        user_id: str,
        scope: str,
        selector: str,
        action: str,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        rows = [row for row in await self._rows(user_id) if row.get("is_light")]
        targets = select_lights(rows, scope, selector)
        states = await self.client.states()
        semaphore = asyncio.Semaphore(LIGHT_CONTROL_CONCURRENCY)
        payload = dict(parameters or {})

        async def apply(row: Dict[str, Any]) -> Dict[str, Any]:
            async with semaphore:
                label = row.get("name") or row["id"]
                try:
                    await self._apply(row, action, dict(payload), states)
                    return {"device": label}
                except Exception as exc:  # noqa: BLE001 - reported per device
                    return {"device": label, "error": str(exc)[:300]}

        outcomes = await asyncio.gather(*(apply(row) for row in targets))
        succeeded = [item for item in outcomes if "error" not in item]
        failed = [item for item in outcomes if "error" in item]
        if not succeeded:
            detail = failed[0]["error"] if failed else "no matching lights"
            raise SmartHomeUnavailable(f"none of the selected lights responded: {detail}")
        return {
            "scope": scope,
            "selector": selector,
            "action": action,
            "succeeded": len(succeeded),
            "failed": len(failed),
            "devices": [item["device"] for item in succeeded],
            "errors": [item["error"] for item in failed],
        }

    async def control_room_lights_for_device(
        self, user_id: str, jarvis_device_id: Optional[str], action: str
    ) -> Dict[str, Any]:
        """Resolve the calling Jarvis device's room and control that room's lights."""
        clean_device_id = str(jarvis_device_id or "").strip()
        if not clean_device_id:
            raise SmartHomeError("calling Jarvis device id is required")
        device = await self.store.get_entity("device", clean_device_id, user_id)
        if device is None:
            raise KeyError("calling Jarvis device is not registered")
        room = str(device.get("room") or "").strip()
        if not room:
            raise SmartHomeError("calling Jarvis device has no room assigned")
        return await self.control_lights(user_id, "room", room, action, {})

    async def room_lights_power(self, user_id: str, room: str) -> Dict[str, Any]:
        """Aggregate light power for one room, for the touchscreen toggle."""
        wanted = str(room or "").strip().casefold()
        states = await self._states_or_empty()
        lights = [
            self._present(row, states)
            for row in await self._rows(user_id)
            if row.get("is_light") and str(row.get("room") or "").strip().casefold() == wanted
        ]
        known = [device["power"] for device in lights if device["power"] is not None]
        return {
            "room": room,
            "count": len(lights),
            "is_on": (any(known) if known else None),
            "unknown": len(lights) - len(known),
        }

    # -------------------------------------------------------- media routing

    async def resolve_room_display(self, user_id: str, room: str) -> Optional[Dict[str, Any]]:
        """The display a room's requests should go to.

        An explicit ``primary_for_room`` wins; otherwise the first media device
        assigned to that room does, matched case-insensitively so the phone, the
        touchscreen, and the agent all pick the same TV.
        """
        wanted = str(room or "").strip().casefold()
        if not wanted:
            return None
        states = await self._states_or_empty()
        candidates = []
        for row in await self._rows(user_id):
            if str(row.get("room") or "").strip().casefold() != wanted:
                continue
            device = self._present(row, states)
            if any(
                component["domain"] == DOMAIN_MEDIA_PLAYER for component in device["components"]
            ):
                candidates.append((not bool(row.get("primary_for_room")), device["name"], device))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (item[0], item[1].casefold()))
        return candidates[0][2]


def select_lights(lights: List[Dict[str, Any]], scope: str, selector: str) -> List[Dict[str, Any]]:
    """Resolve a light scope exactly as Jarvis always has."""
    clean_scope = str(scope or "").strip().lower()
    clean_selector = str(selector or "").strip().casefold()
    if clean_scope == "all":
        matches = lights
    elif clean_scope == "room":
        if not clean_selector:
            raise SmartHomeError("room name is required")
        exact = [
            row for row in lights if str(row.get("room") or "").strip().casefold() == clean_selector
        ]
        if exact:
            matches = exact
        else:
            room_names = {
                str(row.get("room") or "").strip()
                for row in lights
                if clean_selector in str(row.get("room") or "").casefold()
            }
            if len(room_names) > 1:
                raise SmartHomeError("room name is ambiguous: " + ", ".join(sorted(room_names)))
            matches = [row for row in lights if str(row.get("room") or "").strip() in room_names]
    elif clean_scope == "device":
        if not clean_selector:
            raise SmartHomeError("device name or id is required")
        exact = [
            row
            for row in lights
            if clean_selector
            in {
                str(row.get("id") or "").casefold(),
                str(row.get("name") or "").strip().casefold(),
                str(row.get("source_name") or "").strip().casefold(),
            }
        ]
        matches = exact or [
            row
            for row in lights
            if clean_selector in str(row.get("name") or "").casefold()
            or clean_selector in str(row.get("source_name") or "").casefold()
        ]
        if len(matches) > 1:
            raise SmartHomeError(
                "light name is ambiguous: "
                + ", ".join(str(row.get("name") or row["id"]) for row in matches)
            )
    else:
        raise SmartHomeError("light scope must be device, room, or all")
    if not matches:
        raise SmartHomeError(f"no lights matched {selector or scope!r}")
    return matches
