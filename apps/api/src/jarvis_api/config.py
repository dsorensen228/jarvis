"""Typed configuration loaded once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Mapping, Optional

# Jetson LLM weight experiment: heretic is the same Qwen3-30B-A3B Instruct
# 2507 checkpoint with refusal directions ablated. Flip JARVIS_LLM_VARIANT
# to "stock" to revert without changing other settings.
LLM_VARIANTS: Dict[str, Dict[str, str]] = {
    "heretic": {
        "model": "qwen3-30b-a3b-instruct-2507-heretic",
        "file": "qwen3-30b-a3b-instruct-2507-heretic-q4_k_m.gguf",
    },
    "stock": {
        "model": "qwen3-30b-a3b-instruct-2507",
        "file": "qwen3-30b-a3b-instruct-2507-q4_k_m.gguf",
    },
}
DEFAULT_LLM_VARIANT = "heretic"


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str, default: str) -> List[str]:
    return [value.strip() for value in os.getenv(name, default).split(",") if value.strip()]


def resolve_llm_variant(env: Optional[Mapping[str, str]] = None) -> str:
    source = env if env is not None else os.environ
    raw = source.get("JARVIS_LLM_VARIANT", DEFAULT_LLM_VARIANT)
    variant = (raw or DEFAULT_LLM_VARIANT).strip().lower() or DEFAULT_LLM_VARIANT
    if variant not in LLM_VARIANTS:
        allowed = ", ".join(sorted(LLM_VARIANTS))
        raise ValueError(f"JARVIS_LLM_VARIANT must be one of: {allowed} (got {raw!r})")
    return variant


def resolve_llm_model_name(env: Optional[Mapping[str, str]] = None) -> str:
    source = env if env is not None else os.environ
    explicit = (source.get("JARVIS_LLM_MODEL") or "").strip()
    if explicit:
        return explicit
    return LLM_VARIANTS[resolve_llm_variant(source)]["model"]


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path
    database_path: Path
    asset_dir: Path
    cors_origins: List[str]

    jwt_secret: str
    access_token_minutes: int
    refresh_token_days: int
    bootstrap_username: str
    bootstrap_password: str

    llm_base_url: str
    llm_api_key: str
    llm_model: str
    llm_variant: str
    llm_context_tokens: int
    llm_max_output_tokens: int
    llm_request_timeout_seconds: float

    asr_url: str
    tts_url: str
    speech_request_timeout_seconds: float
    voice_audio_limit_bytes: int

    google_client_id: str
    google_client_secret: str
    google_redirect_uri: str
    web_app_url: str

    tavily_api_key: str
    weather_default_location: str
    timezone: str

    timer_poll_seconds: float
    log_level: str
    allow_registration: bool
    vision_base_url: str = "http://127.0.0.1:8083/v1"
    vision_model: str = "qwen3-vl-4b-instruct"
    vision_request_timeout_seconds: float = 120.0
    code_factory_url: str = "http://code-host.local:8010"
    code_factory_request_timeout_seconds: float = 30.0
    openai_api_key: str = ""
    openai_web_model: str = "gpt-4o"
    google_login_subjects: List[str] = field(default_factory=list)
    # Home Assistant owns every smart-home device integration, discovery, and
    # state. The token is a deployment secret and is never returned by the API.
    home_assistant_url: str = ""
    home_assistant_token: str = ""
    home_assistant_request_timeout_seconds: float = 10.0

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = Path(os.getenv("JARVIS_DATA_DIR", "data")).expanduser().resolve()
        return cls(
            host=os.getenv("JARVIS_HOST", "0.0.0.0"),
            port=int(os.getenv("JARVIS_PORT", "8000")),
            data_dir=data_dir,
            database_path=Path(os.getenv("JARVIS_DATABASE_PATH", str(data_dir / "jarvis.sqlite3")))
            .expanduser()
            .resolve(),
            asset_dir=Path(os.getenv("JARVIS_ASSET_DIR", str(data_dir / "assets")))
            .expanduser()
            .resolve(),
            cors_origins=_csv("JARVIS_CORS_ORIGINS", "http://localhost:3000,http://localhost:8081"),
            jwt_secret=os.getenv("JARVIS_JWT_SECRET", "development-only-change-me"),
            access_token_minutes=int(os.getenv("JARVIS_ACCESS_TOKEN_MINUTES", "30")),
            refresh_token_days=int(os.getenv("JARVIS_REFRESH_TOKEN_DAYS", "30")),
            bootstrap_username=os.getenv("JARVIS_BOOTSTRAP_USERNAME", "admin").strip(),
            bootstrap_password=os.getenv("JARVIS_BOOTSTRAP_PASSWORD", "").strip(),
            llm_base_url=os.getenv("JARVIS_LLM_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/"),
            llm_api_key=os.getenv("JARVIS_LLM_API_KEY", "local"),
            llm_model=resolve_llm_model_name(),
            llm_variant=resolve_llm_variant(),
            # A 16K context is ample for Jarvis's bounded request transcript
            # and is substantially faster and less memory-hungry on the
            # Jetson than reserving 32K tokens for every generation slot.
            llm_context_tokens=int(os.getenv("JARVIS_LLM_CONTEXT_TOKENS", "16384")),
            llm_max_output_tokens=int(os.getenv("JARVIS_LLM_MAX_OUTPUT_TOKENS", "1024")),
            llm_request_timeout_seconds=float(
                os.getenv("JARVIS_LLM_REQUEST_TIMEOUT_SECONDS", "180")
            ),
            asr_url=os.getenv("JARVIS_ASR_URL", "http://127.0.0.1:8091").rstrip("/"),
            tts_url=os.getenv("JARVIS_TTS_URL", "http://127.0.0.1:8092").rstrip("/"),
            speech_request_timeout_seconds=float(
                os.getenv("JARVIS_SPEECH_REQUEST_TIMEOUT_SECONDS", "120")
            ),
            voice_audio_limit_bytes=int(
                os.getenv("JARVIS_VOICE_AUDIO_LIMIT_BYTES", str(16 * 1024 * 1024))
            ),
            google_client_id=os.getenv("JARVIS_GOOGLE_CLIENT_ID", "").strip(),
            google_client_secret=os.getenv("JARVIS_GOOGLE_CLIENT_SECRET", "").strip(),
            google_redirect_uri=os.getenv(
                "JARVIS_GOOGLE_REDIRECT_URI",
                "http://localhost:8000/v1/integrations/gmail/callback",
            ).strip(),
            web_app_url=os.getenv("JARVIS_WEB_APP_URL", "http://localhost:8080").rstrip("/"),
            tavily_api_key=os.getenv("JARVIS_TAVILY_API_KEY", "").strip(),
            weather_default_location=os.getenv(
                "JARVIS_WEATHER_DEFAULT_LOCATION", "Springfield IL 62701"
            ).strip(),
            timezone=os.getenv("JARVIS_TIMEZONE", "America/New_York").strip(),
            timer_poll_seconds=float(os.getenv("JARVIS_TIMER_POLL_SECONDS", "0.5")),
            log_level=os.getenv("JARVIS_LOG_LEVEL", "INFO").upper(),
            allow_registration=_bool("JARVIS_ALLOW_REGISTRATION", False),
            vision_base_url=os.getenv("JARVIS_VISION_BASE_URL", "http://127.0.0.1:8083/v1").rstrip(
                "/"
            ),
            vision_model=os.getenv("JARVIS_VISION_MODEL", "qwen3-vl-4b-instruct"),
            vision_request_timeout_seconds=float(
                os.getenv("JARVIS_VISION_REQUEST_TIMEOUT_SECONDS", "120")
            ),
            code_factory_url=os.getenv(
                "JARVIS_CODE_FACTORY_URL", "http://code-host.local:8010"
            ).rstrip("/"),
            code_factory_request_timeout_seconds=float(
                os.getenv("JARVIS_CODE_FACTORY_REQUEST_TIMEOUT_SECONDS", "30")
            ),
            openai_api_key=(
                os.getenv("JARVIS_OPENAI_API_KEY", "").strip()
                or os.getenv("OPENAI_API_KEY", "").strip()
            ),
            openai_web_model=os.getenv("JARVIS_OPENAI_WEB_MODEL", "gpt-4o").strip() or "gpt-4o",
            google_login_subjects=_csv("JARVIS_GOOGLE_LOGIN_SUBJECTS", ""),
            home_assistant_url=os.getenv("JARVIS_HOME_ASSISTANT_URL", "").strip().rstrip("/"),
            home_assistant_token=os.getenv("JARVIS_HOME_ASSISTANT_TOKEN", "").strip(),
            home_assistant_request_timeout_seconds=float(
                os.getenv("JARVIS_HOME_ASSISTANT_REQUEST_TIMEOUT_SECONDS", "10")
            ),
        )

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.asset_dir.mkdir(parents=True, exist_ok=True)

    def validate_for_production(self) -> List[str]:
        problems = []
        if self.jwt_secret == "development-only-change-me":
            problems.append("JARVIS_JWT_SECRET still uses the development value")
        if not self.bootstrap_password:
            problems.append("JARVIS_BOOTSTRAP_PASSWORD is empty")
        return problems
