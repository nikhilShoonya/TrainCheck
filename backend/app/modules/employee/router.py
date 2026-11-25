"""The employee's own workspace. Identity always comes from the session, never from the client."""
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear
from app.core.display import india_date
from app.core.enums import AssessmentType, ObligationStatus, ResultStatus, ReviewerType, ScheduleMode
from app.core.responses import display_percent, iso, ok
from app.core.routing import ReleasingRoute
from app.models import AssessmentConfig, AssessmentFeedback, Training
from app.modules.assessment.entry import before_assessment, obligation_entry, order_cards, pending_group, unavailable
from app.modules.assessment.gate import finished_attempts
from app.modules.assessment.scheduling import CalendarView, fixed_instant, load_calendar
from app.modules.behaviour.service import review_status, reviews_for_self
from app.modules.feedback.router import ratings_of
from app.modules.reports.data import Row, assessment_timing, behaviour_means, behaviour_reviews, load_rows, mean, summary
from app.modules.reports.scorecard import gain_values

router = APIRouter(route_class=ReleasingRoute, prefix="/me", tags=["Employee"])


def training_card(r: Row, now, pretest_ready: set[uuid.UUID], planned: dict | None = None, calendar: CalendarView | None = None) -> dict:
    e, t = r.enrolment, r.enrolment.training
    config = r.obligation.config if r.obligation else None
    # Offered only once pre-test rules are saved; otherwise starting it fails with "no pre-test configured".
    # The pre-test belongs to the first training cycle only; re-training does not offer it again.
    pre_available = t.pretest_enabled and t.id in pretest_ready and e.training_cycle == 1 and e.completion is None and r.pre_attempt is None
    return {
        "enrolment_id": str(e.id),
        "training_id": str(t.id),
        "title": t.title,
        "category": t.category,
        "description": t.description,
        "trainer": t.trainer.name if t.trainer else None,
        "batch": e.batch.name if e.batch else None,
        "assigned_at": iso(e.assigned_at),
        "completed_at": iso(e.completion.completed_at) if e.completion else None,
        "attendance_status": e.attendance_status,
        "result": r.result,
        "assessment_state": assessment_timing(r, now),
        "first_score": display_percent(r.first),
        "best_score": display_percent(r.best),
        "latest_score": display_percent(r.latest),
        # Attempts with a result in the current training cycle (re-training starts again at 0); scores cover all cycles.
        "attempts": finished_attempts(r.obligation) if r.obligation else 0,
        "latest_attempt_id": str(r.post_attempts[-1].id) if r.post_attempts else None,
        "obligation_id": str(r.obligation.id) if r.obligation else None,
        "due_at": iso(r.obligation.due_at) if r.obligation else None,
        # Before completion is recorded there is no assessment yet; a custom date already chosen is shown as the
        # earliest moment it can open. It still opens only once completion is recorded.
        "planned_at": iso(planned[t.id]) if planned and r.obligation is None and t.id in planned else None,
        "timezone": calendar.timezone if calendar else None,
        "retake_pending": bool(r.obligation and r.obligation.status == ObligationStatus.RETAKE_PENDING),
        "refresher_acknowledged": bool(r.obligation and r.obligation.refresher_acknowledged_at),
        "question_count": config.question_count if config else None,
        "duration_minutes": config.duration_seconds // 60 if config else None,
        "pass_mark_percent": float(config.pass_mark_percent) if config else None,
        "max_attempts": config.max_attempts if config else None,
        "pre_test_available": pre_available,
        "pre_test_score": display_percent(r.pre_attempt.score_percent) if r.pre_attempt else None,
        "materials": [{"id": str(m.id), "kind": m.kind, "title": m.title, "url": m.url} for m in t.materials],
    }


def _rows(db: Session, user: CurrentUser) -> list[Row]:
    """The employee's rows, with each assessment's rules and each training's materials read in one query apiece
    instead of one per training (audit F-22)."""
    rows = load_rows(db, [user.employee_id])
    config_ids = {r.obligation.config_id for r in rows if r.obligation}
    if config_ids:
        configs = {c.id: c for c in db.scalars(select(AssessmentConfig).where(AssessmentConfig.id.in_(config_ids)))}
        for r in rows:
            if r.obligation:
                set_committed_value(r.obligation, "config", configs[r.obligation.config_id])  # Loaded, not changed.
    training_ids = {r.enrolment.training_id for r in rows}
    if training_ids:
        db.scalars(select(Training).options(selectinload(Training.materials)).where(Training.id.in_(training_ids)).execution_options(populate_existing=True)).all()
    return rows


def _planned(db: Session, rows: list[Row], calendar: CalendarView) -> dict[uuid.UUID, object]:
    """Opening moments of custom-date post-tests for trainings among these rows not yet scheduled for the employee."""
    ids = {r.enrolment.training_id for r in rows if r.obligation is None}
    if not ids:
        return {}
    query = select(AssessmentConfig).where(
        AssessmentConfig.training_id.in_(ids), AssessmentConfig.assessment_type == AssessmentType.POST_TEST, AssessmentConfig.is_active, AssessmentConfig.schedule_mode == ScheduleMode.FIXED_DATE
    )
    return {c.training_id: opens for c in db.scalars(query) if (opens := fixed_instant(calendar, c))}


def _cards(db: Session, rows: list[Row], now) -> list[dict]:
    calendar = load_calendar(db)
    ready, planned = _pretest_ready(db, rows), _planned(db, rows, calendar)
    owed, cache = _feedback_owed(db, rows), {}
    cards = []
    for r in rows:
        card = training_card(r, now, ready, planned, calendar)
        # What the employee can do about the assessment, by the same rules the gate and start_attempt apply.
        entry = obligation_entry(db, r.obligation, now, cache) if r.obligation else before_assessment(r.enrolment.completion is not None)
        if r.enrolment.id in owed and entry["entry_reason"] == "COMPLETED":
            entry = unavailable("FEEDBACK_REQUIRED")
        card.update(entry, feedback_required=r.enrolment.id in owed, pending_group=pending_group(entry, r.result, r.enrolment.id in owed))
        cards.append(card)
    return cards


def _feedback_owed(db: Session, rows: list[Row]) -> set[uuid.UUID]:
    """Enrolments with a post-test result whose required feedback is not given (the rule of gate.feedback_due)."""
    from app.modules.assessment.gate import feedback_cutoff

    post = [o for r in rows for o in r.enrolment.obligations if o.assessment_type == AssessmentType.POST_TEST]
    if not post:
        return set()
    given = set(db.scalars(select(AssessmentFeedback.obligation_id).where(AssessmentFeedback.obligation_id.in_([o.id for o in post]))))
    cutoff = feedback_cutoff()
    owed = set()
    for o in post:
        results = [a for a in o.attempts if a.result_status is not None]
        exempt = cutoff is not None and any(a.submitted_at < cutoff for a in results)  # Results from before feedback existed.
        if results and o.id not in given and not exempt:
            owed.add(o.enrolment_id)
    return owed


def _pretest_ready(db: Session, rows: list[Row]) -> set[uuid.UUID]:
    """Trainings among these rows that have active pre-test rules."""
    ids = {r.enrolment.training_id for r in rows if r.enrolment.training.pretest_enabled}
    if not ids:
        return set()
    query = select(AssessmentConfig.training_id).where(AssessmentConfig.training_id.in_(ids), AssessmentConfig.assessment_type == AssessmentType.PRE_TEST, AssessmentConfig.is_active)
    return set(db.scalars(query))


@router.get("/dashboard")
def dashboard(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    rows = _rows(db, user)
    cards = _cards(db, rows, now)
    window = now - timedelta(days=90)
    points = sorted(
        ({"label": r.enrolment.training.title, "score": display_percent(r.latest), "date": iso(r.post_attempts[-1].submitted_at)} for r in rows if r.post_attempts and r.post_attempts[-1].submitted_at >= window),
        key=lambda p: p["date"],
    )
    reviews = reviews_for_self(db, user.employee_id)
    calendar = []
    for r in rows:
        if r.obligation and r.obligation.due_at and not r.post_attempts and r.obligation.due_at > now:
            calendar.append({"date": iso(r.obligation.due_at), "title": r.enrolment.training.title, "tag": "Assessment", "link": "/employee/assessments"})
        if r.enrolment.batch and r.enrolment.batch.start_date and r.enrolment.batch.start_date >= india_date(now):
            calendar.append({"date": r.enrolment.batch.start_date.isoformat(), "title": f"{r.enrolment.batch.name} · {r.enrolment.training.title}", "tag": "Training session", "link": "/employee/trainings"})
    for review in reviews:
        if review.submitted_at is None and review.cycle.due_at >= now:
            calendar.append({"date": iso(review.cycle.due_at), "title": f"Self-assessment · {review.cycle.training.title}", "tag": f"{review.cycle.period_days}-day follow-up", "link": "/employee/behaviour"})
    calendar.sort(key=lambda c: c["date"])

    retake = next((c for c in cards if c["retake_pending"]), None)
    upcoming = next((c for c in cards if c["due_at"] and c["due_at"] > iso(now) and not c["attempts"]), None)
    means = behaviour_means(behaviour_reviews(db, [r.enrolment.id for r in rows]))
    return ok(
        {
            "summary": summary(rows),
            "overall_score": mean([p["score"] for p in points]),
            "trend_points": points,
            "recent": cards[:3],
            "calendar": calendar,
            "retake": retake,
            "upcoming": upcoming,
            "behaviour": means,
            "reviews_due": sum(1 for r in reviews if review_status(r, now) in ("PENDING", "OVERDUE")),
        }
    )


@router.get("/trainings")
def trainings(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    return ok(order_cards(_cards(db, _rows(db, user), now)))  # Pending first (see entry.order_cards).


@router.get("/refresher-materials")
def refresher_materials(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """Refreshers for trainings the employee has not yet passed, plus their training materials."""
    now = utcnow()
    result = []
    rows = _rows(db, user)
    ready = _pretest_ready(db, rows)
    for r in rows:
        if r.result in (ResultStatus.NOT_PASSED, "NEEDS_RETRAINING"):
            card = training_card(r, now, ready)
            card["refresher_text"] = r.enrolment.training.refresher_text
            card["refresher_url"] = r.enrolment.training.refresher_url
            result.append(card)
    return ok(result)


@router.get("/scorecard")
def personal_scorecard(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """The employee's own Learning and Behaviour evidence for each training."""
    now = utcnow()
    items = []
    feedback_by_obligation = {f.obligation_id: f for f in db.scalars(select(AssessmentFeedback).where(AssessmentFeedback.employee_id == user.employee_id))}
    rows = _rows(db, user)
    reviews_by_enrolment: dict[uuid.UUID, list] = {}
    for review in behaviour_reviews(db, [r.enrolment.id for r in rows]):  # One read for every training.
        reviews_by_enrolment.setdefault(review.cycle.enrolment_id, []).append(review)
    for r in rows:
        # Feedback is given once per assessment cycle; show the most recent one for this training.
        given = [feedback_by_obligation[o.id] for o in r.enrolment.obligations if o.id in feedback_by_obligation]
        latest_feedback = max(given, key=lambda f: f.submitted_at) if given else None
        reviews = reviews_by_enrolment.get(r.enrolment.id, [])
        pre = float(r.pre_attempt.score_percent) if r.pre_attempt else None
        first = float(r.first) if r.first is not None else None
        absolute, normalised, note = gain_values(pre, first)
        reviews_due = [v for v in reviews if v.cycle.due_at <= now and v.reviewer_type == ReviewerType.SELF]
        reviews_done = [v for v in reviews_due if v.submitted_at]
        items.append(
            {
                "training": r.enrolment.training.title,
                "result": r.result,
                "pre_test": display_percent(pre),
                "first_score": display_percent(r.first),
                "best_score": display_percent(r.best),
                "test_score": display_percent(r.latest),
                "feedback_score": mean(list(ratings_of(latest_feedback).values())) if latest_feedback else None,
                "gain": absolute,
                "normalised_gain": normalised,
                "gain_note": note,
                "self_mean": behaviour_means(reviews)["self_mean"],
                "manager_mean": behaviour_means(reviews)["manager_mean"],
                "self_reviews_due": len(reviews_due),
                "self_reviews_done": len(reviews_done),
                "behaviour_cycles": len({v.cycle_id for v in reviews}),
            }
        )
    return ok(items)

