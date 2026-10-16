from __future__ import annotations

import asyncio
import hmac

from aiohttp import web

from jarvis_camera.capture import FrameCache
from jarvis_camera.config import Settings


class HealthState:
    def __init__(self) -> None:
        self.fatal_error: str | None = None
        self.detector_degraded_reason: str | None = None
        self.detector_last_score: float | None = None
        self.person_present = False


class CallbackServer:
    def __init__(self, settings: Settings, frames: FrameCache, health: HealthState) -> None:
        self.settings = settings
        self.frames = frames
        self.health = health
        self.runner: web.AppRunner | None = None
        self.site: web.TCPSite | None = None
        self.bound_port: int | None = None

    def app(self) -> web.Application:
        application = web.Application()
        application.router.add_get("/health/live", self.live)
        application.router.add_get("/health/ready", self.ready)
        application.router.add_get("/v1/camera/snapshot", self.snapshot)
        application.router.add_get("/v1/camera/stream", self.stream)
        return application

    async def start(self) -> None:
        self.runner = web.AppRunner(self.app(), access_log=None)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, self.settings.bind_host, self.settings.port)
        await self.site.start()
        server = self.site._server
        if server and server.sockets:
            self.bound_port = int(server.sockets[0].getsockname()[1])

    async def stop(self) -> None:
        if self.runner:
            await self.runner.cleanup()
            self.runner = None
            self.site = None

    async def live(self, request: web.Request) -> web.Response:
        del request
        return web.json_response({"status": "ok"})

    async def ready(self, request: web.Request) -> web.Response:
        del request
        frame = self.frames.get()
        ready = frame is not None and self.health.fatal_error is None
        return web.json_response(
            {
                "status": "ok" if ready else "not_ready",
                "frame_sequence": frame.sequence if frame else 0,
                "fatal_error": self.health.fatal_error,
                "detector_degraded_reason": self.health.detector_degraded_reason,
                "detector_last_score": self.health.detector_last_score,
                "person_present": self.health.person_present,
            },
            status=200 if ready else 503,
        )

    def _authorized(self, request: web.Request) -> bool:
        header = request.headers.get("Authorization", "")
        expected = f"Bearer {self.settings.callback_token}"
        return hmac.compare_digest(header.encode("utf-8"), expected.encode("utf-8"))

    async def snapshot(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="bearer token required")
        frame = self.frames.get()
        if frame is None:
            raise web.HTTPServiceUnavailable(text="camera has not captured a frame")
        return web.Response(
            body=frame.jpeg,
            content_type="image/jpeg",
            headers={
                "Cache-Control": "no-store",
                "X-Capture-Timestamp": frame.captured_at,
                "X-Frame-Sequence": str(frame.sequence),
                "X-Frame-Width": str(frame.width),
                "X-Frame-Height": str(frame.height),
            },
        )

    async def stream(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="bearer token required")
        response = web.StreamResponse(
            headers={
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-store",
            }
        )
        await response.prepare(request)
        last_sequence = 0
        try:
            while True:
                frame = self.frames.get()
                if frame is not None and frame.sequence != last_sequence:
                    last_sequence = frame.sequence
                    await response.write(
                        b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                        + str(len(frame.jpeg)).encode("ascii")
                        + b"\r\n\r\n"
                        + frame.jpeg
                        + b"\r\n"
                    )
                await asyncio.sleep(self.settings.stream_interval_seconds)
        except (ConnectionError, asyncio.CancelledError):
            pass
        return response
