"""Normalized integration boundary consumed by HTTP routes and agent tools."""

from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from jarvis_api.config import Settings
from jarvis_api.integrations.gmail import GmailClient
from jarvis_api.integrations.knowledge import KnowledgeClient
from jarvis_api.secrets import CredentialVault
from jarvis_api.smarthome.service import SmartHomeService
from jarvis_api.store import SqliteStore


class IntegrationService:
    """Personal integrations. Smart home lives in :class:`SmartHomeService`."""

    def __init__(
        self,
        store: SqliteStore,
        settings: Settings,
        vault: CredentialVault,
        smart_home: SmartHomeService,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.store = store
        self.vault = vault
        self.http = http_client or httpx.AsyncClient(timeout=20)
        self._owns_http = http_client is None
        self.smart_home = smart_home
        self.gmail = GmailClient(settings, vault, self.http)
        self.knowledge = KnowledgeClient(settings, self.http)

    async def close(self) -> None:
        if self._owns_http:
            await self.http.aclose()

    async def statuses(self, user_id: str) -> Dict[str, Dict[str, Any]]:
        return {
            "home_assistant": await self.smart_home.status(user_id),
            "gmail": {"connected": await self.gmail.connected(user_id)},
        }
