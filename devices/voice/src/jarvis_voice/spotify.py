"""Small local Spotify Web API client used by the touchscreen."""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from jarvis_voice.config import Settings

ACCOUNTS_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"


class SpotifyClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._http = httpx.AsyncClient(timeout=30.0)
        self._lock = asyncio.Lock()
        self._access_token = ""
        self._expires_at = 0.0

    @property
    def registered(self) -> bool:
        try:
            return bool(self.settings.spotify_refresh_token_file.read_text().strip())
        except OSError:
            return False

    @property
    def ready(self) -> bool:
        return bool(self.settings.spotify_client_id and self.registered)

    def config(self) -> dict[str, Any]:
        missing = []
        if not self.settings.spotify_client_id:
            missing.append("spotify_client_id")
        if not self.registered:
            missing.append("spotify_refresh_token")
        return {
            "spotify_client_id": self.settings.spotify_client_id or None,
            "spotify_player_name": self.settings.spotify_player_name,
            "spotify_web_playback_volume": self.settings.spotify_web_playback_volume,
            "spotify_can_connect": bool(self.settings.spotify_client_id),
            "spotify_connected": self.registered,
            "spotify_ready": not missing,
            "spotify_missing": missing,
        }

    async def exchange_pkce(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> dict[str, Any]:
        self._validate_redirect(redirect_uri)
        if not self.settings.spotify_client_id:
            raise ValueError("JARVIS_SPOTIFY_CLIENT_ID is not configured")
        response = await self._http.post(
            ACCOUNTS_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": self.settings.spotify_client_id,
                "code_verifier": code_verifier,
            },
        )
        response.raise_for_status()
        payload = response.json()
        refresh_token = str(payload.get("refresh_token") or "").strip()
        if not refresh_token:
            raise RuntimeError("Spotify response did not include a refresh token")
        self._write_refresh_token(refresh_token)
        self._seed_access(payload)
        return {
            "access_token": str(payload["access_token"]),
            "expires_in": int(payload.get("expires_in", 3600)),
        }

    async def disconnect(self) -> None:
        try:
            self.settings.spotify_refresh_token_file.unlink(missing_ok=True)
        except OSError as exc:
            raise RuntimeError(f"could not remove Spotify token: {exc}") from exc
        await self.invalidate()

    async def player_token(self) -> dict[str, Any]:
        token = await self._token()
        return {
            "access_token": token,
            "expires_in": max(1, int(self._expires_at - time.monotonic())),
        }

    async def search(self, query: str, types: str, limit: int) -> list[dict[str, Any]]:
        allowed = {"album", "playlist", "track", "artist"}
        selected = [item for item in types.replace(" ", "").split(",") if item in allowed]
        if not selected:
            raise ValueError("no valid Spotify search types")
        response = await self._api(
            "GET",
            "/search",
            params={"q": query.strip(), "type": ",".join(selected), "limit": limit},
        )
        return _search_rows(response.json(), 36)

    async def play(
        self,
        *,
        spotify_uri: str = "",
        track_uris: list[str] | None = None,
        device_name: str = "",
    ) -> None:
        device_id, is_active = await self._target_device(device_name)
        if device_id and not is_active:
            await self._api("PUT", "/me/player", body={"device_ids": [device_id], "play": False})
        body: dict[str, Any]
        if track_uris:
            valid = [uri for uri in track_uris if uri.startswith("spotify:track:")]
            if not valid:
                raise ValueError("track_uris must contain Spotify track URIs")
            body = {"uris": valid}
        elif spotify_uri.startswith("spotify:track:"):
            body = {"uris": [spotify_uri]}
        elif spotify_uri.startswith("spotify:"):
            body = {"context_uri": spotify_uri}
        else:
            raise ValueError("spotify_uri or track_uris is required")
        params = {"device_id": device_id} if device_id else None
        await self._api("PUT", "/me/player/play", params=params, body=body)

    async def resume(self, device_name: str = "") -> None:
        device_id, is_active = await self._target_device(device_name)
        if device_id and not is_active:
            await self._api("PUT", "/me/player", body={"device_ids": [device_id], "play": True})
        else:
            params = {"device_id": device_id} if device_id else None
            await self._api("PUT", "/me/player/play", params=params)

    async def pause(self, device_name: str = "") -> None:
        device_id, _ = await self._target_device(device_name)
        params = {"device_id": device_id} if device_id else None
        await self._api("PUT", "/me/player/pause", params=params)

    async def skip_next(self, device_name: str = "") -> None:
        await self._skip("next", device_name)

    async def skip_previous(self, device_name: str = "") -> None:
        await self._skip("previous", device_name)

    async def _skip(self, direction: str, device_name: str) -> None:
        device_id, _ = await self._target_device(device_name)
        params = {"device_id": device_id} if device_id else None
        await self._api("POST", f"/me/player/{direction}", params=params)

    async def close(self) -> None:
        await self._http.aclose()

    async def invalidate(self) -> None:
        async with self._lock:
            self._access_token = ""
            self._expires_at = 0.0

    async def _token(self) -> str:
        if self._access_token and time.monotonic() < self._expires_at:
            return self._access_token
        async with self._lock:
            if self._access_token and time.monotonic() < self._expires_at:
                return self._access_token
            try:
                refresh_token = self.settings.spotify_refresh_token_file.read_text().strip()
            except OSError as exc:
                raise RuntimeError("Spotify is not connected on this device") from exc
            data = {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            }
            data["client_id"] = self.settings.spotify_client_id
            response = await self._http.post(ACCOUNTS_URL, data=data)
            response.raise_for_status()
            payload = response.json()
            rotated = str(payload.get("refresh_token") or "").strip()
            if rotated:
                self._write_refresh_token(rotated)
            self._seed_access(payload)
            return self._access_token

    async def _api(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> httpx.Response:
        token = await self._token()
        response = await self._http.request(
            method,
            API_BASE + path,
            params=params,
            json=body,
            headers={"Authorization": f"Bearer {token}"},
        )
        if response.status_code == 401:
            await self.invalidate()
            token = await self._token()
            response = await self._http.request(
                method,
                API_BASE + path,
                params=params,
                json=body,
                headers={"Authorization": f"Bearer {token}"},
            )
        if response.status_code not in {200, 201, 202, 204}:
            detail = response.text[:800]
            raise RuntimeError(f"Spotify HTTP {response.status_code}: {detail}")
        return response

    async def _resolve_device(self, name: str) -> dict[str, Any] | None:
        if not name:
            return None
        response = await self._api("GET", "/me/player/devices")
        rows = response.json().get("devices", [])
        matches = [row for row in rows if str(row.get("name", "")).lower() == name.lower()]
        active = next((row for row in matches if row.get("is_active")), None)
        chosen = active or (matches[0] if matches else None)
        return chosen if chosen and chosen.get("id") else None

    async def _target_device(self, device_name: str) -> tuple[str | None, bool]:
        """Resolve the target device id and whether it is already the active player.

        An already-active device does not need the extra transfer request, which
        saves a full Spotify API round trip on the voice hot path.
        """
        target_name = device_name.strip() or self.settings.spotify_player_name
        device = await self._resolve_device(target_name)
        if target_name and device is None:
            raise RuntimeError(f"No Spotify Connect device named {target_name!r}")
        if device is None:
            return None, False
        return str(device["id"]), bool(device.get("is_active"))

    def _seed_access(self, payload: dict[str, Any]) -> None:
        token = str(payload.get("access_token") or "")
        if not token:
            raise RuntimeError("Spotify response did not include an access token")
        expires_in = max(60, int(payload.get("expires_in", 3600)))
        self._access_token = token
        self._expires_at = time.monotonic() + expires_in - 60

    def _write_refresh_token(self, token: str) -> None:
        path = self.settings.spotify_refresh_token_file
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".spotify-", dir=path.parent, text=True)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(token)
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        except Exception:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def _validate_redirect(self, redirect_uri: str) -> None:
        parsed = urlsplit(redirect_uri)
        allowed_hosts = {"localhost", "127.0.0.1", "::1"}
        if self.settings.ui_host not in {"0.0.0.0", "::"}:
            allowed_hosts.add(self.settings.ui_host.lower())
        if (
            parsed.scheme != "http"
            or (parsed.hostname or "").lower() not in allowed_hosts
            or parsed.port != self.settings.ui_port
            or parsed.path.rstrip("/") != "/spotify-callback.html"
        ):
            raise ValueError("Spotify redirect_uri must be the local kiosk callback")


def _cover(images: Any) -> str | None:
    if not isinstance(images, list):
        return None
    choices = [item for item in images if isinstance(item, dict) and item.get("url")]
    if not choices:
        return None
    return str(max(choices, key=lambda item: int(item.get("width") or 0))["url"])


def _search_rows(payload: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for plural, kind in (
        ("albums", "album"),
        ("playlists", "playlist"),
        ("tracks", "track"),
        ("artists", "artist"),
    ):
        items = payload.get(plural, {}).get("items", [])
        if not isinstance(items, list):
            continue
        for item in items:
            if len(rows) >= limit:
                return rows
            if not isinstance(item, dict) or not str(item.get("uri", "")).startswith("spotify:"):
                continue
            artists = item.get("artists", [])
            subtitle = ", ".join(
                str(artist.get("name"))
                for artist in artists[:3]
                if isinstance(artist, dict) and artist.get("name")
            )
            image = _cover(item.get("images"))
            if kind == "track" and isinstance(item.get("album"), dict):
                image = _cover(item["album"].get("images"))
            if kind == "playlist" and isinstance(item.get("owner"), dict):
                subtitle = str(item["owner"].get("display_name") or "")
            if kind == "artist":
                subtitle = "Artist"
            rows.append(
                {
                    "uri": str(item["uri"]),
                    "name": str(item.get("name") or "")[:240],
                    "subtitle": subtitle[:240],
                    "image": image,
                    "kind": kind,
                }
            )
    return rows
