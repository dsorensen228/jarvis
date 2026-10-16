from __future__ import annotations

import httpx

from jarvis_camera.capture import FrameCache
from jarvis_camera.server import CallbackServer, HealthState


async def test_snapshot_readiness_auth_and_headers(local_settings) -> None:
    frames = FrameCache()
    server = CallbackServer(local_settings, frames, HealthState())
    await server.start()
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{server.bound_port}") as client:
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 503
            assert (await client.get("/v1/camera/snapshot")).status_code == 401
            frames.put(b"\xff\xd8hello\xff\xd9", 960, 540)
            ready = await client.get("/health/ready")
            assert ready.status_code == 200
            assert ready.json()["detector_last_score"] is None
            assert ready.json()["person_present"] is False
            response = await client.get(
                "/v1/camera/snapshot",
                headers={"Authorization": f"Bearer {local_settings.callback_token}"},
            )
            assert response.status_code == 200
            assert response.content == b"\xff\xd8hello\xff\xd9"
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["x-frame-width"] == "960"
    finally:
        await server.stop()


def test_frame_cache_rejects_partial_jpeg() -> None:
    frames = FrameCache()
    try:
        frames.put(b"not-a-jpeg", 1, 1)
    except ValueError as error:
        assert "complete JPEG" in str(error)
    else:
        raise AssertionError("partial JPEG was accepted")
