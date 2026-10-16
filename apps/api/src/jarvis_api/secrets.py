"""Encrypted storage for integration credentials and short-lived OAuth state."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Dict, Optional

from cryptography.fernet import Fernet, InvalidToken

from jarvis_api.store import SqliteStore


class SecretCorrupted(RuntimeError):
    pass


class CredentialVault:
    """Encrypt values before they reach SQLite.

    The key is deliberately derived from the deployment secret so the repository
    never needs a second checked-in key. Rotating JARVIS_JWT_SECRET requires users
    to reconnect integrations.
    """

    def __init__(self, store: SqliteStore, deployment_secret: str) -> None:
        digest = hashlib.sha256(deployment_secret.encode("utf-8")).digest()
        self.store = store
        self._cipher = Fernet(base64.urlsafe_b64encode(digest))

    async def put(
        self,
        namespace: str,
        key: str,
        owner_id: str,
        value: Dict[str, Any],
        expires_at: Optional[str] = None,
    ) -> None:
        plaintext = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        encrypted = self._cipher.encrypt(plaintext).decode("ascii")
        await self.store.put_secret(namespace, key, owner_id, encrypted, expires_at)

    async def get(
        self, namespace: str, key: str, owner_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        row = await self.store.get_secret(namespace, key)
        if row is None or (owner_id is not None and row["owner_id"] != owner_id):
            return None
        try:
            plaintext = self._cipher.decrypt(row["value"].encode("ascii"))
            value = json.loads(plaintext)
        except (InvalidToken, UnicodeError, json.JSONDecodeError) as exc:
            raise SecretCorrupted(f"could not decrypt {namespace} credential") from exc
        if not isinstance(value, dict):
            raise SecretCorrupted(f"invalid {namespace} credential payload")
        value["_owner_id"] = row["owner_id"]
        value["_expires_at"] = row["expires_at"]
        return value

    async def delete(self, namespace: str, key: str, owner_id: Optional[str] = None) -> bool:
        row = await self.store.get_secret(namespace, key)
        if row is None or (owner_id is not None and row["owner_id"] != owner_id):
            return False
        await self.store.delete_secret(namespace, key)
        return True
