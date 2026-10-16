"""Small environment-only configuration surface for one voice runtime."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path


def _text(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _required(name: str) -> str:
    value = _text(name)
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = _text(name)
    value = default if not raw else int(raw)
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _number(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = _text(name)
    value = default if not raw else float(raw)
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = _text(name)
    if not raw:
        return default
    lowered = raw.lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(value.strip() for value in _text(name, default).split(",") if value.strip())


# Kitchen/mudroom were at 0.60; 5% less sensitive -> higher openWakeWord threshold.
_WAKE_THRESHOLD_BY_DEVICE = {
    "voice-one": 0.63,
    "voice-two": 0.63,
}
_DEFAULT_WAKE_THRESHOLD = 0.68


@dataclass(frozen=True)
class Settings:
    api_url: str
    username: str
    password: str
    device_id: str
    room: str
    input_device: str
    output_device: str
    ui_host: str
    ui_port: int
    ui_dist: Path
    ui_enabled: bool
    coding_tasks_enabled: bool
    music_tab_enabled: bool
    coding_prompt_max_seconds: int
    wake_model_dir: Path
    wake_threshold: float
    wake_consecutive_hits: int
    utterance_silence_ms: int
    utterance_max_seconds: int
    follow_up_seconds: float
    conversation_idle_seconds: float
    personality_level: int
    spotify_client_id: str
    spotify_refresh_token_file: Path
    spotify_player_name: str
    spotify_web_playback_volume: float
    watchmode_api_key: str
    watchmode_region: str
    watchmode_preferred_sources: tuple[str, ...]
    log_level: str

    @classmethod
    def from_env(cls) -> Settings:
        default_root = Path(__file__).resolve().parents[4]
        root = Path(_text("JARVIS_ROOT", str(default_root))).expanduser().resolve()
        device_id = _text("JARVIS_DEVICE_ID") or socket.gethostname()
        state_dir = Path(_text("JARVIS_STATE_DIR", "~/.local/share/jarvis")).expanduser().resolve()
        return cls(
            api_url=_text("JARVIS_API_URL", "http://jarvis-api.local:8000").rstrip("/"),
            username=_required("JARVIS_USERNAME"),
            password=_required("JARVIS_PASSWORD"),
            device_id=device_id,
            room=_text("JARVIS_ROOM"),
            input_device=_text("JARVIS_AUDIO_INPUT"),
            output_device=_text("JARVIS_AUDIO_OUTPUT"),
            ui_host=_text("JARVIS_UI_HOST", "127.0.0.1"),
            ui_port=_integer("JARVIS_UI_PORT", 8765, 1, 65535),
            ui_dist=Path(_text("JARVIS_UI_DIST", str(root / "apps/device-ui/dist")))
            .expanduser()
            .resolve(),
            ui_enabled=_boolean("JARVIS_UI_ENABLED", True),
            coding_tasks_enabled=_boolean("JARVIS_CODING_TASKS_ENABLED", False),
            music_tab_enabled=_boolean("JARVIS_MUSIC_TAB_ENABLED", False),
            coding_prompt_max_seconds=_integer("JARVIS_CODING_PROMPT_MAX_SECONDS", 180, 5, 600),
            wake_model_dir=Path(
                _text(
                    "JARVIS_WAKE_MODEL_DIR",
                    str(root / "devices/voice/models/openwakeword"),
                )
            )
            .expanduser()
            .resolve(),
            wake_threshold=_number(
                "JARVIS_WAKE_THRESHOLD",
                _WAKE_THRESHOLD_BY_DEVICE.get(device_id, _DEFAULT_WAKE_THRESHOLD),
                0.01,
                0.99,
            ),
            wake_consecutive_hits=_integer("JARVIS_WAKE_CONSECUTIVE_HITS", 2, 1, 10),
            utterance_silence_ms=_integer("JARVIS_UTTERANCE_SILENCE_MS", 800, 300, 5000),
            utterance_max_seconds=_integer("JARVIS_UTTERANCE_MAX_SECONDS", 20, 2, 120),
            follow_up_seconds=_number("JARVIS_FOLLOW_UP_SECONDS", 8.0, 0.5, 120.0),
            conversation_idle_seconds=_number(
                "JARVIS_CONVERSATION_IDLE_SECONDS", 1800.0, 30.0, 86400.0
            ),
            personality_level=_integer("JARVIS_PERSONALITY_LEVEL", 2, 1, 3),
            spotify_client_id=_text("JARVIS_SPOTIFY_CLIENT_ID"),
            spotify_refresh_token_file=Path(
                _text(
                    "JARVIS_SPOTIFY_REFRESH_TOKEN_FILE",
                    str(state_dir / "spotify_refresh_token"),
                )
            )
            .expanduser()
            .resolve(),
            spotify_player_name=_text(
                "JARVIS_SPOTIFY_PLAYER_NAME",
                device_id,
            )
            or device_id,
            spotify_web_playback_volume=_number(
                "JARVIS_SPOTIFY_WEB_PLAYBACK_VOLUME", 0.42, 0.0, 1.0
            ),
            watchmode_api_key=_text("JARVIS_WATCHMODE_API_KEY"),
            watchmode_region=_text("JARVIS_WATCHMODE_REGION", "US").upper(),
            watchmode_preferred_sources=_csv(
                "JARVIS_WATCHMODE_PREFERRED_SOURCES",
                "Netflix,Hulu,Disney+,HBO Max,Prime Video,Apple TV+,Peacock,Paramount Plus",
            ),
            log_level=_text("JARVIS_LOG_LEVEL", "INFO").upper(),
        )
