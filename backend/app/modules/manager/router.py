"""Manager workspace. Every employee ID is checked against the current team on the server."""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_manager, team_employee_ids
from app.core.enums import ReviewerType
from app.core.errors import not_found
from app.core.responses import display_percent, iso, ok
from app.models import Employee
from app.modules.behaviour.service import due_soon, review_status, reviews_for_team
from app.modules.reports.data import ReportFilters, Row, assessment_timing, behaviour_means, behaviour_reviews, load_rows, monthly_trend, summary

router = APIRouter(prefix="/manager", tags=["Manager"])


def team_row(r: Row, now) -> dict:
    e = r.enrolment.employee
    return {
        "enrolment_id": str(r.enrolment.id),
        "employee_id": str(e.id),
        "employee_name": e.full_name,
        "employee_code": e.employee_code,
        "department": e.department.name if e.department else None,
        "location": e.location.name if e.location else None,
        "grade": e.grade,
        "training_id": str(r.enrolment.training_id),
        "training_title": r.enrolment.training.title,
        "batch": r.enrolment.batch.name if r.enrolment.batch else None,
        "completed_at": iso(r.enrolment.completion.completed_at) if r.enrolment.completion else None,
        "due_at": iso(r.obligation.due_at) if r.obligation else None,
        "assessment_state": assessment_timing(r, now),
        "result": r.result,
        "first_score": display_percent(r.first),
        "best_score": display_percent(r.best),
        "latest_score": display_percent(r.latest),
        "attempts": len(r.post_attempts),
        "last_submitted_at": iso(r.post_attempts[-1].submitted_at) if r.post_attempts else None,
    }


def _team_rows(db: Session, user: CurrentUser, filters: ReportFilters | None = None) -> list[Row]:
    return load_rows(db, team_employee_ids(db, user.employee_id), filters)


@router.get("/dashboard")
def dashboard(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    rows = _team_rows(db, user)
    reviews = reviews_for_team(db, team_employee_ids(db, user.employee_id), user.employee_id)
    open_reviews = [r for r in reviews if r.submitted_at is None]
    return ok(
        {
            "summary": summary(rows),
            "trend": monthly_trend(rows, now),
            "team_status": [team_row(r, now) for r in rows],
            "behaviour": behaviour_means(behaviour_reviews(db, [r.enrolment.id for r in rows])),
            "reviews_due": sum(1 for r in open_reviews if review_status(r, now) in ("PENDING", "OVERDUE")),
            "reviews_overdue": sum(1 for r in open_reviews if review_status(r, now) == "OVERDUE"),
            "reviews_due_soon": sum(1 for r in open_reviews if due_soon(r, now)),
            "assessments_due_this_week": sum(1 for r in rows if not r.post_attempts and r.obligation and r.obligation.due_at and (r.obligation.due_at - now).days <= 7),
        }
    )


@router.get("/team-summary")
def team_summary(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    return ok(summary(_team_rows(db, user)))


@router.get("/team-assessments")
def team_assessments(
    user: CurrentUser = Depends(require_manager),
    db: Session = Depends(get_db),
    training_id: uuid.UUID | None = None,
    result: str | None = Query(default=None, max_length=30),
    search: str = Query(default="", max_length=120),
) -> dict:
    """Filters can only narrow the server-resolved team. They can never widen it."""
    now = utcnow()
    rows = _team_rows(db, user, ReportFilters(training_id=training_id))
    if result:
        rows = [r for r in rows if r.result == result]
    if search:
        needle = search.lower()
        rows = [r for r in rows if needle in f"{r.enrolment.employee.full_name} {r.enrolment.employee.employee_code} {r.enrolment.training.title}".lower()]
    return ok([team_row(r, now) for r in rows])


@router.get("/team-employees")
def team_employees(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    rows = _team_rows(db, user)
    by_person: dict[uuid.UUID, list[Row]] = {}
    for r in rows:
        by_person.setdefault(r.enrolment.employee_id, []).append(r)
    people = []
    for employee_id in team_employee_ids(db, user.employee_id):
        employee = db.get(Employee, employee_id)
        group = by_person.get(employee_id, [])
        people.append(
            {
                "employee_id": str(employee_id),
                "employee_name": employee.full_name,
                "employee_code": employee.employee_code,
                "department": employee.department.name if employee.department else None,
                "function": employee.function.name if employee.function else None,
                "grade": employee.grade,
                **summary(group),
            }
        )
    return ok(sorted(people, key=lambda p: p["employee_name"]))


@router.get("/team-trainings")
def team_trainings(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    groups: dict[uuid.UUID, list[Row]] = {}
    for r in _team_rows(db, user):
        groups.setdefault(r.enrolment.training_id, []).append(r)
    return ok(sorted(({"training_id": str(k), "title": g[0].enrolment.training.title, **summary(g)} for k, g in groups.items()), key=lambda x: x["title"]))


@router.get("/retraining-flags")
def retraining_flags(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    return ok([team_row(r, now) for r in _team_rows(db, user) if r.result == "NEEDS_RETRAINING"])


@router.get("/team/{employee_id}")
def team_member(employee_id: uuid.UUID, user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    """Employee Performance Details. Individual answers are not shown to managers (open HR decision)."""
    if employee_id not in team_employee_ids(db, user.employee_id):
        raise not_found()
    now = utcnow()
    employee = db.get(Employee, employee_id)
    rows = load_rows(db, [employee_id])
    trainings = []
    for r in rows:
        trainings.append(
            {
                **team_row(r, now),
                "attempts_detail": [{"number": a.attempt_number, "score": display_percent(a.score_percent), "result": a.result_status, "submitted_at": iso(a.submitted_at), "reason": a.submission_reason} for a in r.post_attempts],
            }
        )
    reviews = behaviour_reviews(db, [r.enrolment.id for r in rows])
    follow_ups: dict[tuple, dict] = {}
    for review in reviews:
        key = (review.cycle.training.title, review.cycle.period_days)
        entry = follow_ups.setdefault(key, {"training": key[0], "period_days": key[1], "due_at": iso(review.cycle.due_at), "self": None, "manager": None, "manager_status": None, "manager_review_id": None})
        ratings = [x.rating for x in review.responses]
        value = round(sum(ratings) / len(ratings), 2) if ratings else None
        if review.reviewer_type == ReviewerType.SELF:
            entry["self"] = value
        else:
            entry["manager"] = value
            entry["manager_status"] = review_status(review, now)
            entry["manager_review_id"] = str(review.id)
    return ok(
        {
            "employee": {
                "id": str(employee.id),
                "name": employee.full_name,
                "code": employee.employee_code,
                "department": employee.department.name if employee.department else None,
                "function": employee.function.name if employee.function else None,
                "location": employee.location.name if employee.location else None,
                "grade": employee.grade,
            },
            "summary": summary(rows),
            "trainings": trainings,
            "follow_ups": sorted(follow_ups.values(), key=lambda f: (f["training"], f["period_days"])),
        }
    )
