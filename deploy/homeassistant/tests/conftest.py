"""Pytest configuration for Govee OpenAPI custom component tests."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from unittest.mock import MagicMock

import pytest

COMPONENTS = Path(__file__).resolve().parents[1] / "custom_components"


@pytest.fixture
def mock_hass():
    """Minimal Home Assistant stand-in for coordinator unit tests."""
    hass = MagicMock()
    loop = asyncio.get_event_loop()
    hass.async_create_task = lambda coro: loop.create_task(coro)
    return hass


@pytest.fixture
def hass_config_dir(tmp_path: Path) -> str:
    """Home Assistant config dir containing this repo's custom_components tree."""
    config = tmp_path / "config"
    shutil.copytree(COMPONENTS, config / "custom_components")
    return str(config)
