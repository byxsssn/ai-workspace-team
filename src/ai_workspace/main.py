import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ai_workspace.api.routes.auth import router as auth_router
from ai_workspace.api.routes.chat import router as chat_router
from ai_workspace.api.routes.conversations import router as conversations_router
from ai_workspace.api.routes.provider_credentials import (
    router as provider_credentials_router,
)
from ai_workspace.api.routes.users import router as users_router
from ai_workspace.core.config import get_settings


def _configure_provider_logging() -> None:
    """Keep upstream headers, bodies and SDK exceptions out of verbose logs."""
    loggers = [logging.getLogger(name) for name in ("openai", "httpx2", "httpcore2")]
    while loggers:
        logger = loggers.pop()
        logger.setLevel(logging.WARNING)
        loggers.extend(logger.getChildren())


# Run after the SDK imports, which may enable logging through OPENAI_LOG.
_configure_provider_logging()

settings = get_settings()
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    debug=settings.debug,
)
app.include_router(users_router)
app.include_router(auth_router)
app.include_router(conversations_router)
app.include_router(chat_router)
app.include_router(provider_credentials_router)

static_directory = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_directory), name="static")


@app.get("/", include_in_schema=False)
def workspace() -> FileResponse:
    return FileResponse(static_directory / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
