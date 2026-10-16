"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from jarvis_api.agent import JarvisAgent
from jarvis_api.api import (
    auth,
    banter,
    code_tasks,
    conversations,
    devices,
    integrations,
    personal,
    projects,
    realtime,
    research_tasks,
    speech,
    wear,
)
from jarvis_api.api import (
    smart_home as smart_home_routes,
)
from jarvis_api.auth import AuthService
from jarvis_api.banter import BanterService
from jarvis_api.capabilities import Capabilities
from jarvis_api.code_factory import CodeFactoryClient
from jarvis_api.config import Settings
from jarvis_api.events import EventHub
from jarvis_api.inference import LocalLlmClient
from jarvis_api.integrations.service import IntegrationService
from jarvis_api.push import ExpoPushClient
from jarvis_api.scheduler import TimerScheduler
from jarvis_api.secrets import CredentialVault
from jarvis_api.smarthome.client import HomeAssistantClient
from jarvis_api.smarthome.migration import migrate_all
from jarvis_api.smarthome.service import SmartHomeService
from jarvis_api.speech import SpeechService
from jarvis_api.store import SqliteStore
from jarvis_api.task_notifications import TaskNotificationService
from jarvis_api.tools import ToolRegistry
from jarvis_api.vision import VisionClient
from jarvis_api.voice import VoiceConnectionHub


def create_app(
    settings: Optional[Settings] = None,
    llm: Optional[LocalLlmClient] = None,
    speech_service: Optional[SpeechService] = None,
    code_factory_client: Optional[CodeFactoryClient] = None,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings.ensure_directories()
        logging.basicConfig(
            level=getattr(logging, settings.log_level, logging.INFO),
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )
        for problem in settings.validate_for_production():
            logging.getLogger(__name__).warning(problem)
        store = SqliteStore(str(settings.database_path))
        await store.start()
        auth_service = AuthService(store, settings)
        await auth_service.bootstrap()
        capabilities = Capabilities(store)
        events = EventHub()
        voice_connections = VoiceConnectionHub()
        llm_client = llm or LocalLlmClient(settings)
        speech_client = speech_service or SpeechService(settings)
        coding_client = code_factory_client or CodeFactoryClient(
            settings.code_factory_url,
            settings.code_factory_request_timeout_seconds,
        )
        vault = CredentialVault(store, settings.jwt_secret)
        home_assistant_http = httpx.AsyncClient(
            timeout=settings.home_assistant_request_timeout_seconds
        )
        home_assistant = HomeAssistantClient(
            settings.home_assistant_url,
            settings.home_assistant_token,
            home_assistant_http,
            settings.home_assistant_request_timeout_seconds,
        )
        smart_home = SmartHomeService(store, home_assistant)
        integration_service = IntegrationService(store, settings, vault, smart_home)
        push_client = ExpoPushClient(integration_service.http)
        task_notifications = TaskNotificationService(store, coding_client, push_client)
        vision = VisionClient(settings)
        tools = ToolRegistry(
            capabilities,
            integration_service,
            settings.timezone,
            vision,
            vault,
            code_factory=coding_client,
            task_notifications=task_notifications,
        )
        agent = JarvisAgent(store, llm_client, capabilities, tools, asset_dir=settings.asset_dir)
        scheduler = TimerScheduler(store, events, settings.timer_poll_seconds)

        app.state.settings = settings
        app.state.store = store
        app.state.auth = auth_service
        app.state.capabilities = capabilities
        app.state.events = events
        app.state.voice_connections = voice_connections
        app.state.banter = BanterService(llm_client, voice_connections)
        app.state.llm = llm_client
        app.state.speech = speech_client
        app.state.code_factory = coding_client
        app.state.vault = vault
        app.state.integrations = integration_service
        app.state.smart_home = smart_home
        app.state.push = push_client
        app.state.task_notifications = task_notifications
        app.state.vision = vision
        app.state.tools = tools
        app.state.agent = agent
        app.state.scheduler = scheduler
        scheduler.start()
        task_notifications.start()
        # Reshape any vendor-era smart-device rows before a client can read them.
        # A failure here must not stop the API from serving everything else.
        try:
            await migrate_all(store)
        except Exception:
            logging.getLogger(__name__).exception("smart-home migration failed")
        try:
            yield
        finally:
            await task_notifications.stop()
            await scheduler.stop()
            await tools.close()
            await vision.close()
            await integration_service.close()
            await home_assistant_http.aclose()
            await coding_client.close()
            await speech_client.close()
            await llm_client.close()
            await store.close()

    app = FastAPI(
        title="Jarvis API",
        version="0.1.0",
        description="Local-first, single-agent home assistant API",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials="*" not in settings.cors_origins,
    )

    @app.get("/health/live", tags=["health"])
    async def live() -> dict:
        return {"status": "ok"}

    @app.get("/health/ready", tags=["health"])
    async def ready(request: Request) -> dict:
        try:
            cursor = await request.app.state.store.db.execute("SELECT 1")
            await cursor.fetchone()
            await cursor.close()
            database = True
        except Exception:
            database = False
        llm_ready = await request.app.state.llm.ready()
        speech_ready = await request.app.state.speech.ready()
        status = "ok" if database and llm_ready and all(speech_ready.values()) else "degraded"
        payload = {
            "status": status,
            "database": database,
            "llm": llm_ready,
            "speech": speech_ready,
        }
        if status != "ok":
            raise HTTPException(status_code=503, detail=payload)
        return payload

    app.include_router(auth.router)
    app.include_router(code_tasks.router)
    app.include_router(research_tasks.router)
    app.include_router(conversations.router)
    app.include_router(personal.router)
    app.include_router(projects.router)
    app.include_router(devices.router)
    app.include_router(integrations.router)
    app.include_router(smart_home_routes.router)
    app.include_router(speech.router)
    app.include_router(banter.router)
    app.include_router(realtime.router)
    app.include_router(wear.router)
    return app


app = create_app()
