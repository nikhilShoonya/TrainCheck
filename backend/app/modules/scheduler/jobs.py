"""Lightweight scheduled work using APScheduler in the API process (AGENTS.md §5).

Every job is safe to run more than once: notification dedupe keys and row locks prevent duplicates.
"""
import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.db import session_factory
from app.core.enums import AssessmentType, AttemptStatus, ObligationStatus, ReviewerType
from app.models import AssessmentAttempt, AssessmentObligation, BehaviourReview, BehaviourReviewCycle
from app.modules.assessment.gate import alert_unavailable, obligation_startable
from app.modules.assessment.scheduling import load_calendar
from app.modules.assessment.service import finalise_attempt
from app.modules.behaviour.service import overdue_working_days
from app.modules.notifications.service import notify_employee, notify_roles
from app.modules.reports.router import run_due_schedules

logger = logging.getLogger("traincheck.jobs")

# Proposed defaults from the project brief (Business Rules §16.2). They need Finvasia approval.
LD_ESCALATION_WORKING_DAYS = 2  # Overdue post-tests are escalated to L&D Admin.


def finalise_expired(db: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    ids = db.scalars(select(AssessmentAttempt.id).where(AssessmentAttempt.status == AttemptStatus.IN_PROGRESS, AssessmentAttempt.expires_at <= now)).all()
    for attempt_id in ids:
        finalise_attempt(db, attempt_id, now=now)
    db.commit()
    return len(ids)


def pending_assessment_reminders(db: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    calendar = load_calendar(db)
    today = calendar.local_date(now)
    sent = 0
    obligations = db.scalars(
        select(AssessmentObligation).where(
            AssessmentObligation.assessment_type == AssessmentType.POST_TEST,
            AssessmentObligation.status.in_((ObligationStatus.SCHEDULED, ObligationStatus.DUE)),
            AssessmentObligation.due_at <= now,
        )
    ).all()
    startable_cache: dict = {}
    unavailable = [o for o in obligations if not obligation_startable(db, o, startable_cache)]
    if unavailable:
        # Asking an employee to sign in for an assessment that cannot start would be misleading. Alert L&D instead.
        alert_unavailable(db, unavailable, now)
    for o in obligations:
        if o in unavailable:
            continue
        title = o.training.title
        waited = calendar.working_days_between(calendar.local_date(o.due_at), today)
        heading = f"Assessment overdue: {title}" if waited >= 1 else f"Assessment due: {title}"
        notify_employee(db, o.employee_id, "ASSESSMENT_DUE", heading, "Sign in to complete your mandatory assessment.", "/access/assessment-required", f"due:{o.id}:{today.isoformat()}", now)
        if waited >= LD_ESCALATION_WORKING_DAYS:
            notify_roles(db, ("LD_ADMIN",), "ASSESSMENT_ESCALATION", f"Pending assessment: {o.employee.full_name}", f"{title} has been pending for {LD_ESCALATION_WORKING_DAYS} or more working days.", None, f"escalate-ld:{o.id}", now)
        sent += 1
    db.commit()
    return sent


def behaviour_reminders(db: Session, now: datetime | None = None) -> int:
    """Tells reviewers when a follow-up is due and again when it is overdue. Each notice is sent once.
    Sends nothing while Level 3 is switched off (it is outside the approved scope)."""
    if not get_settings().behaviour_enabled:
        return 0
    now = now or utcnow()
    sent = 0
    reviews = db.scalars(
        select(BehaviourReview)
        .join(BehaviourReview.cycle)
        .where(BehaviourReview.submitted_at.is_(None), BehaviourReview.cancelled.is_(False), BehaviourReviewCycle.due_at <= now)
    ).all()
    for review in reviews:
        cycle = review.cycle
        late = overdue_working_days(db, review, now)
        stage = "overdue" if late >= 1 else "due"
        if review.reviewer_type != ReviewerType.SELF:
            continue  # Manager observations were removed with the Manager role; older open ones get no reminder.
        title = f"{cycle.period_days}-day self-assessment {stage}"
        message = f"Tell us how you apply {cycle.training.title} in your daily work."
        notify_employee(db, cycle.employee_id, "BEHAVIOUR_REVIEW", title, message, "/employee/behaviour", f"review:{review.id}:{stage}", now)
        sent += 1
    db.commit()
    return sent


def prune_rate_limits(_db: Session | None = None) -> int:
    """Removes counters older than the sliding window needs. A no-op for the in-memory store's other windows."""
    from app.core.ratelimit import get_limiter

    return get_limiter().prune()


def _run(job, name: str) -> None:
    db = session_factory()()
    try:
        job(db)
    except Exception:
        logger.exception("Scheduled job failed: %s", name)  # Logged and retried on the next run.
        db.rollback()
    finally:
        db.close()


def build_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(_run, "interval", minutes=1, args=[finalise_expired, "finalise_expired"], id="finalise_expired", max_instances=1, coalesce=True)
    scheduler.add_job(_run, "cron", minute=30, args=[pending_assessment_reminders, "pending_assessment_reminders"], id="pending_assessment_reminders", max_instances=1, coalesce=True)
    if get_settings().behaviour_enabled:
        scheduler.add_job(_run, "cron", minute=45, args=[behaviour_reminders, "behaviour_reminders"], id="behaviour_reminders", max_instances=1, coalesce=True)
    scheduler.add_job(_run, "cron", minute=0, args=[run_due_schedules, "run_due_schedules"], id="run_due_schedules", max_instances=1, coalesce=True)
    scheduler.add_job(_run, "interval", minutes=5, args=[prune_rate_limits, "prune_rate_limits"], id="prune_rate_limits", max_instances=1, coalesce=True)
    return scheduler
