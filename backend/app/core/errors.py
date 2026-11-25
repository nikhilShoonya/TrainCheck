"""The one error shape used by every API (DATABASE_API_DESIGN.md §8.3, §12)."""
import logging
import uuid
from contextvars import ContextVar
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("traincheck")
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def new_request_id() -> str:
    return uuid.uuid4().hex


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def not_found(message: str = "This record does not exist or is not available to you.") -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def forbidden(message: str = "Your role cannot perform this action.") -> ApiError:
    return ApiError(403, "FORBIDDEN", message)


def validation(message: str, details: Any = None) -> ApiError:
    return ApiError(400, "VALIDATION_ERROR", message, details)


def conflict(code: str, message: str, details: Any = None) -> ApiError:
    return ApiError(409, code, message, details)


def error_body(code: str, message: str, details: Any = None) -> dict:
    body: dict[str, Any] = {"code": code, "message": message, "request_id": request_id_var.get()}
    if details is not None:
        body["details"] = details
    return {"error": body}


FOREIGN_KEY_VIOLATION = "23503"
CONCURRENCY_SQLSTATES = {"40P01", "40001", "55P03"}  # deadlock_detected, serialization_failure, lock_not_available.


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.message, jsonable_encoder(exc.details)), headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # The rejected input is left out: it might hold a password.
        details = [{"field": ".".join(str(p) for p in e["loc"] if p != "body"), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse(status_code=400, content=error_body("VALIDATION_ERROR", "Some fields need correction.", details))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(status_code=exc.status_code, content=error_body(code, str(exc.detail)))

    @app.exception_handler(IntegrityError)
    async def _integrity(_: Request, exc: IntegrityError) -> JSONResponse:
        # Endpoints report the conflicts they expect themselves. A foreign-key failure that reaches here means a
        # record this change refers to was deleted meanwhile (for example a permanently deleted training).
        if getattr(exc.orig, "sqlstate", None) == FOREIGN_KEY_VIOLATION:
            logger.warning("Write refused: a referenced record was deleted meanwhile (%s)", type(exc.orig).__name__)
            return JSONResponse(status_code=409, content=error_body("RECORD_REMOVED", "A record this change refers to was deleted meanwhile. Reload the page and try again."))
        logger.exception("Unhandled integrity error", exc_info=exc)
        return JSONResponse(status_code=500, content=error_body("INTERNAL_ERROR", "Something went wrong. Quote the reference if you contact support."))

    @app.exception_handler(OperationalError)
    async def _database_down(_: Request, exc: OperationalError) -> JSONResponse:
        if getattr(exc.orig, "sqlstate", None) in CONCURRENCY_SQLSTATES:
            # Two requests waited for each other's records (or a lock wait timed out): one was stopped and nothing it
            # did was saved. Not an outage.
            logger.warning("Request stopped by a concurrent change (%s)", type(exc.orig).__name__)
            return JSONResponse(status_code=409, content=error_body("CONCURRENT_CHANGE", "Another change to the same records was being saved at the same moment, so nothing was saved. Reload the page and try again."))
        # Fails closed: no gate decision can be made, so no protected data is returned (TC-GATE-010).
        # The driver's first line names the cause (dropped connection, timeout, ...) without query parameters.
        detail = str(getattr(exc, "orig", None) or "").strip().splitlines()[:1]
        logger.error("Database unavailable: %s %s", type(exc).__name__, detail[0] if detail else "")
        return JSONResponse(status_code=503, content=error_body("SERVICE_UNAVAILABLE", "TrainCheck is temporarily unavailable. Please try again shortly."))

    @app.exception_handler(PoolTimeoutError)
    async def _pool_exhausted(_: Request, exc: PoolTimeoutError) -> JSONResponse:
        # Every database connection stayed busy for DB_POOL_TIMEOUT seconds: an overload, not a bug. Fails closed
        # like an outage, and tells the browser when to retry (the answer-save queue honours Retry-After).
        logger.error("Database connection pool exhausted: %s", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content=error_body("SERVICE_UNAVAILABLE", "TrainCheck is very busy right now. Please try again in a few seconds."),
            headers={"Retry-After": "5"},
        )

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error", exc_info=exc)
        return JSONResponse(status_code=500, content=error_body("INTERNAL_ERROR", "Something went wrong. Quote the reference if you contact support."))
