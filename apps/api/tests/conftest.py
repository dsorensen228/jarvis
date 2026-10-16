from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import pytest

from jarvis_api.config import Settings
from jarvis_api.inference import LlmDelta, LlmTurn
from jarvis_api.speech import Transcript


class FakeLlm:
    def __init__(self, answer: str = "Hello from Jarvis.") -> None:
        self.answer = answer
        self.requests: List[List[Dict[str, Any]]] = []

    async def ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None

    async def stream_chat(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        cancel_event: Optional[Any] = None,
        *,
        tool_choice: Any = "auto",
        temperature: float = 0.6,
    ) -> AsyncIterator[LlmDelta]:
        self.requests.append(messages)
        midpoint = max(1, len(self.answer) // 2)
        for text in (self.answer[:midpoint], self.answer[midpoint:]):
            if text:
                yield LlmDelta(kind="text", text=text)
        yield LlmDelta(kind="done", turn=LlmTurn(content=self.answer))


class FakeSpeech:
    async def ready(self) -> Dict[str, bool]:
        return {"asr": True, "tts": True}

    async def close(self) -> None:
        return None

    async def transcribe_pcm16(
        self, pcm: bytes, sample_rate: int = 16000, language: str = "en"
    ) -> Transcript:
        return Transcript("hello jarvis", "en", len(pcm) / float(sample_rate * 2))

    async def synthesize_pcm16(self, text: str):
        return b"\x01\x00" * 100, 24000


class FakeCodeFactory:
    def __init__(self) -> None:
        self.tasks: Dict[str, Dict[str, Any]] = {}

    async def close(self) -> None:
        return None

    async def create_task(self, prompt: str, model: Optional[str] = None) -> Dict[str, Any]:
        task = {
            "id": "task-1",
            "prompt": prompt,
            "model": model,
            "repository": "workspace",
            "status": "pending",
            "workflow_id": "code-task-task-1",
            "created_at": "2026-08-12T12:00:00Z",
            "updated_at": "2026-08-12T12:00:00Z",
            "changed_paths": [],
            "self_update_scheduled": False,
        }
        self.tasks[task["id"]] = task
        return task

    async def list_tasks(
        self, limit: int, task_status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        tasks = list(self.tasks.values())
        if task_status:
            tasks = [task for task in tasks if task["status"] == task_status]
        return tasks[:limit]

    async def get_task(self, task_id: str) -> Dict[str, Any]:
        return self.tasks[task_id]

    async def cancel_task(self, task_id: str) -> Dict[str, Any]:
        self.tasks[task_id]["status"] = "cancel_requested"
        return self.tasks[task_id]


class FakeHomeAssistant:
    """Stands in for Home Assistant using the shapes the real one returns.

    The fixture data represents typical installations: Govee bulbs with per-model Kelvin bounds,
    an H5082 dual plug whose sockets are separate switch entities, a plug holding
    a lamp, and a Roku that exposes both a media_player and a remote.
    """

    def __init__(self) -> None:
        self.configured = True
        self.calls: List[Any] = []
        self.fail_states: Optional[Exception] = None
        self._registry = [
            {
                "entity_id": "light.office_1",
                "friendly_name": "Office 1",
                "device_id": "ha-office-1",
                "device_name": "Office 1",
                "model": "H600D",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:01"]],
                "area": None,
            },
            {
                "entity_id": "light.kitchen_table_1",
                "friendly_name": "Kitchen Table 1",
                "device_id": "ha-kitchen-1",
                "device_name": "Kitchen Table 1",
                "model": "H6008",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:02"]],
                "area": "Kitchen",
            },
            {
                "entity_id": "switch.desk_light",
                "friendly_name": "Desk light",
                "device_id": "ha-desk-light",
                "device_name": "Desk light",
                "model": "H5083",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:03"]],
                "area": None,
            },
            {
                "entity_id": "switch.office_dual_smart_plug",
                "friendly_name": "Office Dual Smart Plug",
                "device_id": "ha-dual-plug",
                "device_name": "Office Dual Smart Plug",
                "model": "H5082",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:04"]],
                "area": None,
            },
            {
                "entity_id": "switch.office_dual_smart_plug_socket_1",
                "friendly_name": "Office Dual Smart Plug Socket 1",
                "device_id": "ha-dual-plug",
                "device_name": "Office Dual Smart Plug",
                "model": "H5082",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:04"]],
                "area": None,
            },
            {
                "entity_id": "switch.office_dual_smart_plug_socket_2",
                "friendly_name": "Office Dual Smart Plug Socket 2",
                "device_id": "ha-dual-plug",
                "device_name": "Office Dual Smart Plug",
                "model": "H5082",
                "manufacturer": "Govee",
                "identifiers": [["govee_openapi", "02:00:00:00:00:00:00:04"]],
                "area": None,
            },
            {
                "entity_id": "media_player.demo_tv",
                "friendly_name": "Demo TV",
                "device_id": "ha-roku-office",
                "device_name": "Demo TV",
                "model": "55S41R",
                "manufacturer": "TCL",
                "identifiers": [["roku", "EXAMPLETV001"]],
                "area": "Office",
            },
            {
                "entity_id": "remote.demo_tv",
                "friendly_name": "Demo TV",
                "device_id": "ha-roku-office",
                "device_name": "Demo TV",
                "model": "55S41R",
                "manufacturer": "TCL",
                "identifiers": [["roku", "EXAMPLETV001"]],
                "area": "Office",
            },
        ]
        self._states = {
            "light.office_1": _state(
                "light.office_1",
                "on",
                {
                    "friendly_name": "Office 1",
                    "supported_color_modes": ["color_temp", "rgb"],
                    "min_color_temp_kelvin": 2700,
                    "max_color_temp_kelvin": 6500,
                    "brightness": 255,
                    "rgb_color": [255, 180, 120],
                    "color_temp_kelvin": 3000,
                },
            ),
            "light.kitchen_table_1": _state(
                "light.kitchen_table_1",
                "off",
                {
                    "friendly_name": "Kitchen Table 1",
                    "supported_color_modes": ["color_temp", "rgb"],
                    "min_color_temp_kelvin": 2000,
                    "max_color_temp_kelvin": 9000,
                },
            ),
            "switch.desk_light": _state("switch.desk_light", "on", {"friendly_name": "Desk light"}),
            "switch.office_dual_smart_plug": _state(
                "switch.office_dual_smart_plug", "on", {"friendly_name": "Office Dual Smart Plug"}
            ),
            "switch.office_dual_smart_plug_socket_1": _state(
                "switch.office_dual_smart_plug_socket_1",
                "on",
                {"friendly_name": "Office Dual Smart Plug Socket 1"},
            ),
            "switch.office_dual_smart_plug_socket_2": _state(
                "switch.office_dual_smart_plug_socket_2",
                "off",
                {"friendly_name": "Office Dual Smart Plug Socket 2"},
            ),
            "media_player.demo_tv": _state(
                "media_player.demo_tv",
                "on",
                {
                    "friendly_name": "Demo TV",
                    # turn_on/off, volume set/step, mute, play, pause, select_source
                    "supported_features": 1 | 4 | 8 | 128 | 256 | 1024 | 2048 | 16384,
                    "source": "Work MBP",
                    "source_list": ["Netflix", "Netflix Kids", "Work MBP", "Hulu"],
                    "is_volume_muted": False,
                },
            ),
            "remote.demo_tv": _state(
                "remote.demo_tv", "on", {"friendly_name": "Demo TV"}
            ),
        }

    async def version(self) -> str:
        return "2026.9.3"

    async def registry(self) -> List[Dict[str, Any]]:
        return [dict(row) for row in self._registry]

    async def states(self) -> Dict[str, Dict[str, Any]]:
        if self.fail_states is not None:
            raise self.fail_states
        return {key: dict(value) for key, value in self._states.items()}

    async def call_service(
        self, domain: str, service: str, data: Optional[Dict[str, Any]] = None
    ) -> None:
        self.calls.append((domain, service, dict(data or {})))

    def drop(self, entity_id: str) -> None:
        """Simulate an entity Home Assistant no longer provides."""
        self._registry = [row for row in self._registry if row["entity_id"] != entity_id]
        self._states.pop(entity_id, None)

    def set_state(self, entity_id: str, state: str) -> None:
        self._states[entity_id]["state"] = state


def _state(entity_id: str, state: str, attributes: Dict[str, Any]) -> Dict[str, Any]:
    return {"entity_id": entity_id, "state": state, "attributes": attributes}


@pytest.fixture
def home_assistant() -> FakeHomeAssistant:
    return FakeHomeAssistant()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    base = Settings.from_env()
    return replace(
        base,
        data_dir=tmp_path,
        database_path=tmp_path / "test.sqlite3",
        asset_dir=tmp_path / "assets",
        jwt_secret="test-secret-that-is-long-enough-for-tests",
        bootstrap_username="owner",
        bootstrap_password="correct horse battery staple",
        timer_poll_seconds=0.01,
    )
