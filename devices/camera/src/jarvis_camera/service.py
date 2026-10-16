from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from jarvis_camera.api import JarvisApi
from jarvis_camera.capture import CaptureBackend, Frame, FrameCache, Picamera2Capture
from jarvis_camera.config import Settings
from jarvis_camera.detector import Imx500PersonDetector, PresenceGate
from jarvis_camera.server import CallbackServer, HealthState

logger = logging.getLogger(__name__)


class CameraService:
    def __init__(
        self,
        settings: Settings,
        capture: CaptureBackend | None = None,
        detector: Any | None = None,
        api: JarvisApi | None = None,
    ) -> None:
        self.settings = settings
        self.frames = FrameCache()
        self.health = HealthState()
        self.detector = detector
        self.capture = capture
        self.api = api or JarvisApi(settings)
        self.server = CallbackServer(settings, self.frames, self.health)
        self.events: asyncio.Queue[tuple[Frame, float]] = asyncio.Queue(maxsize=8)
        self.gate = PresenceGate(
            settings.person_clear_seconds,
            settings.event_cooldown_seconds,
            settings.person_confirmations,
        )

    def _initialize_hardware(self) -> None:
        if self.capture is not None:
            return
        camera_num = None
        if self.settings.person_detection:
            try:
                self.detector = Imx500PersonDetector(
                    self.settings.imx500_model, self.settings.person_threshold
                )
                camera_num = self.detector.camera_num
            except Exception as exc:
                self.detector = None
                self.health.detector_degraded_reason = str(exc)
                logger.exception("IMX500 detector unavailable; running snapshot-only")
        inference_rate = getattr(self.detector, "inference_rate", None)
        self.capture = Picamera2Capture(
            self.settings,
            camera_num=camera_num,
            inference_rate=inference_rate,
        )

    async def run(self, stop: asyncio.Event) -> None:
        tasks: list[asyncio.Task[Any]] = []
        try:
            await asyncio.to_thread(self._initialize_hardware)
            assert self.capture is not None
            await asyncio.to_thread(self.capture.start)
            if self.detector is not None:
                try:
                    await asyncio.to_thread(self.detector.initialize)
                except Exception as exc:
                    self.health.detector_degraded_reason = str(exc)
                    self.detector = None
                    logger.exception("IMX500 initialization failed; running snapshot-only")
            await self.server.start()
            tasks = [
                asyncio.create_task(self._capture_loop(stop)),
                asyncio.create_task(self._event_loop(stop)),
            ]
            await self._wait_for_first_frame(stop)
            await self.api.register(
                connected=True, degraded_reason=self.health.detector_degraded_reason
            )
            tasks.append(asyncio.create_task(self._heartbeat_loop(stop)))
            await stop.wait()
        except Exception as exc:
            self.health.fatal_error = str(exc)
            raise
        finally:
            stop.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                frame = self.frames.get()
                await self.api.heartbeat(False, False, frame.sequence if frame else 0)
            except Exception:
                logger.warning("could not send final camera heartbeat", exc_info=True)
            await self.server.stop()
            if self.capture is not None:
                await asyncio.to_thread(self.capture.stop)
            await self.api.close()

    async def _wait_for_first_frame(self, stop: asyncio.Event) -> None:
        deadline = time.monotonic() + 20.0
        while self.frames.get() is None and not stop.is_set():
            if time.monotonic() >= deadline:
                raise RuntimeError("camera did not produce a valid JPEG within 20 seconds")
            await asyncio.sleep(0.1)

    async def _capture_loop(self, stop: asyncio.Event) -> None:
        assert self.capture is not None
        last_detection = 0.0
        while not stop.is_set():
            try:
                jpeg, metadata = await asyncio.to_thread(self.capture.capture)
                frame = self.frames.put(
                    jpeg, self.settings.width, self.settings.height, metadata=metadata
                )
                now = time.monotonic()
                if (
                    self.detector is not None
                    and metadata is not None
                    and now - last_detection >= self.settings.person_interval_seconds
                ):
                    last_detection = now
                    score = await asyncio.to_thread(self.detector.score, metadata)
                    self.health.detector_last_score = score
                    if self.gate.update(score >= self.settings.person_threshold, now):
                        try:
                            self.events.put_nowait((frame, score))
                        except asyncio.QueueFull:
                            logger.error("camera event queue full; dropping person event")
                    self.health.person_present = self.gate.present
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("camera capture failed; retrying")
                await asyncio.sleep(0.5)
            await asyncio.sleep(self.settings.stream_interval_seconds)

    async def _event_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            frame, score = await self.events.get()
            try:
                event_id = await self.api.post_person_event(frame, score)
                logger.info("posted person event %s (confidence %.3f)", event_id, score)
            except Exception:
                logger.exception("person event upload failed after bounded retries")
            finally:
                self.events.task_done()

    async def _heartbeat_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                frame = self.frames.get()
                await self.api.heartbeat(True, frame is not None, frame.sequence if frame else 0)
            except Exception:
                logger.warning("camera heartbeat failed", exc_info=True)
            try:
                await asyncio.wait_for(stop.wait(), timeout=30.0)
            except TimeoutError:
                pass
