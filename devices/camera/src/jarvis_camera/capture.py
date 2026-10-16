from __future__ import annotations

import io
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol


@dataclass(frozen=True)
class Frame:
    jpeg: bytes
    captured_at: str
    monotonic_time: float
    width: int
    height: int
    sequence: int
    metadata: dict[str, Any] | None = None


class FrameCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: Frame | None = None

    def put(
        self,
        jpeg: bytes,
        width: int,
        height: int,
        metadata: dict[str, Any] | None = None,
    ) -> Frame:
        if not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
            raise ValueError("capture did not produce a complete JPEG")
        with self._lock:
            sequence = 1 if self._latest is None else self._latest.sequence + 1
            frame = Frame(
                jpeg=bytes(jpeg),
                captured_at=datetime.now(UTC).isoformat(),
                monotonic_time=time.monotonic(),
                width=width,
                height=height,
                sequence=sequence,
                metadata=metadata,
            )
            self._latest = frame
            return frame

    def get(self) -> Frame | None:
        with self._lock:
            return self._latest


class CaptureBackend(Protocol):
    def start(self) -> None: ...

    def capture(self) -> tuple[bytes, dict[str, Any] | None]: ...

    def stop(self) -> None: ...


class Picamera2Capture:
    """Hardware adapter; Raspberry Pi imports intentionally stay inside this class."""

    def __init__(
        self,
        settings: Any,
        camera_num: int | None = None,
        inference_rate: float | None = None,
    ) -> None:
        from libcamera import Transform
        from picamera2 import Picamera2

        self.settings = settings
        self.camera = Picamera2(camera_num) if camera_num is not None else Picamera2()
        configuration: dict[str, Any] = {
            "main": {"size": (settings.width, settings.height), "format": "BGR888"},
            "buffer_count": 4 if settings.person_detection else 2,
            "transform": Transform(hflip=int(settings.hflip), vflip=int(settings.vflip)),
        }
        if inference_rate is not None:
            configuration["controls"] = {"FrameRate": inference_rate}
        config = self.camera.create_preview_configuration(**configuration)
        self.camera.configure(config)

    def start(self) -> None:
        self.camera.start()

    def capture(self) -> tuple[bytes, dict[str, Any] | None]:
        from PIL import Image

        request = self.camera.capture_request()
        try:
            array = request.make_array("main")
            metadata = request.get_metadata()
            if array is None or getattr(array, "size", 0) == 0:
                raise RuntimeError("Picamera2 returned an empty frame")
            output = io.BytesIO()
            Image.fromarray(array).save(
                output,
                format="JPEG",
                quality=self.settings.jpeg_quality,
                optimize=False,
            )
            return output.getvalue(), metadata
        finally:
            request.release()

    def stop(self) -> None:
        self.camera.stop()
        self.camera.close()
