"""The employee's own induction: entry state, the one assessment attempt, its result and the feedback form.

These routes are on the gate-exempt allowlist (tests/test_gate.py): they are what the INDUCTION_REQUIRED and
INDUCTION_FEEDBACK_REQUIRED gates ask for. Each still needs the employee's session, and every attempt, question and
feedback request is checked against the signed-in employee's own assignment on the server.
"""
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_session
from app.core.enums import AttemptStatus, SecurityEventType
from app.core.errors import conflict, not_found
from app.core.responses import iso, ok
from app.core.routing import ReleasingRoute
from app.modules.assessment.gate import access_state
from app.modules.induction import engine
from app.modules.induction.gate import employee_state

router = APIRouter(route_class=ReleasingRoute, prefix="/me/induction", tags=["Induction (employee)"])


class StartIn(BaseModel):
    instructions_acknowledged: bool = False


class SaveAnswerIn(BaseModel):
    selected_option_ids: list[str] = Field(default_factory=list, max_length=20)
    base_revision: int | None = Field(default=None, ge=0)
    op_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$")


class MarkIn(BaseModel):
    marked: bool


class SecurityEventIn(BaseModel):
    event_type: SecurityEventType


@router.get("")
def my_induction(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    state = employee_state(db, user.employee_id, utcnow())
    db.commit()  # Keeps a timeout finalised while reading, and any not-ready alert.
    return ok(state)


@router.post("/attempt")
def start(body: StartIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    """Starts the one attempt, or returns the attempt already running. Never a second attempt."""
    attempt = engine.start_attempt(db, user.employee_id, body.instructions_acknowledged)
    db.commit()
    return ok(engine.attempt_view(db, attempt))


def _own(db: Session, attempt_id: uuid.UUID, user: CurrentUser):
    return engine.get_own_attempt(db, attempt_id, user.employee_id)


@router.get("/attempts/{attempt_id}")
def get_attempt(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = _own(db, attempt_id, user)
    if attempt.status == AttemptStatus.IN_PROGRESS and attempt.expires_at <= utcnow():
        engine.finalise_attempt(db, attempt.id)
        db.commit()
    return ok(engine.attempt_view(db, attempt))


@router.put("/attempts/{attempt_id}/questions/{attempt_question_id}/answer")
def save_answer(attempt_id: uuid.UUID, attempt_question_id: uuid.UUID, body: SaveAnswerIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = _own(db, attempt_id, user)
    answer = engine.save_answer(db, attempt, attempt_question_id, body.selected_option_ids, base_revision=body.base_revision, op_id=body.op_id)
    db.commit()
    return ok({"saved_at": iso(answer.saved_at), "selected_option_ids": answer.selected_option_ids, "revision": answer.revision, "op_id": answer.last_op_id})


@router.post("/attempts/{attempt_id}/questions/{attempt_question_id}/mark")
def mark_question(attempt_id: uuid.UUID, attempt_question_id: uuid.UUID, body: MarkIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = _own(db, attempt_id, user)
    engine.set_review_mark(db, attempt, attempt_question_id, body.marked)
    db.commit()
    return ok({"marked": body.marked})


@router.post("/attempts/{attempt_id}/security-events")
def security_event(attempt_id: uuid.UUID, body: SecurityEventIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = _own(db, attempt_id, user)
    result = engine.record_security_event(db, attempt, body.event_type)
    db.commit()
    return ok(result)


@router.post("/attempts/{attempt_id}/submit")
def submit(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    """Takes no score, marks or time from the client. A repeat returns the stored result."""
    attempt = _own(db, attempt_id, user)
    attempt = engine.finalise_attempt(db, attempt.id)
    db.commit()
    return ok({**engine.result_view(db, attempt), "access_state": access_state(db, user.employee_id)})


@router.get("/attempts/{attempt_id}/result")
def result(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = _own(db, attempt_id, user)
    if attempt.status == AttemptStatus.IN_PROGRESS and attempt.expires_at <= utcnow():
        attempt = engine.finalise_attempt(db, attempt.id)
        db.commit()
    if attempt.result_status is None:
        raise conflict("RESULT_NOT_READY", "This attempt has not been submitted yet.")
    return ok(engine.result_view(db, attempt))


@router.get("/feedback")
def get_feedback(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    assignment = engine.own_assignment(db, user.employee_id)
    if assignment is None:
        raise not_found("No induction is assigned to you.")
    return ok(engine.feedback_view(db, assignment))


@router.post("/feedback")
def submit_feedback(body: engine.FeedbackIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    assignment = engine.submit_feedback(db, user.employee_id, body)
    db.commit()
    return ok(engine.feedback_view(db, assignment))
