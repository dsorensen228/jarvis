"""Local kiosk server and authenticated facade over the Jarvis API."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from urllib.parse import quote

import httpx
from aiohttp import WSMsgType, web

from jarvis_voice.api import JarvisApiClient
from jarvis_voice.config import Settings
from jarvis_voice.spotify import SpotifyClient
from jarvis_voice.volume import get_volume, set_volume

logger = logging.getLogger(__name__)


class VoiceUiController(Protocol):
    @property
    def ui_state(self) -> dict[str, Any]: ...

    async def toggle_session(self) -> None: ...

    async def set_interactions_muted(self, muted: bool) -> None: ...

    async def start_coding_prompt_recording(self) -> None: ...

    async def stop_coding_prompt_recording(self) -> tuple[bytes, int]: ...


class UiEventHub:
    def __init__(self) -> None:
        self._clients: set[web.WebSocketResponse] = set()
        self._voice_state: dict[str, Any] = {
            "active": False,
            "phase": "idle",
            "connected": False,
            "interactions_muted": False,
        }

    @property
    def voice_state(self) -> dict[str, Any]:
        return dict(self._voice_state)

    async def set_voice_state(self, **state: Any) -> None:
        self._voice_state.update(state)
        await self.publish("voice.state", self._voice_state)

    async def client_action(self, action: str, arguments: dict[str, Any]) -> None:
        await self.publish("client.action", {"action": action, "arguments": arguments})

    async def publish(self, event: str, data: dict[str, Any]) -> None:
        message = json.dumps({"type": event, "data": data}, separators=(",", ":"))
        dead: list[web.WebSocketResponse] = []
        for client in tuple(self._clients):
            try:
                await client.send_str(message)
            except (ConnectionError, RuntimeError):
                dead.append(client)
        for client in dead:
            self._clients.discard(client)

    async def connect(self, request: web.Request) -> web.WebSocketResponse:
        websocket = web.WebSocketResponse(heartbeat=20)
        await websocket.prepare(request)
        self._clients.add(websocket)
        await websocket.send_json({"type": "voice.state", "data": self._voice_state})
        try:
            async for message in websocket:
                if message.type == WSMsgType.ERROR:
                    break
        finally:
            self._clients.discard(websocket)
        return websocket


@web.middleware
async def _no_cache_html(
    request: web.Request,
    handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
) -> web.StreamResponse:
    response = await handler(request)
    if request.method == "GET" and request.path in {
        "/",
        "/index.html",
        "/spotify-callback.html",
    }:
        response.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
    return response


class LocalUiServer:
    def __init__(
        self,
        settings: Settings,
        api: JarvisApiClient,
        spotify: SpotifyClient,
        voice: VoiceUiController,
        events: UiEventHub,
    ) -> None:
        self.settings = settings
        self.api = api
        self.spotify = spotify
        self.voice = voice
        self.events = events
        self._app = web.Application(middlewares=[_no_cache_html])
        self._runner: web.AppRunner | None = None
        self._register_routes()

    def _register_routes(self) -> None:
        routes = self._app.router
        routes.add_get("/api/config", self._config)
        routes.add_get("/api/events", self.events.connect)
        routes.add_post("/api/voice/tap", self._voice_tap)
        routes.add_post("/api/voice/interactions-mute", self._interactions_mute)
        routes.add_get("/api/banter", self._banter_status)
        routes.add_post("/api/banter/trigger", self._banter_trigger)
        if self.settings.coding_tasks_enabled:
            routes.add_get("/api/code-tasks", self._code_tasks)
            routes.add_post("/api/code-tasks", self._code_task_create)
            routes.add_post("/api/code-tasks/recording/start", self._code_recording_start)
            routes.add_post("/api/code-tasks/recording/stop", self._code_recording_stop)
            routes.add_get(r"/api/code-tasks/{task_id}", self._code_task)
            routes.add_post(r"/api/code-tasks/{task_id}/cancel", self._code_task_cancel)
        routes.add_get("/api/system/volume", self._volume_get)
        routes.add_post("/api/system/volume", self._volume_post)
        routes.add_get("/api/lights/room-state", self._lights_state)
        routes.add_post("/api/lights/room-toggle", self._lights_toggle)
        routes.add_get("/api/cameras", self._cameras)
        routes.add_get(r"/api/cameras/{device_id}/snapshot", self._camera_snapshot)
        routes.add_get("/api/screens", self._screens)
        routes.add_post(r"/api/screens/{device_id}/commands", self._screen_command)
        routes.add_post("/api/spotify/oauth/exchange", self._spotify_exchange)
        routes.add_get("/api/spotify/player-access-token", self._spotify_token)
        routes.add_post("/api/spotify/disconnect", self._spotify_disconnect)
        routes.add_get("/api/spotify/search", self._spotify_search)
        routes.add_post("/api/spotify/player/play", self._spotify_play)
        routes.add_get("/", self._index)
        routes.add_get("/index.html", self._index)
        routes.add_get("/spotify-callback.html", self._spotify_callback)
        routes.add_get("/jarvis.png", self._jarvis_image)
        routes.add_static("/assets", self.settings.ui_dist / "assets")
        routes.add_get(r"/{path:.*}", self._index)

    async def start(self) -> None:
        if not (self.settings.ui_dist / "index.html").is_file():
            raise FileNotFoundError(
                f"touchscreen bundle not found at {self.settings.ui_dist}; build apps/device-ui"
            )
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(
            self._runner,
            host=self.settings.ui_host,
            port=self.settings.ui_port,
        )
        await site.start()
        logger.info(
            "touchscreen UI: http://%s:%d (%s)",
            self.settings.ui_host,
            self.settings.ui_port,
            self.settings.ui_dist,
        )

    async def close(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    async def _config(self, request: web.Request) -> web.Response:
        del request
        return web.json_response(
            {
                "device_id": self.settings.device_id,
                "api_http_base": self.settings.api_url,
                "voice_ui": True,
                "coding_tasks_enabled": self.settings.coding_tasks_enabled,
                "music_tab_enabled": self.settings.music_tab_enabled,
                "room_name": self.settings.room or None,
                **self.spotify.config(),
            }
        )

    async def _voice_tap(self, request: web.Request) -> web.Response:
        del request
        await self.voice.toggle_session()
        return web.json_response({"ok": True, **self.voice.ui_state})

    async def _interactions_mute(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except (json.JSONDecodeError, TypeError):
            body = {}
        if not isinstance(body, dict) or not isinstance(body.get("muted"), bool):
            return web.json_response(
                {"error": "muted boolean required"},
                status=400,
            )
        await self.voice.set_interactions_muted(body["muted"])
        return web.json_response({"ok": True, **self.voice.ui_state})

    async def _banter_status(self, request: web.Request) -> web.Response:
        del request
        device_id = quote(self.settings.device_id, safe="")
        return await self._proxy_json("GET", f"/v1/banter/devices/{device_id}")

    async def _banter_trigger(self, request: web.Request) -> web.Response:
        del request
        device_id = quote(self.settings.device_id, safe="")
        return await self._proxy_json("POST", f"/v1/banter/devices/{device_id}/trigger")

    async def _code_tasks(self, request: web.Request) -> web.Response:
        params = {"limit": request.query.get("limit", "50")}
        if request.query.get("status"):
            params["status"] = request.query["status"]
        return await self._proxy_json("GET", "/v1/code-tasks", params=params)

    async def _code_task(self, request: web.Request) -> web.Response:
        return await self._proxy_json("GET", f"/v1/code-tasks/{request.match_info['task_id']}")

    async def _code_task_cancel(self, request: web.Request) -> web.Response:
        return await self._proxy_json(
            "POST", f"/v1/code-tasks/{request.match_info['task_id']}/cancel"
        )

    async def _code_recording_start(self, request: web.Request) -> web.Response:
        del request
        try:
            await self.voice.start_coding_prompt_recording()
        except (PermissionError, RuntimeError) as exc:
            return web.json_response({"detail": str(exc)}, status=409)
        return web.json_response({"recording": True})

    async def _code_recording_stop(self, request: web.Request) -> web.Response:
        """Transcribe the recording so the touchscreen can confirm or re-record it."""
        del request
        try:
            pcm, sample_rate = await self.voice.stop_coding_prompt_recording()
            transcript_response = await self.api.request(
                "POST",
                "/v1/speech/transcribe",
                params={"sample_rate": sample_rate},
                content=pcm,
                headers={"Content-Type": "application/octet-stream"},
                timeout=120.0,
            )
            transcript = str(transcript_response.json().get("text") or "").strip()
            if not transcript:
                return web.json_response(
                    {"detail": "No speech was detected; record the prompt again."}, status=422
                )
            return web.json_response({"transcript": transcript})
        except ValueError as exc:
            return web.json_response({"detail": str(exc)}, status=422)
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=502)

    async def _code_task_create(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            body = {}
        prompt = str((body or {}).get("prompt") or "").strip()
        if not prompt:
            return web.json_response({"detail": "a prompt is required"}, status=422)
        payload = {"prompt": prompt}
        model = str((body or {}).get("model") or "").strip()
        if model:
            payload["model"] = model
        try:
            task = await self.api.json("POST", "/v1/code-tasks", body=payload)
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=502)
        return web.json_response(task, status=202)

    async def _proxy_json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> web.Response:
        try:
            response = await self.api.request(method, path, params=params)
            return web.json_response(response.json(), status=response.status_code)
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=502)

    async def _volume_get(self, request: web.Request) -> web.Response:
        del request
        try:
            state = await get_volume()
            return web.json_response({"percent": state.percent, "muted": state.muted})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=503)

    async def _volume_post(self, request: web.Request) -> web.Response:
        body = await _json_object(request)
        try:
            state = await set_volume(
                percent=_optional_int(body, "percent"),
                delta_percent=_optional_int(body, "delta_percent"),
                muted=body.get("muted") if isinstance(body.get("muted"), bool) else None,
            )
            return web.json_response({"percent": state.percent, "muted": state.muted})
        except (RuntimeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=503)

    async def _lights_state(self, request: web.Request) -> web.Response:
        del request
        if not self.settings.room:
            return web.json_response({"room_bound": False, "is_on": None, "count": 0, "unknown": 0})
        try:
            state = await self._room_lights_state()
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=503)
        return web.json_response({"room_bound": True, **state})

    async def _lights_toggle(self, request: web.Request) -> web.Response:
        del request
        if not self.settings.room:
            raise web.HTTPBadRequest(text="room is not configured")
        try:
            # Read the room's real state first. A cached value goes stale the
            # moment the lights are changed from the phone or by voice.
            state = await self._room_lights_state()
            if not state["count"]:
                raise web.HTTPNotFound(text=f"no lights in {self.settings.room}")
            # Unknown power means the next press should give light.
            action = "turn_off" if state["is_on"] is True else "turn_on"
            result = await self.api.json(
                "POST",
                "/v1/smart-devices/control",
                body={
                    "scope": "room",
                    "selector": self.settings.room,
                    "action": action,
                    "parameters": {},
                },
            )
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=503)
        return web.json_response({"status": "ok", "action": action, **result})

    async def _room_lights_state(self) -> dict[str, Any]:
        """Light power for this device's room, aggregated by the API in one call."""
        room = quote(self.settings.room, safe="")
        state = await self.api.json("GET", f"/v1/rooms/{room}/lights")
        return {
            "is_on": state.get("is_on"),
            "count": int(state.get("count") or 0),
            "unknown": int(state.get("unknown") or 0),
        }

    async def _cameras(self, request: web.Request) -> web.Response:
        del request
        rows = await self.api.json("GET", "/v1/devices")
        return web.json_response(
            [
                {
                    "id": str(row["id"]),
                    "device_name": str(row.get("name") or row["id"]),
                    "device_type": "camera",
                }
                for row in rows
                if row.get("kind") == "camera"
            ]
        )

    async def _camera_snapshot(self, request: web.Request) -> web.Response:
        try:
            response = await self.api.request(
                "GET", f"/v1/devices/{request.match_info['device_id']}/camera/snapshot"
            )
        except httpx.HTTPStatusError as exc:
            return web.json_response(
                {"detail": exc.response.text[:500]}, status=exc.response.status_code
            )
        return web.Response(
            body=response.content,
            content_type=response.headers.get("content-type", "image/jpeg").split(";", 1)[0],
            headers={"Cache-Control": "no-store"},
        )

    async def _screens(self, request: web.Request) -> web.Response:
        """Every device with a screen, plus which one this room's requests go to."""
        del request
        try:
            rows = await self.api.json("GET", "/v1/smart-devices")
            primary = None
            if self.settings.room:
                room = quote(self.settings.room, safe="")
                primary = await self.api.json("GET", f"/v1/rooms/{room}/display")
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=503)
        primary_id = str(primary.get("id")) if isinstance(primary, dict) else ""
        return web.json_response(
            [
                {
                    "id": str(row["id"]),
                    "name": str(row.get("name") or row["id"]),
                    "room": str(row.get("room") or ""),
                    "model": str(row.get("model") or ""),
                    "available": bool(row.get("available")),
                    "power": row.get("power"),
                    "app": _component_app(row),
                    "muted": _component_muted(row),
                    "capabilities": list(row.get("capabilities") or []),
                    "is_room_default": str(row["id"]) == primary_id,
                }
                for row in rows
                if _has_media_player(row)
            ]
        )

    async def _screen_command(self, request: web.Request) -> web.Response:
        """One neutral action on one screen. The API decides what it can accept."""
        body = await _json_object(request)
        action = str(body.get("action") or "").strip()
        if not action:
            raise web.HTTPBadRequest(text="action is required")
        parameters = body.get("parameters")
        payload: dict[str, Any] = {
            "action": action,
            "parameters": parameters if isinstance(parameters, dict) else {},
        }
        device_id = quote(request.match_info["device_id"], safe="")
        try:
            result = await self.api.json(
                "POST", f"/v1/smart-devices/{device_id}/commands", body=payload
            )
        except httpx.HTTPStatusError as exc:
            return _upstream_error(exc)
        except httpx.HTTPError as exc:
            return web.json_response({"detail": str(exc)}, status=503)
        return web.json_response(result)

    async def _spotify_exchange(self, request: web.Request) -> web.Response:
        body = await _json_object(request)
        try:
            result = await self.spotify.exchange_pkce(
                code=str(body.get("code") or ""),
                redirect_uri=str(body.get("redirect_uri") or ""),
                code_verifier=str(body.get("code_verifier") or ""),
            )
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"detail": str(exc)}, status=502)

    async def _spotify_token(self, request: web.Request) -> web.Response:
        del request
        try:
            return web.json_response(await self.spotify.player_token())
        except Exception as exc:
            return web.json_response({"detail": str(exc)}, status=503)

    async def _spotify_disconnect(self, request: web.Request) -> web.Response:
        del request
        await self.spotify.disconnect()
        return web.json_response({"ok": True})

    async def _spotify_search(self, request: web.Request) -> web.Response:
        query = request.query.get("q", "").strip()
        if not query:
            raise web.HTTPBadRequest(text="q is required")
        try:
            limit = max(1, min(50, int(request.query.get("limit", "8"))))
            rows = await self.spotify.search(
                query, request.query.get("types", "album,playlist,track"), limit
            )
            return web.json_response({"items": rows})
        except Exception as exc:
            return web.json_response({"detail": str(exc)}, status=502)

    async def _spotify_play(self, request: web.Request) -> web.Response:
        body = await _json_object(request)
        try:
            await self.spotify.play(
                spotify_uri=str(body.get("spotify_uri") or ""),
                track_uris=body.get("track_uris")
                if isinstance(body.get("track_uris"), list)
                else None,
                device_name=str(body.get("device_name") or ""),
            )
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"detail": str(exc)}, status=502)

    async def _index(self, request: web.Request) -> web.StreamResponse:
        del request
        return web.FileResponse(self.settings.ui_dist / "index.html")

    async def _spotify_callback(self, request: web.Request) -> web.StreamResponse:
        del request
        return web.FileResponse(self.settings.ui_dist / "spotify-callback.html")

    async def _jarvis_image(self, request: web.Request) -> web.StreamResponse:
        del request
        return web.FileResponse(self.settings.ui_dist / "jarvis.png")


def _components(row: Any) -> list[dict[str, Any]]:
    if not isinstance(row, dict):
        return []
    return [item for item in row.get("components") or [] if isinstance(item, dict)]


def _has_media_player(row: Any) -> bool:
    return any(item.get("domain") == "media_player" for item in _components(row))


def _component_app(row: Any) -> str:
    """Whatever the screen is currently showing, when it reports one."""
    for item in _components(row):
        if item.get("domain") == "media_player" and item.get("app"):
            return str(item["app"])
    return ""


def _component_muted(row: Any) -> bool | None:
    for item in _components(row):
        if item.get("domain") == "media_player" and item.get("muted") is not None:
            return bool(item["muted"])
    return None


def _upstream_error(exc: httpx.HTTPStatusError) -> web.Response:
    try:
        payload = exc.response.json()
    except ValueError:
        payload = {"detail": exc.response.text[:500] or "upstream request failed"}
    return web.json_response(payload, status=exc.response.status_code)


async def _json_object(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise web.HTTPBadRequest(text="invalid JSON") from exc
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="JSON object required")
    return body


def _optional_int(body: dict[str, Any], key: str) -> int | None:
    if key not in body:
        return None
    try:
        return int(body[key])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be an integer") from exc
