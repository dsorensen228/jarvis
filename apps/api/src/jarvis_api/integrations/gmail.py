"""Google OAuth and the narrow Gmail read/search surface Jarvis needs."""

from __future__ import annotations

import asyncio
import base64
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List
from urllib.parse import quote, urlencode

import httpx

from jarvis_api.config import Settings
from jarvis_api.domain import utc_now
from jarvis_api.secrets import CredentialVault

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me"
SCOPES = "https://www.googleapis.com/auth/gmail.readonly"


class GmailNotConfigured(RuntimeError):
    pass


class GmailNotConnected(RuntimeError):
    pass


class GmailClient:
    def __init__(
        self, settings: Settings, vault: CredentialVault, client: httpx.AsyncClient
    ) -> None:
        self.settings = settings
        self.vault = vault
        self.client = client

    def _require_configuration(self) -> None:
        if not self.settings.google_client_id or not self.settings.google_client_secret:
            raise GmailNotConfigured(
                "JARVIS_GOOGLE_CLIENT_ID and JARVIS_GOOGLE_CLIENT_SECRET are required"
            )

    async def authorization_url(self, user_id: str) -> str:
        self._require_configuration()
        state = secrets.token_urlsafe(32)
        expires = utc_now() + timedelta(minutes=10)
        await self.vault.put(
            "gmail_oauth_state",
            state,
            user_id,
            {"user_id": user_id},
            expires.isoformat(),
        )
        query = urlencode(
            {
                "client_id": self.settings.google_client_id,
                "redirect_uri": self.settings.google_redirect_uri,
                "response_type": "code",
                "scope": SCOPES,
                "access_type": "offline",
                "prompt": "consent",
                "include_granted_scopes": "true",
                "state": state,
            }
        )
        return f"{AUTHORIZE_URL}?{query}"

    async def exchange_code(self, state: str, code: str) -> str:
        self._require_configuration()
        state_value = await self.vault.get("gmail_oauth_state", state)
        await self.vault.delete("gmail_oauth_state", state)
        if state_value is None:
            raise ValueError("invalid or already-used OAuth state")
        expires_at = state_value.get("_expires_at")
        if not expires_at or utc_now() >= datetime.fromisoformat(str(expires_at)):
            raise ValueError("OAuth state has expired")
        user_id = str(state_value["user_id"])
        response = await self.client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": self.settings.google_client_id,
                "client_secret": self.settings.google_client_secret,
                "redirect_uri": self.settings.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        response.raise_for_status()
        token = response.json()
        if not token.get("refresh_token"):
            raise ValueError("Google did not return a refresh token")
        credentials = self._credentials_from_token(token)
        await self.vault.put("gmail", user_id, user_id, credentials)
        return user_id

    async def connected(self, user_id: str) -> bool:
        return await self.vault.get("gmail", user_id, user_id) is not None

    async def disconnect(self, user_id: str) -> bool:
        return await self.vault.delete("gmail", user_id, user_id)

    async def search(self, user_id: str, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        token = await self._access_token(user_id)
        response = await self.client.get(
            f"{GMAIL_URL}/messages",
            params={"q": query, "maxResults": max(1, min(25, limit))},
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        message_ids = [
            str(item["id"])
            for item in response.json().get("messages", [])
            if isinstance(item, dict) and item.get("id")
        ]
        results = await asyncio.gather(
            *(
                self._read_with_token(token, message_id, metadata_only=True)
                for message_id in message_ids
            )
        )
        return results

    async def read(
        self, user_id: str, message_id: str, metadata_only: bool = False
    ) -> Dict[str, Any]:
        token = await self._access_token(user_id)
        return await self._read_with_token(token, message_id, metadata_only)

    async def _read_with_token(
        self, token: str, message_id: str, metadata_only: bool
    ) -> Dict[str, Any]:
        safe_message_id = quote(message_id, safe="")
        response = await self.client.get(
            f"{GMAIL_URL}/messages/{safe_message_id}",
            params={"format": "full"},
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        raw = response.json()
        headers = {
            str(item.get("name", "")).lower(): str(item.get("value", ""))
            for item in raw.get("payload", {}).get("headers", [])
            if isinstance(item, dict)
        }
        result = {
            "id": raw.get("id"),
            "thread_id": raw.get("threadId"),
            "subject": headers.get("subject", ""),
            "from": headers.get("from", ""),
            "to": headers.get("to", ""),
            "date": headers.get("date", ""),
            "snippet": raw.get("snippet", ""),
        }
        if not metadata_only:
            result["body"] = self._plain_text(raw.get("payload", {}))[:20_000]
        return result

    async def _access_token(self, user_id: str) -> str:
        self._require_configuration()
        credentials = await self.vault.get("gmail", user_id, user_id)
        if credentials is None:
            raise GmailNotConnected("Gmail is not connected")
        expiry = str(credentials.get("expires_at") or "")
        if credentials.get("access_token") and expiry:
            try:
                if utc_now() + timedelta(seconds=60) < datetime.fromisoformat(expiry):
                    return str(credentials["access_token"])
            except ValueError:
                pass
        response = await self.client.post(
            TOKEN_URL,
            data={
                "client_id": self.settings.google_client_id,
                "client_secret": self.settings.google_client_secret,
                "refresh_token": credentials.get("refresh_token", ""),
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        token = response.json()
        credentials.update(self._credentials_from_token(token))
        credentials.pop("_owner_id", None)
        credentials.pop("_expires_at", None)
        await self.vault.put("gmail", user_id, user_id, credentials)
        return str(credentials["access_token"])

    @staticmethod
    def _credentials_from_token(token: Dict[str, Any]) -> Dict[str, Any]:
        expires_at = utc_now() + timedelta(seconds=int(token.get("expires_in", 3600)))
        result = {
            "access_token": str(token["access_token"]),
            "expires_at": expires_at.isoformat(),
        }
        if token.get("refresh_token"):
            result["refresh_token"] = str(token["refresh_token"])
        return result

    @classmethod
    def _plain_text(cls, payload: Dict[str, Any]) -> str:
        if payload.get("mimeType") == "text/plain":
            data = payload.get("body", {}).get("data")
            if data:
                return cls._decode_body(str(data))
        for part in payload.get("parts", []):
            if isinstance(part, dict):
                text = cls._plain_text(part)
                if text:
                    return text
        return ""

    @staticmethod
    def _decode_body(data: str) -> str:
        padding = "=" * (-len(data) % 4)
        return base64.urlsafe_b64decode(data + padding).decode("utf-8", errors="replace")
