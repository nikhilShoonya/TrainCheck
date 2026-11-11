"""Scoped data loading and shared metrics. Every report, export and dashboard goes through here."""
import uuid
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.deps import CurrentUser, team_employee_ids
from app.core.enums import AssessmentType, AttemptStatus, EnrolmentStatus, ObligationStatus, ResultStatus, ReviewerType, RoleCode
from app.core.errors import forbidden
from app.core.responses import display_percent
from app.models import (
    AssessmentAttempt,
    AssessmentObligation,
    BehaviourReview,
    BehaviourReviewCycle,
    BehaviourReviewResponse,
    Employee,
    Enrolment,
    ManagerAssignment,
    Training,
)


@dataclass
class ReportFilters:
    date_from: date | None = None
    date_to: date | None = None
    department_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    training_id: uuid.UUID | None = None
    trainer_id: uuid.UUID | None = None
    batch_id: uuid.UUID | None = None
    grade: str | None = None
    function_id: uuid.UUID | None = None

    def stored(self) -> dict:
        return {k: str(v) for k, v in asdict(self).items() if v not in (None, "")}

    @classmethod
    def from_stored(cls, data: dict) -> "ReportFilters":
        values: dict = {}
        for key, value in data.items():
            if key in ("date_from", "date_to"):
                values[key] = date.fromisoformat(value)
            elif key == "grade":
                values[key] = value
            elif key in cls.__dataclass_fields__:
                values[key] = uuid.UUID(value)
        return cls(**values)


def employee_scope(db: Session, user: CurrentUser) -> list[uuid.UUID] | None:
    """None means organisation-wide. Filters can narrow this but never widen it."""
    if user.has_role(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY):
        return None
    if user.has_role(RoleCode.MANAGER):
        return team_employee_ids(db, user.employee_id)
    raise forbidden()


@dataclass
class Row:
    """One employee's relationship with one training, with everything reports need."""

    enrolment: Enrolment
    post_attempts: list[AssessmentAttempt]
    pre_attempt: AssessmentAttempt | None
    obligation: AssessmentObligation | None

    @property
    def result(self) -> str:
        if self.obligation and self.obligation.retraining_flag == "NEEDS_RETRAINING":
            return "NEEDS_RETRAINING"
        if any(a.result_status == ResultStatus.PASSED for a in self.post_attempts):
            return ResultStatus.PASSED
        if self.post_attempts:
            return ResultStatus.NOT_PASSED
        return "PENDING"

    @property
    def first(self) -> Decimal | None:
        return self.post_attempts[0].score_percent if self.post_attempts else None

    @property
    def best(self) -> Decimal | None:
        return max(a.score_percent for a in self.post_attempts) if self.post_attempts else None

    @property
    def latest(self) -> Decimal | None:
        return self.post_attempts[-1].score_percent if self.post_attempts else None


def load_rows(db: Session, scope: list[uuid.UUID] | None, filters: ReportFilters | None = None) -> list[Row]:
    filters = filters or ReportFilters()
    query = (
        select(Enrolment)
        .join(Enrolment.employee)
        .join(Enrolment.training)
        .options(
            selectinload(Enrolment.employee).selectinload(Employee.department),
            selectinload(Enrolment.employee).selectinload(Employee.location),
            selectinload(Enrolment.training).selectinload(Training.trainer),
            selectinload(Enrolment.batch),
            selectinload(Enrolment.completion),
            selectinload(Enrolment.obligations).selectinload(AssessmentObligation.attempts),
        )
        .where(Enrolment.enrolment_status != EnrolmentStatus.CANCELLED)
        .order_by(Employee.full_name, Training.title)
    )
    if scope is not None:
        query = query.where(Enrolment.employee_id.in_(scope))
    if filters.department_id:
        query = query.where(Employee.department_id == filters.department_id)
    if filters.function_id:
        query = query.where(Employee.function_id == filters.function_id)
    if filters.location_id:
        query = query.where(Employee.location_id == filters.location_id)
    if filters.grade:
        query = query.where(Employee.grade == filters.grade)
    if filters.training_id:
        query = query.where(Enrolment.training_id == filters.training_id)
    if filters.trainer_id:
        query = query.where(Training.trainer_id == filters.trainer_id)
    if filters.batch_id:
        query = query.where(Enrolment.batch_id == filters.batch_id)
    if filters.manager_id:
        query = query.where(Enrolment.employee_id.in_(team_employee_ids(db, filters.manager_id)))

    rows: list[Row] = []
    for enrolment in db.scalars(query):
        # Date filters select the training-completion cohort, as in the prototype.
        completed = enrolment.completion.completed_at.date() if enrolment.completion else None
        if filters.date_from and (completed is None or completed < filters.date_from):
            continue
        if filters.date_to and (completed is None or completed > filters.date_to):
            continue
        post_obligations = sorted((o for o in enrolment.obligations if o.assessment_type == AssessmentType.POST_TEST), key=lambda o: o.cycle_number)
        post_attempts = [a for o in post_obligations for a in o.attempts if a.result_status is not None]
        post_attempts.sort(key=lambda a: a.submitted_at)
        pre = next(
            (a for o in enrolment.obligations if o.assessment_type == AssessmentType.PRE_TEST for a in o.attempts if a.result_status is not None),
            None,
        )
        rows.append(Row(enrolment, post_attempts, pre, post_obligations[-1] if post_obligations else None))
    return rows


def manager_names(db: Session, employee_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not employee_ids:
        return {}
    today = utcnow().date()
    result = db.execute(
        select(ManagerAssignment.employee_id, Employee.full_name)
        .join(Employee, Employee.id == ManagerAssignment.manager_employee_id)
        .where(
            ManagerAssignment.employee_id.in_(employee_ids),
            ManagerAssignment.effective_from <= today,
            (ManagerAssignment.effective_to.is_(None)) | (ManagerAssignment.effective_to >= today),
        )
    )
    return {employee_id: name for employee_id, name in result}


def assessment_timing(row: Row, now: datetime) -> str:
    o = row.obligation
    if row.enrolment.completion is None or o is None:
        return "Not scheduled"
    if o.status == ObligationStatus.WAIVED:
        return "Waived"
    if o.status == ObligationStatus.CANCELLED:
        return "Cancelled"
    if row.post_attempts:
        return "Retake pending" if o.status == ObligationStatus.RETAKE_PENDING else "Submitted"
    if o.status == ObligationStatus.IN_PROGRESS:
        return "In progress"
    if o.due_at and o.due_at > now:
        return "Scheduled"
    return "Overdue" if o.due_at and (now - o.due_at).days >= 1 else "Due"


def rate(part: int, whole: int) -> float | None:
    return round(part / whole * 100, 1) if whole else None


def mean(values: list) -> float | None:
    numbers = [float(v) for v in values if v is not None]
    return round(sum(numbers) / len(numbers), 2) if numbers else None


def summary(rows: list[Row]) -> dict:
    """Separate facts: assigned, completed, assessed, passed. Missing data stays None, never zero."""
    assessed = [r for r in rows if r.post_attempts]
    passed = [r for r in assessed if r.result == ResultStatus.PASSED]
    failed = [r for r in assessed if r.result in (ResultStatus.NOT_PASSED, "NEEDS_RETRAINING")]
    flagged = [r for r in rows if r.result == "NEEDS_RETRAINING"]
    completed = [r for r in rows if r.enrolment.completion]
    in_progress = [r for r in rows if r.obligation and r.obligation.status == ObligationStatus.IN_PROGRESS]
    return {
        "assignments": len(rows),
        "employees": len({r.enrolment.employee_id for r in rows}),
        "completed": len(completed),
        "trained_employees": len({r.enrolment.employee_id for r in completed}),
        "assessed": len(assessed),
        "passed": len(passed),
        "not_passed": len(failed),
        "not_passed_employees": len({r.enrolment.employee_id for r in failed}),
        "needs_retraining_employees": len({r.enrolment.employee_id for r in flagged}),
        "pending_assessment": len(rows) - len(assessed),
        "in_progress": len(in_progress),
        "pass_rate": rate(len(passed), len(assessed)),
        "completion_rate": rate(len(completed), len(rows)),
        "mean_latest_score": display_percent(mean([r.latest for r in assessed])),
    }


def monthly_trend(rows: list[Row], now: datetime, months: int = 6) -> list[dict]:
    """Recorded months only. A month with no evidence is absent rather than zero."""
    marks: set[str] = set()
    for r in rows:
        if r.enrolment.completion:
            marks.add(r.enrolment.completion.completed_at.strftime("%Y-%m"))
        marks.update(a.submitted_at.strftime("%Y-%m") for a in r.post_attempts)
    points = []
    for month in sorted(m for m in marks if m <= now.strftime("%Y-%m"))[-months:]:
        eligible = [r for r in rows if r.enrolment.assigned_at.strftime("%Y-%m") <= month or (r.enrolment.completion and r.enrolment.completion.completed_at.strftime("%Y-%m") <= month)]
        complete = sum(1 for r in eligible if r.enrolment.completion and r.enrolment.completion.completed_at.strftime("%Y-%m") <= month)
        latest = []
        for r in eligible:
            so_far = [a for a in r.post_attempts if a.submitted_at.strftime("%Y-%m") <= month]
            if so_far:
                latest.append(so_far[-1])
        passed = sum(1 for a in latest if a.result_status == ResultStatus.PASSED)
        points.append({"month": month, "completion_rate": rate(complete, len(eligible)), "pass_rate": rate(passed, len(latest))})
    return points


def departments_summary(rows: list[Row]) -> list[dict]:
    groups: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        department = r.enrolment.employee.department
        groups[department.name if department else "Unassigned"].append(r)
    return [{"department": name, **summary(group)} for name, group in sorted(groups.items())]


def behaviour_reviews(db: Session, enrolment_ids: list[uuid.UUID]) -> list[BehaviourReview]:
    if not enrolment_ids:
        return []
    return list(
        db.scalars(
            select(BehaviourReview)
            .join(BehaviourReview.cycle)
            .options(
                selectinload(BehaviourReview.cycle).selectinload(BehaviourReviewCycle.employee),
                selectinload(BehaviourReview.cycle).selectinload(BehaviourReviewCycle.training),
                selectinload(BehaviourReview.responses).selectinload(BehaviourReviewResponse.competency),
            )
            .where(BehaviourReviewCycle.enrolment_id.in_(enrolment_ids), BehaviourReview.cancelled.is_(False))
        )
    )


def behaviour_means(reviews: list[BehaviourReview]) -> dict:
    self_ratings = [x.rating for r in reviews if r.reviewer_type == ReviewerType.SELF for x in r.responses]
    manager_ratings = [x.rating for r in reviews if r.reviewer_type == ReviewerType.MANAGER for x in r.responses]
    return {"self_mean": mean(self_ratings), "manager_mean": mean(manager_ratings), "self_count": len(self_ratings), "manager_count": len(manager_ratings)}


def in_progress_attempt(attempts: list[AssessmentAttempt]) -> AssessmentAttempt | None:
    return next((a for a in attempts if a.status == AttemptStatus.IN_PROGRESS), None)
