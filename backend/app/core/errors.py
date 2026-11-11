"""The one error shape used by every API (DATABASE_API_DESIGN.md §8.3, §12)."""
import logging
import uuid
from contextvars import ContextVar
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("traincheck")
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def new_request_id() -> str:
    return uuid.uuid4().hex


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


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


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.message, jsonable_encoder(exc.details)))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # The rejected input is left out: it might hold a password.
        details = [{"field": ".".join(str(p) for p in e["loc"] if p != "body"), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse(status_code=400, content=error_body("VALIDATION_ERROR", "Some fields need correction.", details))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(status_code=exc.status_code, content=error_body(code, str(exc.detail)))

    @app.exception_handler(OperationalError)
    async def _database_down(_: Request, exc: OperationalError) -> JSONResponse:
        # Fails closed: no gate decision can be made, so no protected data is returned (TC-GATE-010).
        logger.error("Database unavailable: %s", type(exc).__name__)
        return JSONResponse(status_code=503, content=error_body("SERVICE_UNAVAILABLE", "TrainCheck is temporarily unavailable. Please try again shortly."))

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error", exc_info=exc)
        return JSONResponse(status_code=500, content=error_body("INTERNAL_ERROR", "Something went wrong. Quote the reference if you contact support."))
