"""Export the public API contract for non-Python clients."""

import json
from pathlib import Path

from jarvis_api.app import create_app


repository = Path(__file__).resolve().parents[1]
destination = repository / "contracts" / "openapi" / "jarvis-v1.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(
    json.dumps(create_app().openapi(), indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
print(destination)

