"""Small local Spotify Web API client used by the touchscreen."""

from __future__ import annotations

import asyncio
import os
import re
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
        async with self._lock:
            try:
                self.settings.spotify_refresh_token_file.unlink(missing_ok=True)
            except OSError as exc:
                raise RuntimeError(f"could not remove Spotify token: {exc}") from exc
            self._access_token = ""
            self._expires_at = 0.0

    async def player_token(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            await self.invalidate()
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
        device_id: str = "",
    ) -> None:
        # Validate before resolving or transferring any device. A rejected tap
        # must not interrupt playback elsewhere in the account.
        body: dict[str, Any]
        if track_uris:
            if any(
                not isinstance(uri, str) or not re.fullmatch(r"spotify:track:[A-Za-z0-9]+", uri)
                for uri in track_uris
            ):
                raise ValueError("track_uris must contain only Spotify track URIs")
            body = {"uris": track_uris}
        elif re.fullmatch(r"spotify:track:[A-Za-z0-9]+", spotify_uri):
            body = {"uris": [spotify_uri]}
        elif re.fullmatch(r"spotify:(?:album|artist|playlist):[A-Za-z0-9]+", spotify_uri):
            body = {"context_uri": spotify_uri}
        else:
            raise ValueError("Choose a Spotify track, album, artist, or playlist")
        device_id = device_id.strip()
        if not device_id:
            # Voice commands target a configured name. Touchscreen requests use
            # their SDK's exact ID, avoiding duplicate-name ambiguity and an
            # unnecessary transfer before the targeted play request.
            device_id, is_active = await self._target_device(device_name)
            if device_id and not is_active:
                await self._api(
                    "PUT", "/me/player", body={"device_ids": [device_id], "play": False}
                )
        params = {"device_id": device_id} if device_id else None
        await self._api("PUT", "/me/player/play", params=params, body=body)

    async def resume(self, device_name: str = "") -> None:
        device_id, is_active = await self._target_device(device_name)
        if device_id and not is_active:
            await self._api("PUT", "/me/player", body={"device_ids": [device_id], "play": True})
        else:
            params = {"device_id": device_id} if device_id else None
            await self._api("PUT", "/me/player/play", params=params)

    async def queue(self, device_id: str) -> dict[str, Any]:
        device_id = _required_device_id(device_id)
        playback = await self._api("GET", "/me/player")
        state = playback.json() if playback.status_code == 200 else {}
        if (state.get("device") or {}).get("id") != device_id:
            return {"items": [], "currently_playing": None, "active": False}
        response = await self._api("GET", "/me/player/queue")
        payload = response.json()
        current = _queue_tracks([payload.get("currently_playing")], 1)
        items = _queue_tracks(payload.get("queue", []), 50)
        return {
            "items": items,
            "currently_playing": current[0] if current else None,
            "active": True,
        }

    async def add_to_queue(self, uri: str, device_id: str) -> None:
        device_id = _required_device_id(device_id)
        if not re.fullmatch(r"spotify:track:[A-Za-z0-9]+", uri):
            raise ValueError("Only Spotify tracks can be added to the queue")
        await self._api("POST", "/me/player/queue", params={"uri": uri, "device_id": device_id})

    async def set_shuffle(self, state: bool, device_id: str) -> None:
        device_id = _required_device_id(device_id)
        if not isinstance(state, bool):
            raise ValueError("shuffle must be a boolean")
        await self._api(
            "PUT",
            "/me/player/shuffle",
            params={"state": str(state).lower(), "device_id": device_id},
        )

    async def set_repeat(self, mode: str, device_id: str) -> None:
        device_id = _required_device_id(device_id)
        if mode not in {"off", "context", "track"}:
            raise ValueError("repeat must be off, context, or track")
        await self._api("PUT", "/me/player/repeat", params={"state": mode, "device_id": device_id})

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
            raise RuntimeError(_spotify_error(response))
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


def _required_device_id(device_id: str) -> str:
    if not isinstance(device_id, str) or not device_id.strip():
        raise ValueError("device_id is required")
    return device_id.strip()


def _spotify_error(response: httpx.Response) -> str:
    status = response.status_code
    if status == 401:
        return "Spotify needs a fresh sign-in. Connect your account again."
    if status == 404:
        return "Spotify cannot find this player. Retry the connection and select music again."
    if status == 429:
        try:
            seconds = int(response.headers.get("Retry-After", ""))
        except ValueError:
            seconds = 0
        if 0 < seconds <= 300:
            return f"Spotify is busy. Wait {seconds} seconds before trying again."
        return "Spotify is busy. Wait a few minutes before trying again."
    if status >= 500:
        return "Spotify is temporarily unavailable. Please try again shortly."
    detail = ""
    try:
        error = response.json().get("error", {})
        if isinstance(error, dict):
            detail = str(error.get("message") or "").strip()[:240]
    except (ValueError, AttributeError):
        pass
    if status == 403:
        if "premium" in detail.lower():
            return "Playback on this device requires Spotify Premium."
        return (
            f"Spotify cannot allow this action: {detail}"
            if detail
            else "Spotify cannot allow this action for the current account or track."
        )
    return (
        f"Spotify: {detail}" if detail else "Spotify could not complete that action. Please retry."
    )


def _queue_tracks(items: Any, limit: int) -> list[dict[str, Any]]:
    # Spotify's account queue may mix episodes with music. This music-only UI
    # must not label an episode as a playable track.
    if not isinstance(items, list):
        return []
    tracks = [
        item
        for item in items
        if isinstance(item, dict) and str(item.get("uri", "")).startswith("spotify:track:")
    ]
    return _search_rows({"tracks": {"items": tracks}}, limit)


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
