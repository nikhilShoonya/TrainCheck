"""Feedback after a post-training assessment: five 1-5 ratings about the training and the assessment.

Asked once per assessment (obligation), on the result page of its first submitted attempt; retakes do not ask
again. Pre-tests never ask. L&D Admins read every response and the per-training averages.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_session
from app.core.enums import AssessmentType
from app.core.errors import conflict
from app.core.responses import display_percent, iso, ok
from app.models import AssessmentAttempt, AssessmentFeedback, Employee, Training
from app.modules.assessment.service import get_own_attempt

router = APIRouter(tags=["Assessment feedback"])

# (key, model column, question, label for 1, label for 5). Order is the order shown to the employee.
QUESTIONS: list[tuple[str, str, str, str, str]] = [
    ("relevance", "relevance_rating", "How relevant was this training to your day-to-day role?", "Not relevant", "Highly relevant"),
    ("clarity", "clarity_rating", "How clearly were the training content and examples explained?", "Very unclear", "Very clear"),
    ("alignment", "alignment_rating", "How well did the assessment questions match what was taught in the training?", "Not at all", "Very well"),
    ("fairness", "fairness_rating", "How fair were the assessment's difficulty level and time limit?", "Very unfair", "Very fair"),
    ("confidence", "confidence_rating", "How confident are you to apply what you learned in your daily work?", "Not confident", "Very confident"),
]
COLUMN = {key: column for key, column, *_ in QUESTIONS}
MAX_COMMENT = 2000


class Ratings(BaseModel):
    relevance: int = Field(ge=1, le=5)
    clarity: int = Field(ge=1, le=5)
    alignment: int = Field(ge=1, le=5)
    fairness: int = Field(ge=1, le=5)
    confidence: int = Field(ge=1, le=5)


class FeedbackIn(BaseModel):
    ratings: Ratings
    comment: str | None = Field(default=None, max_length=MAX_COMMENT)


def questions_payload() -> list[dict]:
    return [{"key": key, "text": text, "low_label": low, "high_label": high} for key, _, text, low, high in QUESTIONS]


def ratings_of(feedback: AssessmentFeedback) -> dict[str, int]:
    return {key: getattr(feedback, column) for key, column in COLUMN.items()}


def _average(values: list[int]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _feedback_for(db: Session, attempt: AssessmentAttempt) -> AssessmentFeedback | None:
    return db.scalar(select(AssessmentFeedback).where(AssessmentFeedback.obligation_id == attempt.obligation_id))


def _feedback_view(attempt: AssessmentAttempt, feedback: AssessmentFeedback | None) -> dict:
    eligible = attempt.assessment_type == AssessmentType.POST_TEST and attempt.result_status is not None
    return {
        "required": eligible and feedback is None,
        "training_title": attempt.training.title,
        "questions": questions_payload(),
        "submitted": None if feedback is None else {"ratings": ratings_of(feedback), "comment": feedback.comment_text, "submitted_at": iso(feedback.submitted_at)},
    }


@router.get("/attempts/{attempt_id}/feedback")
def get_feedback(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = get_own_attempt(db, attempt_id, user.employee_id)
    return ok(_feedback_view(attempt, _feedback_for(db, attempt)))


@router.post("/attempts/{attempt_id}/feedback")
def submit_feedback(attempt_id: uuid.UUID, body: FeedbackIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = get_own_attempt(db, attempt_id, user.employee_id)
    if attempt.assessment_type != AssessmentType.POST_TEST:
        raise conflict("FEEDBACK_NOT_APPLICABLE", "Feedback is only collected after a post-training assessment.")
    if attempt.result_status is None:
        raise conflict("RESULT_NOT_READY", "Submit the assessment before giving feedback.")
    if _feedback_for(db, attempt) is not None:
        raise conflict("FEEDBACK_ALREADY_SUBMITTED", "You have already given feedback for this assessment.")
    comment = (body.comment or "").strip() or None
    feedback = AssessmentFeedback(
        obligation_id=attempt.obligation_id,
        attempt_id=attempt.id,
        employee_id=user.employee_id,
        training_id=attempt.training_id,
        comment_text=comment,
        submitted_at=utcnow(),
        **{COLUMN[key]: value for key, value in body.ratings.model_dump().items()},
    )
    db.add(feedback)
    record_audit(db, user.id, "ASSESSMENT_FEEDBACK_SUBMITTED", "assessment_feedback", feedback.id, after={"attempt_id": str(attempt.id)})
    try:
        db.commit()
    except IntegrityError as error:  # The same feedback sent twice at once, e.g. from two tabs.
        db.rollback()
        raise conflict("FEEDBACK_ALREADY_SUBMITTED", "You have already given feedback for this assessment.") from error
    return ok(_feedback_view(attempt, feedback))


@router.get("/admin/feedback")
def admin_feedback(training_id: uuid.UUID | None = Query(default=None), _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    query = (
        select(AssessmentFeedback)
        .options(
            selectinload(AssessmentFeedback.employee).selectinload(Employee.department),
            selectinload(AssessmentFeedback.training),
            selectinload(AssessmentFeedback.attempt),
        )
        .order_by(AssessmentFeedback.submitted_at.desc())
    )
    if training_id:
        query = query.where(AssessmentFeedback.training_id == training_id)
    rows = db.scalars(query).all()

    by_training: dict[uuid.UUID, list[AssessmentFeedback]] = {}
    for row in rows:
        by_training.setdefault(row.training_id, []).append(row)

    def averages(items: list[AssessmentFeedback]) -> dict[str, float | None]:
        return {key: _average([getattr(i, column) for i in items]) for key, column in COLUMN.items()}

    def overall(items: list[AssessmentFeedback]) -> float | None:
        return _average([getattr(i, column) for i in items for column in COLUMN.values()])

    trainings = sorted(
        (
            {
                "training_id": str(tid),
                "training_code": items[0].training.training_code,
                "training_title": items[0].training.title,
                "responses": len(items),
                "averages": averages(items),
                "overall": overall(items),
                "latest_at": iso(items[0].submitted_at),
            }
            for tid, items in by_training.items()
        ),
        key=lambda t: t["training_title"].lower(),
    )
    responses = [
        {
            "id": str(r.id),
            "employee_name": r.employee.full_name,
            "employee_code": r.employee.employee_code,
            "department": r.employee.department.name if r.employee.department else None,
            "training_id": str(r.training_id),
            "training_title": r.training.title,
            "score_percent": display_percent(r.attempt.score_percent),
            "result_status": r.attempt.result_status,
            "ratings": ratings_of(r),
            "average": _average(list(ratings_of(r).values())),
            "comment": r.comment_text,
            "submitted_at": iso(r.submitted_at),
        }
        for r in rows
    ]
    filter_options = db.execute(
        select(Training.id, Training.title).join(AssessmentFeedback, AssessmentFeedback.training_id == Training.id).group_by(Training.id, Training.title).order_by(func.lower(Training.title))
    ).all()
    return ok(
        {
            "questions": questions_payload(),
            "summary": {"responses": len(rows), "trainings": len(by_training), "averages": averages(rows), "overall": overall(rows)},
            "trainings": trainings,
            "responses": responses,
            "training_options": [{"id": str(i), "name": t} for i, t in filter_options],
        }
    )
