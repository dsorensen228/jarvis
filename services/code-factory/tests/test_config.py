from pathlib import Path

import pytest

from code_factory.config import Settings


def test_repository_paths_stay_inside_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODE_FACTORY_WORKSPACE", "/tmp/jarvis-workspace")
    settings = Settings.from_env()
    assert settings.mongo_database == "jarvis"
    assert settings.mongo_collection == "code_factory_tasks"
    assert settings.repository_path("jarvis") == Path("/tmp/jarvis-workspace/jarvis")
    assert settings.repository_path("sherman") == Path("/tmp/jarvis-workspace/sherman")
    with pytest.raises(ValueError):
        settings.repository_path("other")


def test_research_workspace_is_separate_and_configurable(monkeypatch):
    monkeypatch.delenv("CODE_FACTORY_RESEARCH_WORKSPACE", raising=False)
    assert Settings.from_env().research_workspace == Path.home() / "jarvis-research"
    monkeypatch.setenv("CODE_FACTORY_RESEARCH_WORKSPACE", "/tmp/independent-research")
    assert Settings.from_env().research_workspace == Path("/tmp/independent-research")
