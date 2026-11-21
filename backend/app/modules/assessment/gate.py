"""The mandatory login gate decision (Business Rules §5). One function, used everywhere.

An obligation blocks the employee only while it can actually be taken. If its question pool stops
satisfying its configuration after it was scheduled (for example, questions were deactivated), it
cannot start, so it must not lock the employee out of the whole application. Such an obligation is
kept unchanged, reported as unavailable, and L&D is alerted. It blocks again automatically as soon
as the pool can run, or after L&D moves it onto a valid configuration.
"""
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.core.clock import utcnow
from app.core.enums import AssessmentType, AttemptStatus, ObligationStatus
from app.core.responses import iso
from app.models import AssessmentAttempt, AssessmentObligation

BLOCKING_STATUSES = (ObligationStatus.SCHEDULED, ObligationStatus.DUE, ObligationStatus.IN_PROGRESS)


def training_not_archived():
    """Assessments of an archived training never block or remind (decision of 19 Nov 2026). Records are kept, and
    reactivating the training brings them back."""
    from app.core.enums import TrainingStatus
    from app.models import Training

    return AssessmentObligation.training.has(Training.status != TrainingStatus.ARCHIVED)


def finalise_expired_attempts(db: Session, employee_id: uuid.UUID, now: datetime) -> None:
    """A deadline that passes with nobody connected still produces exactly one result.

    Runs on every protected request, so an attempt that cannot be finalised (which database constraints should make
    impossible) is logged and left for the scheduler and L&D, instead of failing every page this employee opens."""
    import logging

    from app.modules.assessment import service

    expired = db.scalars(
        select(AssessmentAttempt).where(
            AssessmentAttempt.employee_id == employee_id,
            AssessmentAttempt.status == AttemptStatus.IN_PROGRESS,
            AssessmentAttempt.expires_at <= now,
        )
    ).all()
    for attempt in expired:
        try:
            with db.begin_nested():
                service.finalise_attempt(db, attempt.id, now=now)
        except Exception:
            logging.getLogger("traincheck.gate").exception("Could not finalise expired attempt %s", attempt.id)


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
                training_not_archived(),
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


def finished_attempts(obligation: AssessmentObligation) -> int:
    """Attempts that produced a result. An attempt still running is not a previous attempt."""
    return sum(1 for a in obligation.attempts if a.status not in (AttemptStatus.CANCELLED, AttemptStatus.IN_PROGRESS))


def refresher_required(obligation: AssessmentObligation) -> bool:
    """A refresher is owed only before a retake: after a finished attempt, and not while one is running."""
    return obligation.status != ObligationStatus.IN_PROGRESS and finished_attempts(obligation) > 0 and obligation.refresher_acknowledged_at is None


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
        "refresher_required": refresher_required(obligation),
        "queue_order": position,
    }


def feedback_cutoff() -> datetime | None:
    """The moment from which post-test feedback is required (FEEDBACK_REQUIRED_FROM), or None for always."""
    from datetime import date, time
    from zoneinfo import ZoneInfo

    from app.core.config import get_settings

    settings = get_settings()
    raw = (settings.feedback_required_from or "").strip()
    if not raw:
        return None
    return datetime.combine(date.fromisoformat(raw), time.min, ZoneInfo(settings.default_timezone))


def _result_before_cutoff(cutoff: datetime):
    """True for an assessment that already had a result before feedback became required: it is never asked."""
    earlier = AssessmentAttempt.__table__.alias("earlier")
    return (
        select(earlier.c.id)
        .where(earlier.c.obligation_id == AssessmentAttempt.obligation_id, earlier.c.result_status.is_not(None), earlier.c.submitted_at < cutoff)
        .exists()
    )


def feedback_exempt(db: Session, obligation_id: uuid.UUID) -> bool:
    """Whether this assessment's first result predates the feedback cutoff, so no feedback is required for it."""
    cutoff = feedback_cutoff()
    if cutoff is None:
        return False
    return db.scalar(
        select(AssessmentAttempt.id)
        .where(AssessmentAttempt.obligation_id == obligation_id, AssessmentAttempt.result_status.is_not(None), AssessmentAttempt.submitted_at < cutoff)
        .limit(1)
    ) is not None


def feedback_due(db: Session, employee_id: uuid.UUID) -> dict | None:
    """The oldest post-training assessment whose feedback is still owed (asked once per assessment).

    Feedback is required, so an owed form closes the workspace exactly like a due assessment does; it is
    collected on that assessment's result page. Due assessments come first (see access_state). Assessments
    whose first result came before FEEDBACK_REQUIRED_FROM are never asked.
    """
    from app.models import AssessmentFeedback

    cutoff = feedback_cutoff()
    owed = db.execute(
        select(AssessmentAttempt.id, AssessmentAttempt.obligation_id)
        .join(AssessmentObligation, AssessmentObligation.id == AssessmentAttempt.obligation_id)
        .where(
            AssessmentAttempt.employee_id == employee_id,
            AssessmentAttempt.assessment_type == AssessmentType.POST_TEST,
            AssessmentAttempt.result_status.is_not(None),
            ~select(AssessmentFeedback.id).where(AssessmentFeedback.obligation_id == AssessmentAttempt.obligation_id).exists(),
            *([~_result_before_cutoff(cutoff)] if cutoff is not None else []),
        )
        .order_by(AssessmentAttempt.submitted_at, AssessmentAttempt.id)
        .limit(1)
    ).first()
    return {"attempt_id": str(owed.id), "obligation_id": str(owed.obligation_id)} if owed else None


def next_opening(db: Session, employee_id: uuid.UUID, now: datetime) -> datetime | None:
    """When this employee's next scheduled post-test becomes due: the moment the gate decision changes by itself."""
    return db.scalar(
        select(func.min(AssessmentObligation.due_at)).where(
            AssessmentObligation.employee_id == employee_id,
            AssessmentObligation.assessment_type == AssessmentType.POST_TEST,
            AssessmentObligation.status.in_(BLOCKING_STATUSES),
            AssessmentObligation.due_at > now,
            training_not_archived(),
        )
    )


COUNTDOWN_WINDOW = timedelta(minutes=5)
"""How long before a scheduled post-test opens its countdown takes over the workspace (presentation only)."""


def countdown_ready(db: Session, obligation: AssessmentObligation, now: datetime, cache: dict) -> bool:
    """Whether a scheduled post-test will be startable when it opens, by the same rules as start_attempt: still
    waiting to open, its pool can draw the assessment, no refresher is owed and an attempt is left."""
    from app.modules.assessment.entry import obligation_entry
    from app.modules.assessment.service import counted_attempts

    if obligation_entry(db, obligation, now, cache)["entry_state"] != "NOT_YET_OPEN":
        return False
    if finished_attempts(obligation) and obligation.refresher_acknowledged_at is None:
        return False
    if counted_attempts(obligation) >= obligation.config.max_attempts:
        return False
    return obligation_startable(db, obligation, cache)


def countdown_state(db: Session, employee_id: uuid.UUID, now: datetime) -> tuple[dict | None, datetime | None]:
    """The scheduled post-test whose countdown is showing now, or when the next countdown begins.

    Only assessments already assigned to the employee and scheduled by L&D are considered; nothing is created here.
    The nearest opening comes first, ties in the gate's queue order. An assessment inside the window that could not
    start when it opens (pool incomplete, refresher owed, no attempt left) gets no countdown."""
    upcoming = db.scalars(
        select(AssessmentObligation)
        .options(joinedload(AssessmentObligation.training), joinedload(AssessmentObligation.config))
        .where(
            AssessmentObligation.employee_id == employee_id,
            AssessmentObligation.assessment_type == AssessmentType.POST_TEST,
            AssessmentObligation.status.in_((ObligationStatus.SCHEDULED, ObligationStatus.DUE)),
            AssessmentObligation.due_at > now,
            training_not_archived(),
        )
        .order_by(AssessmentObligation.due_at, AssessmentObligation.completed_training_at, AssessmentObligation.created_at, AssessmentObligation.id)
    ).unique()
    cache: dict = {}
    for obligation in upcoming:
        if obligation.due_at - now > COUNTDOWN_WINDOW:
            return None, obligation.due_at - COUNTDOWN_WINDOW
        if countdown_ready(db, obligation, now, cache):
            return {"obligation_id": str(obligation.id), "training_title": obligation.training.title, "due_at": iso(obligation.due_at)}, None
    return None, None


def access_state(db: Session, employee_id: uuid.UUID) -> dict:
    now = utcnow()
    finalise_expired_attempts(db, employee_id, now)
    due = due_post_tests(db, employee_id, now)  # Read once; split into startable and unavailable below.
    cache: dict = {}
    queue = [o for o in due if obligation_startable(db, o, cache)]
    unavailable = [o for o in due if not obligation_startable(db, o, cache)]
    if unavailable:
        alert_unavailable(db, unavailable, now)
    feedback = None if queue else feedback_due(db, employee_id)
    db.commit()  # Persist any timeout finalised above and any alert.
    held = [{"obligation_id": str(o.id), "training_title": o.training.title, "reason": "QUESTION_POOL_INSUFFICIENT"} for o in unavailable]
    # An open page re-checks at next_change_at, timed against the server's clock (server_now), not the device's.
    # countdown: a scheduled post-test opening within COUNTDOWN_WINDOW, whose countdown screen opens by itself.
    # Only offered while the workspace is otherwise open: a due assessment and owed feedback come first.
    countdown, countdown_starts_at = countdown_state(db, employee_id, now)
    timing = {"next_change_at": iso(next_opening(db, employee_id, now)), "server_now": iso(now), "countdown_starts_at": iso(countdown_starts_at)}
    if queue:
        return {
            "access_status": "ASSESSMENT_REQUIRED",
            "pending_count": len(queue),
            "next_action": "COMPLETE_ASSESSMENT",
            "queue": [queue_item(o, i + 1) for i, o in enumerate(queue)],
            "unavailable": held,
            "feedback_due": None,
            "countdown": None,
            **timing,
        }
    if feedback:
        return {"access_status": "FEEDBACK_REQUIRED", "pending_count": 0, "next_action": "GIVE_FEEDBACK", "queue": [], "unavailable": held, "feedback_due": feedback, "countdown": None, **timing}
    if countdown:
        from app.modules.assessment.scheduling import load_calendar

        countdown["timezone"] = load_calendar(db).timezone  # The organisation timezone, for showing the opening time.
    return {"access_status": "DASHBOARD_ALLOWED", "pending_count": 0, "next_action": "OPEN_DASHBOARD", "queue": [], "unavailable": held, "feedback_due": None, "countdown": countdown, **timing}
