"""TrainCheck API: one FastAPI application, organised by business module."""
import logging
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from time import monotonic

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.errors import error_body, install_error_handlers, new_request_id, request_id_var
from app.modules.assessment.router import router as assessment_router
from app.modules.audit.router import router as admin_misc_router
from app.modules.behaviour.router import router as behaviour_router
from app.modules.employee.router import router as employee_router
from app.modules.identity.router import router as identity_router
from app.modules.imports.router import router as imports_router
from app.modules.manager.router import router as manager_router
from app.modules.notifications.router import router as notifications_router
from app.modules.organisation.router import router as organisation_router
from app.modules.question_bank.router import router as question_router
from app.modules.reports.router import router as reports_router
from app.modules.scheduler.jobs import build_scheduler
from app.modules.training.router import router as training_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

API_PREFIX = "/api/v1"
RATE_LIMIT_PER_MINUTE = 600  # Per client address. Sign-in has its own stricter, database-backed limit.
_hits: dict[str, deque[float]] = defaultdict(deque)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    scheduler = build_scheduler() if settings.scheduler_enabled else None
    if scheduler:
        scheduler.start()
    yield
    if scheduler:
        scheduler.shutdown(wait=False)


def create_app() -> FastAPI:
    settings = get_settings()
    docs_enabled = not settings.is_production
    app = FastAPI(
        title="TrainCheck API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs" if docs_enabled else None,
        openapi_url=f"{API_PREFIX}/openapi.json" if docs_enabled else None,
        redoc_url=None,
    )
    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        token = request_id_var.set(new_request_id())
        try:
            client = request.client.host if request.client else "unknown"
            window = _hits[client]
            now = monotonic()
            while window and now - window[0] > 60:
                window.popleft()
            if settings.app_env != "test" and len(window) >= RATE_LIMIT_PER_MINUTE:
                return JSONResponse(status_code=429, content=error_body("RATE_LIMITED", "Too many requests. Please wait a moment."))
            window.append(now)
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id_var.get()
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["X-Frame-Options"] = "DENY"
            response.headers["Referrer-Policy"] = "same-origin"
            response.headers["Cache-Control"] = response.headers.get("Cache-Control", "no-store")
            if settings.session_cookie_secure:
                response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            return response
        finally:
            request_id_var.reset(token)

    api = APIRouter(prefix=API_PREFIX)
    for router in (
        identity_router,
        assessment_router,
        employee_router,
        manager_router,
        notifications_router,
        behaviour_router,
        training_router,
        organisation_router,
        question_router,
        imports_router,
        reports_router,
        admin_misc_router,
    ):
        api.include_router(router)
    app.include_router(api)
    return app


app = create_app()
