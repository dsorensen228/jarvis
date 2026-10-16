"""Home Assistant adapter: the only place that knows Home Assistant exists."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from websockets.exceptions import WebSocketException
from websockets.legacy.client import connect

from jarvis_api.smarthome.model import SmartHomeError, SmartHomeUnavailable

logger = logging.getLogger(__name__)

# One render returns the whole entity-to-device join, including the vendor
# identifiers that let a migration keep existing Jarvis device ids. Reading the
# registries any other way would need the WebSocket API.
_REGISTRY_TEMPLATE = """
[
{%- set domains = ['light', 'switch', 'media_player', 'remote'] -%}
{%- set ns = namespace(first=true) -%}
{%- for s in states if s.domain in domains -%}
{%- if not ns.first %},{% endif %}{% set ns.first = false %}
{
"entity_id": {{ s.entity_id | tojson }},
"friendly_name": {{ s.name | tojson }},
"device_id": {{ device_id(s.entity_id) | tojson }},
"device_name": {{ device_attr(s.entity_id, 'name') | tojson }},
"model": {{ device_attr(s.entity_id, 'model') | tojson }},
"manufacturer": {{ device_attr(s.entity_id, 'manufacturer') | tojson }},
"identifiers": {{ (device_attr(s.entity_id, 'identifiers') | default([], true) | list) | tojson }},
"area": {{ area_name(s.entity_id) | tojson }}
}
{%- endfor -%}
]
"""


def _server_error(response: httpx.Response) -> str:
    """The most specific description of a 5xx that the body offers."""
    detail = ""
    try:
        payload = response.json()
    except ValueError:
        detail = response.text.strip()
    else:
        if isinstance(payload, dict):
            detail = str(payload.get("message") or payload.get("error") or "").strip()
        elif isinstance(payload, str):
            detail = payload.strip()
    detail = " ".join(detail.split())[:200]
    if not detail:
        return f"Home Assistant returned {response.status_code}"
    return f"Home Assistant could not complete the request: {detail}"


class HomeAssistantClient:
    """Bounded REST access to Home Assistant's states, registries, and services."""

    def __init__(
        self,
        base_url: str,
        token: str,
        http_client: httpx.AsyncClient,
        timeout: float = 10.0,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self._token = token or ""
        self._http = http_client
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self._token)

    def _require(self) -> None:
        if not self.configured:
            raise SmartHomeError(
                "Home Assistant is not configured; set JARVIS_HOME_ASSISTANT_URL and "
                "JARVIS_HOME_ASSISTANT_TOKEN"
            )

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        self._require()
        try:
            response = await self._http.request(
                method,
                f"{self.base_url}{path}",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout,
                **kwargs,
            )
        except httpx.TimeoutException as exc:
            raise SmartHomeUnavailable("Home Assistant did not respond in time") from exc
        except httpx.HTTPError as exc:
            raise SmartHomeUnavailable(f"Home Assistant is unreachable: {exc}") from exc
        if response.status_code in (401, 403):
            raise SmartHomeError("Home Assistant rejected the Jarvis access token")
        if response.status_code == 404:
            raise SmartHomeError(f"Home Assistant has no such entity or service: {path}")
        if response.status_code >= 500:
            # A service call that fails inside an integration surfaces here, and the
            # body carries the only description of why: "Device is offline", a bad
            # value, a vendor cloud outage. Dropping it leaves a bare status code.
            raise SmartHomeUnavailable(_server_error(response))
        if response.status_code >= 400:
            detail = response.text[:300]
            raise SmartHomeError(
                f"Home Assistant rejected the request ({response.status_code}): {detail}"
            )
        return response

    async def version(self) -> str:
        response = await self._request("GET", "/api/config")
        payload = response.json()
        return str(payload.get("version") or "") if isinstance(payload, dict) else ""

    async def states(self) -> Dict[str, Dict[str, Any]]:
        """Every entity state in one call, keyed by entity id."""
        response = await self._request("GET", "/api/states")
        payload = response.json()
        if not isinstance(payload, list):
            raise SmartHomeError("Home Assistant returned an unexpected state payload")
        result: Dict[str, Dict[str, Any]] = {}
        for entry in payload:
            if isinstance(entry, dict) and isinstance(entry.get("entity_id"), str):
                result[entry["entity_id"]] = entry
        return result

    async def registry(self) -> List[Dict[str, Any]]:
        """Entity-to-device rows for every supported domain."""
        response = await self._request(
            "POST", "/api/template", json={"template": _REGISTRY_TEMPLATE}
        )
        # The template endpoint answers with rendered text, not a JSON content type.
        try:
            rows = json.loads(response.text)
        except ValueError as exc:
            raise SmartHomeError("Home Assistant returned an unreadable registry") from exc
        if not isinstance(rows, list):
            raise SmartHomeError("Home Assistant returned an unexpected registry payload")
        rows = [row for row in rows if isinstance(row, dict) and row.get("entity_id")]
        roku_devices = {
            row.get("device_id")
            for row in rows
            if any(pair[0] == "roku" for pair in row.get("identifiers") or [])
        }
        if roku_devices:
            # The REST state attributes omit unique ids. Use the entity registry
            # to identify this diagnostic even after the owner renames it; never
            # guess a capability from an entity id or its translated label.
            try:
                entities = await asyncio.wait_for(self._entity_registry(), self._timeout)
            except (SmartHomeError, asyncio.TimeoutError, OSError, WebSocketException, ValueError):
                logger.warning("Home Assistant Roku diagnostics are unavailable")
            else:
                find_remote = {
                    item.get("device_id"): item["entity_id"]
                    for item in entities
                    if item.get("device_id") in roku_devices
                    and item.get("platform") == "roku"
                    and str(item.get("entity_id") or "").startswith("binary_sensor.")
                    and str(item.get("unique_id") or "").endswith("_supports_find_remote")
                    and not item.get("disabled_by")
                }
                for row in rows:
                    if row.get("device_id") in find_remote:
                        row["find_remote_entity_id"] = find_remote[row["device_id"]]
        return rows

    async def _entity_registry(self) -> List[Dict[str, Any]]:
        url = self.base_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        async with connect(f"{url}/api/websocket", open_timeout=self._timeout) as socket:
            hello = json.loads(await socket.recv())
            if hello.get("type") != "auth_required":
                raise SmartHomeError("Home Assistant did not start authentication")
            await socket.send(json.dumps({"type": "auth", "access_token": self._token}))
            authenticated = json.loads(await socket.recv())
            if authenticated.get("type") != "auth_ok":
                raise SmartHomeError("Home Assistant rejected the Jarvis access token")
            await socket.send(json.dumps({"id": 1, "type": "config/entity_registry/list"}))
            message = json.loads(await socket.recv())
            if message.get("id") != 1 or not message.get("success"):
                raise SmartHomeError("Home Assistant could not read the entity registry")
            result = message.get("result")
            if not isinstance(result, list):
                raise SmartHomeError("Home Assistant returned an unexpected entity registry")
            return [item for item in result if isinstance(item, dict)]

    async def call_service(
        self, domain: str, service: str, data: Optional[Dict[str, Any]] = None
    ) -> None:
        await self._request(
            "POST",
            f"/api/services/{domain}/{service}",
            json=dict(data or {}),
        )
