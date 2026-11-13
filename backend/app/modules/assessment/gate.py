"""The mandatory login gate decision (Business Rules §5). One function, used everywhere.

An obligation blocks the employee only while it can actually be taken. If its question pool stops
satisfying its configuration after it was scheduled (for example, questions were deactivated), it
cannot start, so it must not lock the employee out of the whole application. Such an obligation is
kept unchanged, reported as unavailable, and L&D is alerted. It blocks again automatically as soon
as the pool can run, or after L&D moves it onto a valid configuration.
"""
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.clock import utcnow
from app.core.enums import AssessmentType, AttemptStatus, ObligationStatus
from app.core.responses import iso
from app.models import AssessmentAttempt, AssessmentObligation

BLOCKING_STATUSES = (ObligationStatus.SCHEDULED, ObligationStatus.DUE, ObligationStatus.IN_PROGRESS)


def finalise_expired_attempts(db: Session, employee_id: uuid.UUID, now: datetime) -> None:
    """A deadline that passes with nobody connected still produces exactly one result."""
    from app.modules.assessment.service import finalise_attempt

    expired = db.scalars(
        select(AssessmentAttempt).where(
            AssessmentAttempt.employee_id == employee_id,
            AssessmentAttempt.status == AttemptStatus.IN_PROGRESS,
            AssessmentAttempt.expires_at <= now,
        )
    ).all()
    for attempt in expired:
        finalise_attempt(db, attempt.id, now=now)


def obligation_startable(db: Session, obligation: AssessmentObligation, cache: dict, pools=None) -> bool:
    """Whether the obligation's own configuration can still draw a full assessment. Cached per config."""
    from app.modules.assessment.service import pool_problem

    if obligation.status == ObligationStatus.IN_PROGRESS:
        return True  # The questions were drawn when the attempt started.
    if obligation.config_id not in cache:
        cache[obligation.config_id] = pool_problem(db, obligation.config, pools) is None
    return cache[obligation.config_id]


def due_post_tests(db: Session, employee_id: uuid.UUID, now: datetime) -> list[AssessmentObligation]:
    """Due post-tests, oldest training completion first (BR §4.4). A pre-test never blocks."""
    return list(
        db.scalars(
            select(AssessmentObligation)
            .options(joinedload(AssessmentObligation.training), joinedload(AssessmentObligation.config))
            .where(
                AssessmentObligation.employee_id == employee_id,
                AssessmentObligation.assessment_type == AssessmentType.POST_TEST,
                AssessmentObligation.status.in_(BLOCKING_STATUSES),
                AssessmentObligation.due_at <= now,
            )
            .order_by(AssessmentObligation.completed_training_at, AssessmentObligation.created_at, AssessmentObligation.id)
        )
    )


def blocking_obligations(db: Session, employee_id: uuid.UUID, now: datetime | None = None) -> list[AssessmentObligation]:
    """The gate queue: due post-tests that can be started, oldest training completion first."""
    now = now or utcnow()
    finalise_expired_attempts(db, employee_id, now)
    cache: dict = {}
    return [o for o in due_post_tests(db, employee_id, now) if obligation_startable(db, o, cache)]


def unavailable_obligations(db: Session, employee_id: uuid.UUID, now: datetime | None = None) -> list[AssessmentObligation]:
    """Due post-tests that cannot start because their question pool no longer suffices."""
    now = now or utcnow()
    cache: dict = {}
    return [o for o in due_post_tests(db, employee_id, now) if not obligation_startable(db, o, cache)]


def alert_unavailable(db: Session, obligations: list[AssessmentObligation], now: datetime) -> None:
    """Tells L&D and the employee once per obligation. Safe to call on every sign-in."""
    from app.modules.notifications.service import notify_employee, notify_roles

    for obligation in obligations:
        employee, title = obligation.employee, obligation.training.title
        notify_roles(
            db,
            ("LD_ADMIN",),
            "ASSESSMENT_UNAVAILABLE",
            f"Assessment cannot start: {title}",
            f"{employee.full_name} ({employee.employee_code}) has a due assessment for {title}, but its question pool no longer satisfies "
            "the assessment configuration. The employee is not blocked meanwhile. Add or reactivate questions, or update the configuration, "
            "then open the training in Training Management and select Schedule pending assessments.",
            "/lnd/assessment-config",
            f"unavailable:{obligation.id}",
            now,
        )
        notify_employee(
            db,
            obligation.employee_id,
            "ASSESSMENT_UNAVAILABLE",
            f"Assessment temporarily unavailable: {title}",
            "Your mandatory assessment cannot open yet because L&D is updating its questions. You can use TrainCheck meanwhile; "
            "you will be asked to complete the assessment as soon as it is ready.",
            None,
            f"unavailable:{obligation.id}",
            now,
        )


def promote_due_retakes(db: Session, employee_id: uuid.UUID, now: datetime) -> None:
    """Run at sign-in. Provisional default (OD-BRD-006, OD-BRD-007): a retake becomes due at the next
    login once the refresher is acknowledged or the next working day has arrived."""
    pending = db.scalars(
        select(AssessmentObligation).where(
            AssessmentObligation.employee_id == employee_id,
            AssessmentObligation.status == ObligationStatus.RETAKE_PENDING,
        )
    )
    for obligation in pending:
        if obligation.refresher_acknowledged_at or (obligation.retake_eligible_at and obligation.retake_eligible_at <= now):
            obligation.status = ObligationStatus.DUE
            obligation.due_at = now


def queue_item(obligation: AssessmentObligation, position: int) -> dict:
    config = obligation.config
    return {
        "obligation_id": str(obligation.id),
        "training_id": str(obligation.training_id),
        "training_title": obligation.training.title,
        "training_description": obligation.training.description,
        "question_count": config.question_count,
        "duration_seconds": config.duration_seconds,
        "pass_mark_percent": float(config.pass_mark_percent),
        "max_attempts": config.max_attempts,
        "attempts_used": sum(1 for a in obligation.attempts if a.status != AttemptStatus.CANCELLED),
        "due_at": iso(obligation.due_at),
        "in_progress": obligation.status == ObligationStatus.IN_PROGRESS,
        "refresher_required": bool(obligation.attempts) and obligation.refresher_acknowledged_at is None,
        "queue_order": position,
    }


def access_state(db: Session, employee_id: uuid.UUID) -> dict:
    now = utcnow()
    queue = blocking_obligations(db, employee_id, now)
    unavailable = unavailable_obligations(db, employee_id, now)
    if unavailable:
        alert_unavailable(db, unavailable, now)
    db.commit()  # Persist any timeout finalised above and any alert.
    held = [{"obligation_id": str(o.id), "training_title": o.training.title, "reason": "QUESTION_POOL_INSUFFICIENT"} for o in unavailable]
    if not queue:
        return {"access_status": "DASHBOARD_ALLOWED", "pending_count": 0, "next_action": "OPEN_DASHBOARD", "queue": [], "unavailable": held}
    return {
        "access_status": "ASSESSMENT_REQUIRED",
        "pending_count": len(queue),
        "next_action": "COMPLETE_ASSESSMENT",
        "queue": [queue_item(o, i + 1) for i, o in enumerate(queue)],
        "unavailable": held,
    }
