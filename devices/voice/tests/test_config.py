from __future__ import annotations

import sys

import pytest

from jarvis_voice.config import Settings


def test_runtime_is_exact_python_3135():
    assert sys.version_info[:3] == (3, 13, 5)


def test_settings_are_environment_only(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_ROOM", "Office")
    settings = Settings.from_env()
    assert settings.username == "owner"
    assert settings.api_url == "http://jarvis-api.local:8000"
    assert settings.room == "Office"
    assert settings.ui_dist == tmp_path / "apps/device-ui/dist"
    assert settings.wake_model_dir == tmp_path / "devices/voice/models/openwakeword"
    assert settings.personality_level == 2
    assert settings.coding_tasks_enabled is False
    assert settings.music_tab_enabled is False
    assert settings.coding_prompt_max_seconds == 180


def test_music_tab_enabled_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_MUSIC_TAB_ENABLED", "true")
    settings = Settings.from_env()
    assert settings.music_tab_enabled is True


@pytest.mark.parametrize("device_id", ["voice-one", "voice-two"])
def test_kitchen_and_mudroom_wake_default_is_five_percent_less_sensitive(
    monkeypatch, tmp_path, device_id
):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_DEVICE_ID", device_id)
    monkeypatch.delenv("JARVIS_WAKE_THRESHOLD", raising=False)
    settings = Settings.from_env()
    # Prior fleet floor was 0.60; 5% less sensitive -> higher threshold.
    assert settings.wake_threshold == pytest.approx(0.63)


def test_other_devices_keep_default_wake_threshold(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_USERNAME", "owner")
    monkeypatch.setenv("JARVIS_PASSWORD", "secret")
    monkeypatch.setenv("JARVIS_ROOT", str(tmp_path))
    monkeypatch.setenv("JARVIS_DEVICE_ID", "voice-three")
    monkeypatch.delenv("JARVIS_WAKE_THRESHOLD", raising=False)
    settings = Settings.from_env()
    assert settings.wake_threshold == pytest.approx(0.68)


def test_required_credentials_fail_at_startup(monkeypatch):
    monkeypatch.delenv("JARVIS_USERNAME", raising=False)
    monkeypatch.delenv("JARVIS_PASSWORD", raising=False)
    with pytest.raises(ValueError, match="JARVIS_USERNAME"):
        Settings.from_env()
