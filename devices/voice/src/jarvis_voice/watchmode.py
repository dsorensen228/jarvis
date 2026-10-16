"""Resolve movies and shows to preferred streaming links with Watchmode."""

from __future__ import annotations

import re
from typing import Any

import httpx

API_BASE = "https://api.watchmode.com/v1"
SOURCE_TYPE_PRIORITY = {"sub": 0, "free": 1, "tve": 2, "rent": 3, "buy": 4}

# Canonical service ids for preferred-source matching. Watchmode labels vary
# ("AppleTV+", "HBO Max", "Prime Video") and spoken/config names differ again.
_SERVICE_ALIASES = {
    "netflix": "netflix",
    "hulu": "hulu",
    "max": "max",
    "hbomax": "max",
    "hbo": "max",
    "primevideo": "prime",
    "amazonprimevideo": "prime",
    "amazonprime": "prime",
    "prime": "prime",
    "disneyplus": "disney",
    "disney": "disney",
    "peacock": "peacock",
    "paramountplus": "paramount",
    "paramount": "paramount",
    "appletvplus": "appletv+",
    "appletv": "appletv+",
}


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().casefold())


def _compact(value: str) -> str:
    """Collapse a service label to alphanumerics plus '+' for alias lookup."""
    return re.sub(r"[^a-z0-9+]+", "", _normalized(value).replace("＋", "+"))


def _canonical_service(name: str) -> str | None:
    compact = _compact(name)
    if compact in _SERVICE_ALIASES:
        return _SERVICE_ALIASES[compact]
    # Strip trailing + and retry (AppleTV+ → appletv already covered; Disney+ too).
    if compact.endswith("+") and compact[:-1] in _SERVICE_ALIASES:
        return _SERVICE_ALIASES[compact[:-1]]
    return None


def _source_service(name: str) -> tuple[str | None, int]:
    """Return (canonical service, delivery rank) for a Watchmode source label.

    Delivery rank: 0 = direct app/site, 1 = partner add-on / channel bundle.
    Partner rows such as "HBO (Via Hulu)" belong to Max, not Hulu, so a Hulu
    preference does not steal Max titles before Max is considered.
    """
    label = _normalized(name)
    delivery = 0
    service_label = label
    via = re.search(r"\((?:via|on)\s+([^)]+)\)", label)
    if via:
        delivery = 1
        service_label = label[: via.start()].strip(" -")
    elif " channel" in label or label.endswith(" channel"):
        delivery = 1
        service_label = re.sub(r"\s+amazon\s+channel$", "", label)
        service_label = re.sub(r"\s+channel$", "", service_label)
    return _canonical_service(service_label), delivery


def _title(payload: dict[str, Any], query: str) -> dict[str, Any]:
    rows = payload.get("title_results") or payload.get("results") or []
    valid = [
        row
        for row in rows
        if isinstance(row, dict) and row.get("id") and str(row.get("name") or "").strip()
    ]
    requested_year = re.search(r"\b(19|20)\d{2}\b", query)
    if requested_year:
        year_matches = [
            row for row in valid if str(row.get("year") or "") == requested_year.group(0)
        ]
        if year_matches:
            valid = year_matches
    title_query = re.sub(r"\b(19|20)\d{2}\b", "", query).strip()
    exact = [row for row in valid if _normalized(str(row["name"])) == _normalized(title_query)]
    candidates = exact or valid
    if not candidates:
        raise RuntimeError(f"No streaming title found for {query!r}")
    # Watchmode orders search results by relevance; prefer that ranking for spoken
    # requests instead of forcing an awkward clarification for remakes and namesakes.
    return candidates[0]


def _source(rows: list[dict[str, Any]], preferred_sources: tuple[str, ...]) -> dict[str, Any]:
    usable = [row for row in rows if row.get("name") and row.get("web_url")]
    parsed: list[tuple[dict[str, Any], str | None, int]] = [
        (row, *_source_service(str(row["name"]))) for row in usable
    ]
    for preferred in preferred_sources:
        wanted = _canonical_service(preferred)
        if not wanted:
            # Fall back to substring match for unknown preferred labels.
            needle = _normalized(preferred)
            matches = [
                row
                for row, _, _ in parsed
                if needle in _normalized(str(row["name"]))
                or _normalized(str(row["name"])) in needle
            ]
        else:
            matches = [row for row, service, _ in parsed if service == wanted]
        if not matches:
            continue
        delivery = {id(row): rank for row, service, rank in parsed if row in matches}

        def _rank(row: dict[str, Any]) -> tuple[int, int]:
            return (
                delivery.get(id(row), 9),
                SOURCE_TYPE_PRIORITY.get(str(row.get("type") or "").casefold(), 50),
            )

        return min(matches, key=_rank)
    available = ", ".join(dict.fromkeys(str(row["name"]) for row in usable[:12]))
    raise RuntimeError(
        "Title is not on a preferred streaming service"
        + (f"; available sources: {available}" if available else "")
    )


async def resolve_streaming_url(
    api_key: str,
    query: str,
    *,
    region: str,
    preferred_sources: tuple[str, ...],
) -> dict[str, Any]:
    query = query.strip()
    if not api_key:
        raise RuntimeError("Watchmode is not configured on this Jarvis device")
    if not query:
        raise ValueError("streaming title is required")
    async with httpx.AsyncClient(timeout=20.0) as client:
        search = await client.get(
            f"{API_BASE}/search/",
            params={
                "apiKey": api_key,
                "search_field": "name",
                "search_value": query,
                "types": "movie,tv_series,tv_miniseries,short_film",
            },
        )
        search.raise_for_status()
        title = _title(search.json(), query)
        sources = await client.get(
            f"{API_BASE}/title/{int(title['id'])}/sources/",
            params={"apiKey": api_key, "regions": region},
        )
        sources.raise_for_status()
    payload = sources.json()
    rows = payload if isinstance(payload, list) else payload.get("sources", [])
    source = _source([row for row in rows if isinstance(row, dict)], preferred_sources)
    return {
        "title": str(title["name"]),
        "year": title.get("year"),
        "source": str(source["name"]),
        "source_type": str(source.get("type") or ""),
        "url": str(source["web_url"]),
    }
