"""The mandatory login gate decision (Business Rules §5). One function, used everywhere."""
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


def blocking_obligations(db: Session, employee_id: uuid.UUID, now: datetime | None = None) -> list[AssessmentObligation]:
    """Due post-tests, oldest training completion first (BR §4.4). A pre-test never blocks."""
    now = now or utcnow()
    finalise_expired_attempts(db, employee_id, now)
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
    queue = blocking_obligations(db, employee_id)
    db.commit()  # Persist any timeout finalised above.
    if not queue:
        return {"access_status": "DASHBOARD_ALLOWED", "pending_count": 0, "next_action": "OPEN_DASHBOARD", "queue": []}
    return {
        "access_status": "ASSESSMENT_REQUIRED",
        "pending_count": len(queue),
        "next_action": "COMPLETE_ASSESSMENT",
        "queue": [queue_item(o, i + 1) for i, o in enumerate(queue)],
    }
