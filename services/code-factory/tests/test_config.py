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
