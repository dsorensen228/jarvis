"""Deterministic date and time operations for Jarvis tools."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from dateutil import parser, tz

WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


def _zone(name: str):
    zone = tz.gettz(name)
    if zone is None:
        raise ValueError(f"unknown IANA timezone {name!r}")
    return zone


def _aware(text: str, assume_timezone: str) -> datetime:
    value = parser.parse(text.strip(), fuzzy=True)
    if value.tzinfo is None:
        value = value.replace(tzinfo=_zone(assume_timezone))
    return value


def current_datetime(iana_timezone: str) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).astimezone(_zone(iana_timezone))
    return _snapshot(now, iana_timezone)


def parse_datetime(text: str, assume_timezone: str) -> Dict[str, Any]:
    value = _aware(text, assume_timezone)
    return _snapshot(value, assume_timezone)


def diff_datetimes(iso_a: str, iso_b: str, assume_timezone: str) -> Dict[str, Any]:
    first = _aware(iso_a, assume_timezone)
    second = _aware(iso_b, assume_timezone)
    seconds = (second - first).total_seconds()
    return {
        "seconds": seconds,
        "minutes": seconds / 60,
        "hours": seconds / 3600,
        "days": seconds / 86400,
    }


def add_duration(
    *,
    base_iso: Optional[str],
    iana_timezone: str,
    weeks: int,
    days: int,
    hours: int,
    minutes: int,
) -> Dict[str, Any]:
    base = (
        _aware(base_iso, iana_timezone)
        if base_iso
        else datetime.now(timezone.utc).astimezone(_zone(iana_timezone))
    )
    result = base + timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes)
    return {"base": _snapshot(base, iana_timezone), "result": _snapshot(result, iana_timezone)}


def next_weekday(
    weekday: str,
    *,
    iana_timezone: str,
    reference_iso: Optional[str],
    inclusive: bool,
) -> Dict[str, Any]:
    key = weekday.strip().casefold()
    if key not in WEEKDAYS:
        raise ValueError("weekday must be Monday through Sunday")
    reference = (
        _aware(reference_iso, iana_timezone)
        if reference_iso
        else datetime.now(timezone.utc).astimezone(_zone(iana_timezone))
    )
    difference = (WEEKDAYS[key] - reference.weekday()) % 7
    if difference == 0 and not inclusive:
        difference = 7
    result = reference + timedelta(days=difference)
    return {
        "date": result.date().isoformat(),
        "weekday": result.strftime("%A"),
        "timezone": iana_timezone,
    }


def convert_timezone(
    iso_datetime: str, target_timezone: str, assume_timezone: str
) -> Dict[str, Any]:
    value = _aware(iso_datetime, assume_timezone).astimezone(_zone(target_timezone))
    return _snapshot(value, target_timezone)


def _snapshot(value: datetime, zone_name: str) -> Dict[str, Any]:
    local = value.astimezone(_zone(zone_name))
    return {
        "timezone": zone_name,
        "iso_local": local.isoformat(),
        "iso_utc": local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "date": local.date().isoformat(),
        "time": local.time().isoformat(timespec="seconds"),
        "weekday": local.strftime("%A"),
        "unix_ms": int(local.timestamp() * 1000),
    }
