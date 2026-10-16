from __future__ import annotations

from dataclasses import replace

import pytest

from jarvis_camera.config import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings.from_env(
        {
            "JARVIS_API_URL": "http://jarvis-api.local:8000",
            "JARVIS_USERNAME": "owner",
            "JARVIS_PASSWORD": "test password",
            "JARVIS_CAMERA_DEVICE_ID": "camera-one",
            "JARVIS_CAMERA_NAME": "Porch",
            "JARVIS_CAMERA_ROOM": "Porch",
            "JARVIS_CAMERA_PUBLIC_URL": "http://camera-one.local:8089",
            "JARVIS_CAMERA_CALLBACK_TOKEN": "a-valid-callback-token",
        }
    )


@pytest.fixture
def local_settings(settings: Settings) -> Settings:
    return replace(settings, bind_host="127.0.0.1", port=0)
