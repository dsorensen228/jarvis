"""External factual search and weather clients used by the local Jarvis agent."""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List
from urllib.parse import quote

import httpx

from jarvis_api.config import Settings

logger = logging.getLogger(__name__)

WEB_ANSWER_INSTRUCTION = (
    "Answer the question directly. Be concise: 3-4 sentences maximum. "
    "Do not add an offer to help or a follow-up question."
)


class KnowledgeClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings = settings
        self.client = client

    async def search_web(self, query: str, limit: int = 5) -> Dict[str, Any]:
        clean_query = query.strip()
        if not clean_query:
            raise ValueError("web search query cannot be empty")
        if self.settings.openai_api_key:
            try:
                return await self._search_web_with_openai(clean_query)
            except (httpx.HTTPError, RuntimeError, ValueError) as exc:
                logger.warning("OpenAI web search failed; falling back to Tavily: %s", exc)
        if not self.settings.tavily_api_key:
            raise RuntimeError("neither OpenAI nor Tavily web search is configured")
        response = await self.client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": self.settings.tavily_api_key,
                "query": f"{clean_query}\n\n{WEB_ANSWER_INSTRUCTION}",
                "search_depth": "basic",
                "include_answer": True,
                "include_raw_content": False,
                "max_results": max(1, min(10, int(limit))),
            },
        )
        response.raise_for_status()
        payload = response.json()
        return {
            "answer": payload.get("answer"),
            "results": [
                {
                    "title": str(row.get("title") or "")[:300],
                    "url": str(row.get("url") or "")[:2000],
                    "content": str(row.get("content") or "")[:2000],
                }
                for row in payload.get("results", [])[:10]
                if isinstance(row, dict)
            ],
            "provider": "tavily",
        }

    async def _search_web_with_openai(self, query: str) -> Dict[str, Any]:
        response = await self.client.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
            json={
                "model": self.settings.openai_web_model,
                "tools": [{"type": "web_search"}],
                "input": (
                    "Use live web search when needed. Return only the answer that should be read "
                    "aloud; do not include a source list or raw URLs.\n\n"
                    f"Question: {query}\n\n{WEB_ANSWER_INSTRUCTION}"
                ),
            },
        )
        response.raise_for_status()
        payload = response.json()
        answer = self._openai_response_text(payload)
        if not answer:
            raise RuntimeError("OpenAI web search returned an empty answer")
        return {
            "answer": answer,
            "results": [
                {"title": "", "url": url, "content": ""} for url in self._response_urls(payload)
            ],
            "provider": "openai",
        }

    @staticmethod
    def _openai_response_text(payload: Dict[str, Any]) -> str:
        direct = payload.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        chunks: List[str] = []
        for item in payload.get("output", []):
            if not isinstance(item, dict):
                continue
            for part in item.get("content", []):
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if part.get("type") in {"output_text", "text"} and isinstance(text, str):
                    if text.strip():
                        chunks.append(text.strip())
        return "\n\n".join(chunks)

    @staticmethod
    def _response_urls(payload: Any) -> List[str]:
        urls: List[str] = []

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"url", "link", "href"} and isinstance(child, str):
                        if child.startswith(("http://", "https://")) and child not in urls:
                            urls.append(child)
                    else:
                        walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(payload.get("output", []) if isinstance(payload, dict) else payload)
        return urls[:20]

    async def search_wiki(
        self, query: str, *, wookieepedia: bool = False, limit: int = 5
    ) -> List[Dict[str, Any]]:
        api = (
            "https://starwars.fandom.com/api.php"
            if wookieepedia
            else "https://en.wikipedia.org/w/api.php"
        )
        response = await self.client.get(
            api,
            params={
                "action": "query",
                "list": "search",
                "srsearch": query.strip(),
                "srlimit": max(1, min(10, int(limit))),
                "format": "json",
                "origin": "*",
            },
        )
        response.raise_for_status()
        base = (
            "https://starwars.fandom.com/wiki/"
            if wookieepedia
            else "https://en.wikipedia.org/wiki/"
        )
        return [
            {
                "title": str(row.get("title") or ""),
                "url": base + quote(str(row.get("title") or "").replace(" ", "_")),
                "snippet": str(row.get("snippet") or "")[:1000],
            }
            for row in response.json().get("query", {}).get("search", [])
            if isinstance(row, dict)
        ]

    async def search_stackoverflow(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        response = await self.client.get(
            "https://api.stackexchange.com/2.3/search",
            params={
                "order": "desc",
                "sort": "relevance",
                "intitle": query.strip(),
                "site": "stackoverflow",
                "pagesize": max(1, min(10, int(limit))),
            },
        )
        response.raise_for_status()
        return [
            {
                "title": str(row.get("title") or ""),
                "url": str(row.get("link") or ""),
                "score": int(row.get("score") or 0),
                "answered": bool(row.get("is_answered")),
            }
            for row in response.json().get("items", [])
            if isinstance(row, dict)
        ]

    async def search_star_wars(self, query: str) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        for resource in ("people", "films", "planets", "species", "starships", "vehicles"):
            response = await self.client.get(
                f"https://swapi.dev/api/{resource}/",
                params={"search": query.strip()},
            )
            response.raise_for_status()
            for row in response.json().get("results", [])[:2]:
                if isinstance(row, dict):
                    results.append(
                        {
                            "resource": resource,
                            **{
                                key: value
                                for key, value in row.items()
                                if key not in {"url", "created", "edited"}
                                and not isinstance(value, list)
                            },
                        }
                    )
        return results[:10]

    async def weather_locations(self, query: str = "") -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for name in self._geocoding_queries(
            query.strip() or self.settings.weather_default_location
        ):
            response = await self.client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={
                    "name": name,
                    "count": 10,
                    "language": "en",
                    "format": "json",
                },
            )
            response.raise_for_status()
            rows = [row for row in response.json().get("results", []) if isinstance(row, dict)]
            if rows:
                break
        return [
            {
                "key": "{:.6f},{:.6f}".format(float(row["latitude"]), float(row["longitude"])),
                "name": str(row.get("name") or ""),
                "region": str(row.get("admin1") or ""),
                "country": str(row.get("country") or ""),
                "timezone": str(row.get("timezone") or ""),
            }
            for row in rows
            if row.get("latitude") is not None and row.get("longitude") is not None
        ]

    @staticmethod
    def _geocoding_queries(query: str) -> List[str]:
        """Return a full query plus a city-only fallback for city/state/postcode input."""
        full = " ".join(query.strip().split())
        if not full:
            return []
        city = re.sub(r"\s+\d{5}(?:-\d{4})?$", "", full).strip(" ,")
        city = re.sub(r"(?:,\s*|\s+)[A-Za-z]{2}$", "", city).strip(" ,")
        if "," in city:
            city = city.split(",", 1)[0].strip()
        return [full] if not city or city.casefold() == full.casefold() else [full, city]

    async def weather_current(self, location_key: str) -> Any:
        latitude, longitude = self._coordinates(location_key)
        response = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "current": (
                    "temperature_2m,apparent_temperature,is_day,precipitation,rain,showers,"
                    "snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m"
                ),
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "precipitation_unit": "inch",
                "timezone": "auto",
            },
        )
        response.raise_for_status()
        return response.json()

    async def weather_forecast(self, location_key: str, kind: str = "daily") -> Any:
        latitude, longitude = self._coordinates(location_key)
        clean_kind = kind.strip().lower()
        if clean_kind == "hourly":
            variables = {
                "hourly": (
                    "temperature_2m,apparent_temperature,precipitation_probability,"
                    "precipitation,weather_code,cloud_cover,wind_speed_10m"
                ),
                "forecast_hours": 12,
            }
        elif clean_kind == "daily":
            variables = {
                "daily": (
                    "weather_code,temperature_2m_max,temperature_2m_min,"
                    "apparent_temperature_max,apparent_temperature_min,sunrise,sunset,"
                    "precipitation_sum,precipitation_probability_max,wind_speed_10m_max"
                ),
                "forecast_days": 5,
            }
        else:
            raise ValueError("forecast kind must be daily or hourly")
        response = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude,
                "longitude": longitude,
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "precipitation_unit": "inch",
                "timezone": "auto",
                **variables,
            },
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _coordinates(location_key: str) -> Any:
        try:
            latitude_text, longitude_text = location_key.strip().split(",", 1)
            latitude, longitude = float(latitude_text), float(longitude_text)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError(
                "location_key must be the value returned by weather_search_locations"
            ) from exc
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise ValueError("location_key contains invalid coordinates")
        return latitude, longitude
