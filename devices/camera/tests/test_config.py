from __future__ import annotations

import pytest

from jarvis_camera.config import ConfigurationError, Settings


def test_environment_is_one_validated_runtime() -> None:
    with pytest.raises(ConfigurationError, match="JARVIS_PASSWORD is required"):
        Settings.from_env(
            {
                "JARVIS_API_URL": "http://jarvis-api.local:8000",
                "JARVIS_USERNAME": "owner",
                "JARVIS_CAMERA_DEVICE_ID": "camera",
                "JARVIS_CAMERA_NAME": "Camera",
                "JARVIS_CAMERA_PUBLIC_URL": "http://camera.local:8089",
                "JARVIS_CAMERA_CALLBACK_TOKEN": "long-enough-secret",
            }
        )


def test_dimensions_must_be_even(settings: Settings) -> None:
    values = {
        "JARVIS_API_URL": settings.api_url,
        "JARVIS_USERNAME": settings.username,
        "JARVIS_PASSWORD": settings.password,
        "JARVIS_CAMERA_DEVICE_ID": settings.device_id,
        "JARVIS_CAMERA_NAME": settings.name,
        "JARVIS_CAMERA_PUBLIC_URL": settings.public_url,
        "JARVIS_CAMERA_CALLBACK_TOKEN": settings.callback_token,
        "JARVIS_CAMERA_WIDTH": "961",
    }
    with pytest.raises(ConfigurationError, match="must be even"):
        Settings.from_env(values)


def test_person_detection_requires_two_confirmations_by_default(settings: Settings) -> None:
    assert settings.person_confirmations == 2


def test_person_threshold_defaults_to_entrance_strong_positive(settings: Settings) -> None:
    # Calibrated to live side-door strong-positive buckets (~0.68 / ~0.73); reject 0.56–0.62 mass.
    assert settings.person_threshold == 0.65
