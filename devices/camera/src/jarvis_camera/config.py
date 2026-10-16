from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

DEFAULT_IMX500_MODEL = (
    "/usr/share/imx500-models/imx500_network_ssd_mobilenetv2_fpnlite_320x320_pp.rpk"
)


class ConfigurationError(ValueError):
    pass


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ConfigurationError(f"{key} is required")
    return value


def _boolean(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{key} must be true or false")


def _integer(env: Mapping[str, str], key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(env.get(key, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{key} must be an integer") from exc
    if not low <= value <= high:
        raise ConfigurationError(f"{key} must be between {low} and {high}")
    return value


def _number(env: Mapping[str, str], key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(env.get(key, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{key} must be a number") from exc
    if not low <= value <= high:
        raise ConfigurationError(f"{key} must be between {low} and {high}")
    return value


def _url(env: Mapping[str, str], key: str) -> str:
    value = _required(env, key).rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigurationError(f"{key} must be an http(s) URL")
    return value


@dataclass(frozen=True)
class Settings:
    api_url: str
    username: str
    password: str
    device_id: str
    name: str
    room: str
    public_url: str
    callback_token: str
    bind_host: str
    port: int
    width: int
    height: int
    jpeg_quality: int
    hflip: bool
    vflip: bool
    stream_interval_seconds: float
    person_detection: bool
    person_threshold: float
    person_confirmations: int
    person_interval_seconds: float
    person_clear_seconds: float
    event_cooldown_seconds: float
    imx500_model: str
    person_alert_text: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        values = env or os.environ
        width = _integer(values, "JARVIS_CAMERA_WIDTH", 960, 160, 4096)
        height = _integer(values, "JARVIS_CAMERA_HEIGHT", 540, 120, 2160)
        if width % 2 or height % 2:
            raise ConfigurationError("camera width and height must be even")
        callback_token = _required(values, "JARVIS_CAMERA_CALLBACK_TOKEN")
        if len(callback_token) < 16:
            raise ConfigurationError("JARVIS_CAMERA_CALLBACK_TOKEN must be at least 16 characters")
        person_alert_text = values.get("JARVIS_CAMERA_PERSON_ALERT_TEXT", "").strip()
        if len(person_alert_text) > 300:
            raise ConfigurationError(
                "JARVIS_CAMERA_PERSON_ALERT_TEXT must be at most 300 characters"
            )
        return cls(
            api_url=_url(values, "JARVIS_API_URL"),
            username=_required(values, "JARVIS_USERNAME"),
            password=_required(values, "JARVIS_PASSWORD"),
            device_id=_required(values, "JARVIS_CAMERA_DEVICE_ID"),
            name=_required(values, "JARVIS_CAMERA_NAME"),
            room=values.get("JARVIS_CAMERA_ROOM", "").strip(),
            public_url=_url(values, "JARVIS_CAMERA_PUBLIC_URL"),
            callback_token=callback_token,
            bind_host=values.get("JARVIS_CAMERA_BIND_HOST", "0.0.0.0").strip(),
            port=_integer(values, "JARVIS_CAMERA_PORT", 8089, 1, 65535),
            width=width,
            height=height,
            jpeg_quality=_integer(values, "JARVIS_CAMERA_JPEG_QUALITY", 68, 30, 95),
            hflip=_boolean(values, "JARVIS_CAMERA_HFLIP", False),
            vflip=_boolean(values, "JARVIS_CAMERA_VFLIP", False),
            stream_interval_seconds=_number(
                values, "JARVIS_CAMERA_STREAM_INTERVAL_SECONDS", 0.5, 0.1, 10.0
            ),
            person_detection=_boolean(values, "JARVIS_CAMERA_PERSON_DETECTION", True),
            person_threshold=_number(values, "JARVIS_CAMERA_PERSON_THRESHOLD", 0.65, 0.05, 1.0),
            person_confirmations=_integer(values, "JARVIS_CAMERA_PERSON_CONFIRMATIONS", 2, 1, 10),
            person_interval_seconds=_number(
                values, "JARVIS_CAMERA_PERSON_INTERVAL_SECONDS", 5.0, 0.2, 300.0
            ),
            person_clear_seconds=_number(
                values, "JARVIS_CAMERA_PERSON_CLEAR_SECONDS", 3.0, 0.0, 300.0
            ),
            event_cooldown_seconds=_number(
                values, "JARVIS_CAMERA_EVENT_COOLDOWN_SECONDS", 30.0, 0.0, 3600.0
            ),
            imx500_model=values.get("JARVIS_CAMERA_IMX500_MODEL", DEFAULT_IMX500_MODEL).strip(),
            person_alert_text=person_alert_text,
        )
