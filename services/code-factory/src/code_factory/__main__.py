import uvicorn

from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        "code_factory.app:app",
        host=settings.host,
        port=settings.port,
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
