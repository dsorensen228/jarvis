from __future__ import annotations

import asyncio
import logging
import signal

from jarvis_camera.config import Settings
from jarvis_camera.service import CameraService


async def _run() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await CameraService(Settings.from_env()).run(stop)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_run())


if __name__ == "__main__":
    main()
