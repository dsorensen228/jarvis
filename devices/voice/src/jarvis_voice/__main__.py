"""Jarvis voice-device entry point."""

from __future__ import annotations

import asyncio
import logging
import signal

from jarvis_voice.config import Settings
from jarvis_voice.service import VoiceDeviceService


async def _run() -> None:
    settings = Settings.from_env()
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    service = VoiceDeviceService(settings)
    await service.run(stop)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
