"""Read-only deployment checks for one Raspberry Pi voice device."""

from __future__ import annotations

import asyncio
import json
import platform
import sys
from typing import Any

from jarvis_voice.api import JarvisApiClient
from jarvis_voice.audio import resolve_audio_devices
from jarvis_voice.config import Settings
from jarvis_voice.hardware import detect_profile, seeed_product_ids


async def _diagnose() -> dict[str, Any]:
    settings = Settings.from_env()
    product_ids = seeed_product_ids()
    profile = detect_profile(product_ids)
    audio = resolve_audio_devices(
        profile,
        settings.input_device,
        settings.output_device,
    )
    required = (3, 13, 5)
    if sys.version_info[:3] != required:
        raise RuntimeError(
            f"jarvis-voice requires Python 3.13.5, running {platform.python_version()}"
        )
    api = JarvisApiClient(settings.api_url, settings.username, settings.password)
    try:
        await api.access_token()
    finally:
        await api.close()
    models = sorted(path.name for path in settings.wake_model_dir.glob("*.onnx"))
    expected_models = {
        "melspectrogram.onnx",
        "embedding_model.onnx",
        "hey_jarvis_v0.1.onnx",
    }
    if set(models) != expected_models:
        raise RuntimeError(f"wake-word models are incomplete: {models}")
    return {
        "ok": True,
        "python": platform.python_version(),
        "machine": platform.machine(),
        "hardware": profile.kind,
        "usb_product_id": f"2886:{profile.product_id:04x}",
        "input": {"index": audio.input_index, "name": audio.input_name},
        "output": {"index": audio.output_index, "name": audio.output_name},
        "models": models,
        "api": settings.api_url,
    }


def main() -> None:
    print(json.dumps(asyncio.run(_diagnose()), indent=2))


if __name__ == "__main__":
    main()
