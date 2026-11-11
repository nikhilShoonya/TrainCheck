"""Level 3 Behaviour: templates, 30/60/90-day cycles, self-assessment and manager observation."""
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.deps import current_manager_id
from app.core.enums import ReviewerType, ReviewStatus
from app.core.errors import conflict, validation
from app.models import (
    BehaviourReview,
    BehaviourReviewCycle,
    BehaviourReviewResponse,
    BehaviourTemplate,
    Enrolment,
)
from app.modules.assessment.scheduling import load_calendar

MIN_EXAMPLE_LENGTH = 10
MAX_TEXT_LENGTH = 1500


def resolve_template(db: Session, training_id: uuid.UUID, function_id: uuid.UUID | None) -> BehaviourTemplate | None:
    """Most specific wins: training and function, then training, then function (Business Rules §12.3a)."""
    templates = db.scalars(select(BehaviourTemplate).where(BehaviourTemplate.is_active)).all()

    def pick(condition) -> BehaviourTemplate | None:
        return next((t for t in templates if condition(t)), None)

    return (
        pick(lambda t: t.training_id == training_id and function_id is not None and t.function_id == function_id)
        or pick(lambda t: t.training_id == training_id and t.function_id is None)
        or pick(lambda t: t.training_id is None and function_id is not None and t.function_id == function_id)
    )


def create_cycles(db: Session, enrolment: Enrolment, completed_at: datetime) -> int:
    """Creates follow-ups from the completion date. Interval days are calendar days (provisional)."""
    training = enrolment.training
    if not training.behaviour_enabled:
        return 0
    template = resolve_template(db, training.id, enrolment.employee.function_id)
    if template is None:
        return 0  # The scorecard shows "Not configured". Nothing is invented.
    manager_id = current_manager_id(db, enrolment.employee_id)
    created = 0
    for days in sorted(set(training.followup_days or [])):
        cycle = BehaviourReviewCycle(
            enrolment_id=enrolment.id,
            employee_id=enrolment.employee_id,
            training_id=enrolment.training_id,
            template_id=template.id,
            period_days=days,
            due_at=completed_at + timedelta(days=days),
        )
        db.add(cycle)
        db.flush()
        db.add(BehaviourReview(cycle_id=cycle.id, reviewer_type=ReviewerType.SELF, assigned_reviewer_employee_id=enrolment.employee_id))
        db.add(BehaviourReview(cycle_id=cycle.id, reviewer_type=ReviewerType.MANAGER, assigned_reviewer_employee_id=manager_id))
        created += 1
    db.flush()
    return created


def review_status(review: BehaviourReview, now: datetime | None = None) -> str:
    now = now or utcnow()
    if review.cancelled:
        return ReviewStatus.CANCELLED
    if review.submitted_at is not None:
        return ReviewStatus.SUBMITTED
    if review.cycle.due_at > now:
        return ReviewStatus.NOT_DUE
    # Due on the due date itself; overdue from the following day.
    return ReviewStatus.OVERDUE if review.cycle.due_at + timedelta(days=1) <= now else ReviewStatus.PENDING


def _loaded() -> list:
    return [
        selectinload(BehaviourReview.responses).selectinload(BehaviourReviewResponse.competency),
        selectinload(BehaviourReview.responses).selectinload(BehaviourReviewResponse.template_question),
        selectinload(BehaviourReview.submitted_by),
        selectinload(BehaviourReview.cycle).selectinload(BehaviourReviewCycle.employee),
        selectinload(BehaviourReview.cycle).selectinload(BehaviourReviewCycle.training),
        selectinload(BehaviourReview.cycle).selectinload(BehaviourReviewCycle.template).selectinload(BehaviourTemplate.questions),
    ]


def reviews_for_self(db: Session, employee_id: uuid.UUID) -> list[BehaviourReview]:
    return list(
        db.scalars(
            select(BehaviourReview)
            .join(BehaviourReview.cycle)
            .options(*_loaded())
            .where(BehaviourReviewCycle.employee_id == employee_id, BehaviourReview.reviewer_type == ReviewerType.SELF)
            .order_by(BehaviourReviewCycle.due_at)
        )
    )


def reviews_for_team(db: Session, team_ids: list[uuid.UUID], manager_employee_id: uuid.UUID) -> list[BehaviourReview]:
    """Open tasks follow the current team. Submitted observations stay with the manager who wrote them."""
    return list(
        db.scalars(
            select(BehaviourReview)
            .join(BehaviourReview.cycle)
            .options(*_loaded())
            .where(
                BehaviourReview.reviewer_type == ReviewerType.MANAGER,
                ((BehaviourReview.submitted_at.is_(None)) & (BehaviourReviewCycle.employee_id.in_(team_ids)))
                | (BehaviourReview.submitted_by_employee_id == manager_employee_id),
            )
            .order_by(BehaviourReviewCycle.due_at)
        )
    )


def submit_review(db: Session, review: BehaviourReview, submitter_employee_id: uuid.UUID, responses: list[dict], now: datetime | None = None) -> None:
    now = now or utcnow()
    status = review_status(review, now)
    if status == ReviewStatus.SUBMITTED:
        raise conflict("REVIEW_ALREADY_SUBMITTED", "This review has already been submitted.")
    if status == ReviewStatus.NOT_DUE:
        raise conflict("REVIEW_NOT_DUE", "This review is not due yet.")
    if status == ReviewStatus.CANCELLED:
        raise conflict("REVIEW_CANCELLED", "This review was cancelled.")

    questions = {q.id: q for q in review.cycle.template.questions}
    submitted = {r["template_question_id"]: r for r in responses}
    if set(submitted) != set(questions):
        raise validation("Answer every behaviour question in this form.")
    for question_id, question in questions.items():
        response = submitted[question_id]
        rating = response["rating"]
        if not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5:
            raise validation(f"Choose a rating from 1 to 5 for: {question.competency.name}.")
        example = (response.get("example_text") or "").strip()
        if question.example_required and len(example) < MIN_EXAMPLE_LENGTH:
            raise validation(f"Give a specific workplace example of at least {MIN_EXAMPLE_LENGTH} characters for: {question.competency.name}.")
        if len(example) > MAX_TEXT_LENGTH or len(response.get("comment_text") or "") > MAX_TEXT_LENGTH:
            raise validation(f"Keep examples and comments to {MAX_TEXT_LENGTH} characters.")
        db.add(
            BehaviourReviewResponse(
                review_id=review.id,
                template_question_id=question_id,
                competency_id=question.competency_id,
                rating=rating,
                example_text=example or None,
                comment_text=(response.get("comment_text") or "").strip() or None,
            )
        )
    review.submitted_at = now
    review.submitted_by_employee_id = submitter_employee_id
    db.flush()


def due_soon(review: BehaviourReview, now: datetime, days: int = 7) -> bool:
    return review.submitted_at is None and now < review.cycle.due_at <= now + timedelta(days=days)


def overdue_working_days(db: Session, review: BehaviourReview, now: datetime) -> int:
    calendar = load_calendar(db)
    return calendar.working_days_between(calendar.local_date(review.cycle.due_at), calendar.local_date(now))
