"""The induction part of the sign-in gate (owner decision of 27 Nov 2026).

An employee with an assigned, unfinished induction is required to take the induction assessment straight after
sign-in, then give the induction feedback; the workspace opens after both. It is decided here, once, for both the
access-state answer and the server-side gate on every protected API.

- No assignment, or a completed one: nothing is required.
- An attempt running, or feedback pending: required (their content is frozen, so it can always continue).
- Assigned, not started: required only while it can actually start (the common configuration is ready and the card
  is not archived). Otherwise it does not lock anyone out; L&D is alerted once a day.
"""
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import AttemptStatus, InductionAssignmentStatus, InductionStatus
from app.core.responses import iso
from app.models import InductionAssignment, InductionAttempt, InductionProgramme
from app.modules.induction import configuration, engine
from app.modules.induction.common import batch_label

ASSESSMENT = "INDUCTION_REQUIRED"
FEEDBACK = "INDUCTION_FEEDBACK_REQUIRED"


def requirement(db: Session, employee_id: uuid.UUID, now: datetime, alert: bool = False) -> dict | None:
    """What the employee must do for their induction now, or None. `kind` is ASSESSMENT, FEEDBACK or UNAVAILABLE
    (assigned but not startable: shown, never blocking). Finalises an attempt whose time ran out."""
    row = db.execute(
        select(InductionAssignment.id, InductionAssignment.status, InductionProgramme.status, InductionProgramme.name)
        .join(InductionProgramme, InductionProgramme.id == InductionAssignment.induction_id)
        .where(InductionAssignment.employee_id == employee_id, InductionAssignment.status != InductionAssignmentStatus.COMPLETED)
    ).first()
    if row is None:
        return None
    assignment_id, status, induction_status, name = row
    if status == InductionAssignmentStatus.IN_PROGRESS:
        engine.finalise_expired(db, employee_id, now)
        status = db.scalar(select(InductionAssignment.status).where(InductionAssignment.id == assignment_id))
    base = {"assignment_id": str(assignment_id), "induction_name": name}
    if status == InductionAssignmentStatus.FEEDBACK_PENDING:
        attempt_id = db.scalar(select(InductionAttempt.id).where(InductionAttempt.assignment_id == assignment_id))
        return {**base, "kind": "FEEDBACK", "attempt_id": str(attempt_id) if attempt_id else None}
    if status == InductionAssignmentStatus.IN_PROGRESS:
        attempt_id = db.scalar(select(InductionAttempt.id).where(InductionAttempt.assignment_id == assignment_id, InductionAttempt.status == AttemptStatus.IN_PROGRESS))
        return {**base, "kind": "ASSESSMENT", "in_progress": True, "attempt_id": str(attempt_id) if attempt_id else None}
    if induction_status == InductionStatus.ARCHIVED:
        return None
    ready = configuration.readiness(db)
    if not ready["ready"]:
        if alert:
            _alert_not_ready(db, ready, now)
        return {**base, "kind": "UNAVAILABLE", "reason": "INDUCTION_NOT_READY"}
    return {**base, "kind": "ASSESSMENT", "in_progress": False, "attempt_id": None}


def blocking_code(db: Session, employee_id: uuid.UUID, now: datetime) -> str | None:
    found = requirement(db, employee_id, now)
    if found is None or found["kind"] == "UNAVAILABLE":
        return None
    return ASSESSMENT if found["kind"] == "ASSESSMENT" else FEEDBACK


def _alert_not_ready(db: Session, ready: dict, now: datetime) -> None:
    from app.modules.notifications.service import notify_roles

    problems = ready["assessment"]["problems"] + ready["feedback"]["problems"]
    notify_roles(
        db,
        ("LD_ADMIN",),
        "INDUCTION_NOT_READY",
        "Induction assessment is not ready",
        "An employee is waiting to take the induction assessment, but the common configuration is incomplete. " + " ".join(problems),
        "/lnd/induction?tab=assessment",
        f"induction-not-ready:{now.date().isoformat()}",
        now,
    )


def employee_state(db: Session, employee_id: uuid.UUID, now: datetime) -> dict:
    """The employee's own induction, for their Induction page and the gate screens."""
    assignment = engine.own_assignment(db, employee_id)
    if assignment is None:
        return {"assigned": False}
    found = requirement(db, employee_id, now, alert=True)
    db.refresh(assignment)
    attempt = engine.attempt_of(db, assignment.id)
    settings = configuration.current_settings(db)
    facts = None
    if attempt is not None:
        snap = attempt.config_snapshot
        facts = {"question_count": snap["question_count"], "duration_seconds": snap["duration_seconds"], "pass_mark_percent": float(snap["pass_mark_percent"]), "violation_limit": snap["violation_limit"], "require_fullscreen": bool(snap["require_fullscreen"])}
    elif settings is not None:
        facts = {"question_count": len(configuration.active_questions(db)), "duration_seconds": settings.duration_seconds, "pass_mark_percent": float(settings.pass_mark_percent), "violation_limit": settings.violation_limit, "require_fullscreen": settings.require_fullscreen}
    induction = assignment.induction
    return {
        "assigned": True,
        "assignment_id": str(assignment.id),
        "status": assignment.status,
        "induction": {"id": str(induction.id), "name": induction.name, "description": induction.description, "department": induction.department.name},
        "batch_label": batch_label(assignment.batch),
        "assigned_at": iso(assignment.assigned_at),
        "completed_at": iso(assignment.completed_at),
        "ready": found is None or found["kind"] != "UNAVAILABLE",
        "requirement": found["kind"] if found else None,
        "facts": facts,
        "attempt": {"id": str(attempt.id), "status": attempt.status, "result_status": attempt.result_status, "submitted_at": iso(attempt.submitted_at), "expires_at": iso(attempt.expires_at)} if attempt else None,
        "active_attempt_id": str(attempt.id) if attempt and attempt.status == AttemptStatus.IN_PROGRESS else None,
    }
