"""Local Chromium tab control through its loopback-only DevTools endpoint."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx


class BrowserController:
    def __init__(
        self,
        debug_url: str = "http://127.0.0.1:9222",
        ui_origin: str = "http://127.0.0.1:8765",
    ) -> None:
        self._ui_origin = ui_origin.rstrip("/")
        self._http = httpx.AsyncClient(base_url=debug_url, timeout=5.0)

    async def close(self) -> None:
        await self._http.aclose()

    async def close_external_tabs(self) -> int:
        response = await self._http.get("/json/list")
        response.raise_for_status()
        targets = response.json()
        if not isinstance(targets, list):
            raise RuntimeError("Chromium returned an invalid target list")
        closable = [target for target in targets if self._is_external_page(target)]
        for target in closable:
            target_id = quote(str(target["id"]), safe="")
            closed = await self._http.get(f"/json/close/{target_id}")
            closed.raise_for_status()
        return len(closable)

    def _is_external_page(self, target: Any) -> bool:
        if not isinstance(target, dict) or target.get("type") != "page" or not target.get("id"):
            return False
        url = str(target.get("url") or "")
        return not url.startswith(self._ui_origin)
