from __future__ import annotations

import uvicorn

from jarvis_api.config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        "jarvis_api.app:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
