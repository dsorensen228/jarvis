"""Reshape vendor-specific smart-device rows onto the neutral model.

Device ids are already derived from the vendor name plus the vendor's own id, and
:func:`jarvis_api.smarthome.discovery.stable_device_id` reproduces that, so no row
is ever re-keyed. This module only rewrites the *shape* of a row: it moves the
Govee and Roku fields into explicit migration metadata and records whether Jarvis
used to treat the device as a light.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from jarvis_api.smarthome.model import PLATFORM, legacy_is_light
from jarvis_api.smarthome.service import ENTITY_KIND, MAX_DEVICES

logger = logging.getLogger(__name__)

LEGACY_PROVIDERS = frozenset({"govee", "roku"})

# Vendor fields that only exist to explain where a device came from.
LEGACY_FIELD_MAP = {
    "capabilities": "legacy_capabilities",
    "sku": "legacy_sku",
    "host": "legacy_host",
    "port": "legacy_port",
    "model": "legacy_model",
    "wifi_mac": "legacy_wifi_mac",
    "ethernet_mac": "legacy_ethernet_mac",
}


def needs_migration(row: Dict[str, Any]) -> bool:
    return not row.get("platform") and str(row.get("provider") or "") in LEGACY_PROVIDERS


def migrate_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Pure transform of one legacy row, so it can be tested without a store."""
    if not needs_migration(row):
        # Already on the neutral model, or never a vendor row. Re-running must not
        # reset ``is_light`` or discard the metadata an earlier pass recorded.
        return dict(row)
    provider = str(row.get("provider") or "")
    migrated = dict(row)
    migrated.pop("provider", None)
    for source, destination in LEGACY_FIELD_MAP.items():
        if source in migrated:
            value = migrated.pop(source)
            if value not in (None, "", [], {}):
                migrated[destination] = value

    migrated["platform"] = PLATFORM
    migrated["legacy_provider"] = provider
    migrated["is_light"] = legacy_is_light({**row, "provider": provider})
    # Discovery fills these in the moment Home Assistant reports the device.
    migrated["integration"] = ""
    migrated["ha_device_id"] = ""
    migrated["components"] = []
    migrated["capabilities"] = []
    migrated.setdefault("component_labels", {})
    migrated.setdefault("source_name", migrated.get("name") or "")
    return migrated


async def migrate_user(store: Any, user_id: str) -> Dict[str, Any]:
    """Migrate one owner's smart devices. Safe to run repeatedly."""
    rows: List[Dict[str, Any]] = await store.list_entities(ENTITY_KIND, user_id, limit=MAX_DEVICES)
    pending = [row for row in rows if needs_migration(row)]
    for row in pending:
        await store.mutate_entity(
            ENTITY_KIND,
            row["id"],
            user_id,
            lambda current: migrate_row(current),
        )
    if pending:
        logger.info(
            "migrated %d legacy smart devices to the Home Assistant model for %s",
            len(pending),
            user_id,
        )
    return {
        "examined": len(rows),
        "migrated": len(pending),
        "already_migrated": sum(1 for row in rows if row.get("platform") == PLATFORM),
    }


async def migrate_all(store: Any) -> Dict[str, Any]:
    """Migrate every owner. Ownership isolation is preserved per row."""
    rows = await store.list_all_entities(ENTITY_KIND, limit=MAX_DEVICES * 10)
    owners = sorted({str(row.get("owner_id") or "") for row in rows if row.get("owner_id")})
    totals = {"examined": 0, "migrated": 0, "already_migrated": 0, "owners": len(owners)}
    for owner_id in owners:
        result = await migrate_user(store, owner_id)
        for key in ("examined", "migrated", "already_migrated"):
            totals[key] += result[key]
    return totals
