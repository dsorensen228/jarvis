"""LLM weight variant selection for the heretic experiment."""

from __future__ import annotations

import os

import pytest

from jarvis_api.config import Settings, resolve_llm_model_name


@pytest.fixture(autouse=True)
def _clear_llm_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("JARVIS_LLM_MODEL", "JARVIS_LLM_VARIANT"):
        monkeypatch.delenv(name, raising=False)


def test_resolve_llm_model_name_defaults_to_heretic_experiment() -> None:
    assert resolve_llm_model_name({}) == "qwen3-30b-a3b-instruct-2507-heretic"


def test_resolve_llm_model_name_stock_variant() -> None:
    assert resolve_llm_model_name({"JARVIS_LLM_VARIANT": "stock"}) == "qwen3-30b-a3b-instruct-2507"


def test_resolve_llm_model_name_explicit_override_wins() -> None:
    assert (
        resolve_llm_model_name(
            {
                "JARVIS_LLM_VARIANT": "stock",
                "JARVIS_LLM_MODEL": "custom-model",
            }
        )
        == "custom-model"
    )


def test_resolve_llm_model_name_rejects_unknown_variant() -> None:
    with pytest.raises(ValueError, match="JARVIS_LLM_VARIANT"):
        resolve_llm_model_name({"JARVIS_LLM_VARIANT": "abliterated"})


def test_settings_from_env_uses_heretic_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_DATA_DIR", os.environ.get("JARVIS_DATA_DIR", "data"))
    settings = Settings.from_env()
    assert settings.llm_model == "qwen3-30b-a3b-instruct-2507-heretic"
    assert settings.llm_variant == "heretic"


def test_settings_from_env_stock_variant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_LLM_VARIANT", "stock")
    settings = Settings.from_env()
    assert settings.llm_model == "qwen3-30b-a3b-instruct-2507"
    assert settings.llm_variant == "stock"
