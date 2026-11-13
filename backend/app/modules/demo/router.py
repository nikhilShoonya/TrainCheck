"""Demo environment controls: put the synthetic demo data back to its starting state.

Called from the sign-in page, so it needs no session. That is why it is off unless DEMO_RESET_ENABLED=true,
is always refused in production, is rate limited, and only accepts a JSON body: a cross-site form post
cannot send application/json without a CORS preflight, which only CORS_ORIGINS pass.

Generating the data takes minutes against a remote database, longer than a browser or proxy will wait for
one request. So the reset runs in the background: POST starts it and answers at once, and GET /demo/status
reports its progress. The live tables stay usable (sign-in included) until a final switch of a few seconds.
"""
import logging
import threading
import time
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.core import ratelimit
from app.core.config import get_settings
from app.core.errors import ApiError, not_found
from app.core.responses import ok

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/demo", tags=["Demo"])


class ResetIn(BaseModel):
    confirm: Literal["RESET"]


class _ResetJob:
    """The one reset this process may run at a time, and the outcome of the last one."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state: str = "IDLE"  # IDLE, RUNNING, DONE, FAILED
        self.started_at: datetime | None = None
        self.finished_at: datetime | None = None
        self.error: str | None = None
        self.finished = threading.Event()
        self.finished.set()

    def view(self) -> dict:
        with self.lock:
            elapsed = None
            if self.started_at:
                elapsed = int(((self.finished_at or datetime.now(UTC)) - self.started_at).total_seconds())
            return {
                "state": self.state,
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "finished_at": self.finished_at.isoformat() if self.finished_at else None,
                "elapsed_seconds": elapsed,
                "error": self.error,
            }

    def start(self) -> bool:
        with self.lock:
            if self.state == "RUNNING":
                return False
            self.state, self.started_at, self.finished_at, self.error = "RUNNING", datetime.now(UTC), None, None
            self.finished.clear()
        threading.Thread(target=self._run, name="demo-reset", daemon=True).start()
        return True

    def _run(self) -> None:
        began = time.monotonic()
        try:
            from app.seed import reset_and_seed  # Imported here: the seed pulls in every service module.

            reset_and_seed()
            outcome, error = "DONE", None
            logger.warning("Demo data reset finished in %.0f s", time.monotonic() - began)
        except Exception:
            logger.exception("Demo data reset failed; the previous data was kept")
            outcome, error = "FAILED", "The reset failed, so the previous data was kept. Please try again."
        with self.lock:
            self.state, self.finished_at, self.error = outcome, datetime.now(UTC), error
        self.finished.set()


job = _ResetJob()


def _reset_allowed() -> bool:
    settings = get_settings()
    return settings.demo_reset_enabled and not settings.is_production


@router.get("/status")
def status() -> dict:
    allowed = _reset_allowed()
    return ok({"reset_enabled": allowed, "reset": job.view() if allowed else None})


@router.post("/reset", status_code=202, dependencies=[ratelimit.expensive("demo_reset")])
def reset_demo_data(body: ResetIn, request: Request):
    if not _reset_allowed():
        raise not_found("Demo data reset is not available in this environment.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the reset request as JSON.")
    if not job.start():
        return JSONResponse(status_code=202, content=ok({"started": False, "reset": job.view()}))
    logger.warning("Demo data reset started from %s", ratelimit.client_ip_for(request))
    return ok({"started": True, "reset": job.view()})
