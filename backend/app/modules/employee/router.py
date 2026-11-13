"""The employee's own workspace. Identity always comes from the session, never from the client."""
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear
from app.core.enums import AssessmentType, ObligationStatus, ResultStatus, ReviewerType
from app.core.responses import display_percent, iso, ok
from app.models import AssessmentConfig
from app.modules.behaviour.service import review_status, reviews_for_self
from app.modules.reports.data import Row, assessment_timing, behaviour_means, behaviour_reviews, load_rows, mean, summary
from app.modules.reports.scorecard import gain_values

router = APIRouter(prefix="/me", tags=["Employee"])


def training_card(r: Row, now, pretest_ready: set[uuid.UUID]) -> dict:
    e, t = r.enrolment, r.enrolment.training
    config = r.obligation.config if r.obligation else None
    # Offered only once pre-test rules are saved; otherwise starting it fails with "no pre-test configured".
    pre_available = t.pretest_enabled and t.id in pretest_ready and e.completion is None and r.pre_attempt is None
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
        "attempts": len(r.post_attempts),
        "latest_attempt_id": str(r.post_attempts[-1].id) if r.post_attempts else None,
        "obligation_id": str(r.obligation.id) if r.obligation else None,
        "due_at": iso(r.obligation.due_at) if r.obligation else None,
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
    return load_rows(db, [user.employee_id])


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
    ready = _pretest_ready(db, rows)
    cards = [training_card(r, now, ready) for r in rows]
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
        if r.enrolment.batch and r.enrolment.batch.start_date and r.enrolment.batch.start_date >= now.date():
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
    rows = _rows(db, user)
    ready = _pretest_ready(db, rows)
    return ok([training_card(r, now, ready) for r in rows])


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
    for r in _rows(db, user):
        reviews = behaviour_reviews(db, [r.enrolment.id])
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

