from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    workspace: Path
    agent_path: Path
    mongo_uri: str
    mongo_database: str
    mongo_collection: str
    temporal_address: str
    temporal_namespace: str
    temporal_task_queue: str
    host: str
    port: int
    updater_path: Path
    agent_timeout_seconds: float = 7200
    agent_idle_timeout_seconds: float = 900

    @classmethod
    def from_env(cls) -> Settings:
        workspace = Path(
            os.environ.get("CODE_FACTORY_WORKSPACE", "~/jarvis-workspace")
        ).expanduser()
        return cls(
            workspace=workspace,
            agent_timeout_seconds=_positive_seconds("CODE_FACTORY_AGENT_TIMEOUT_SECONDS", 7200),
            agent_idle_timeout_seconds=_positive_seconds(
                "CODE_FACTORY_AGENT_IDLE_TIMEOUT_SECONDS", 900
            ),
            agent_path=Path(
                os.environ.get("CODE_FACTORY_AGENT_PATH", "~/.local/bin/agent")
            ).expanduser(),
            mongo_uri=os.environ.get("CODE_FACTORY_MONGO_URI", "mongodb://127.0.0.1:27017"),
            mongo_database=os.environ.get("CODE_FACTORY_MONGO_DATABASE", "jarvis"),
            mongo_collection=os.environ.get("CODE_FACTORY_MONGO_COLLECTION", "code_factory_tasks"),
            temporal_address=os.environ.get("CODE_FACTORY_TEMPORAL_ADDRESS", "127.0.0.1:7233"),
            temporal_namespace=os.environ.get("CODE_FACTORY_TEMPORAL_NAMESPACE", "default"),
            temporal_task_queue=os.environ.get(
                "CODE_FACTORY_TEMPORAL_TASK_QUEUE", "jarvis-code-factory"
            ),
            host=os.environ.get("CODE_FACTORY_HOST", "0.0.0.0"),
            port=int(os.environ.get("CODE_FACTORY_PORT", "8010")),
            updater_path=Path(
                os.environ.get(
                    "CODE_FACTORY_UPDATER_PATH",
                    "~/Library/Application Support/JarvisCodeFactory/update-code-factory.sh",
                )
            ).expanduser(),
        )

    def repository_path(self, repository: str) -> Path:
        if repository not in {"jarvis", "sherman"}:
            raise ValueError(f"unsupported repository: {repository}")
        return self.workspace / repository


def _positive_seconds(name: str, default: float) -> float:
    import math

    value = float(os.environ.get(name, default))
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return value
