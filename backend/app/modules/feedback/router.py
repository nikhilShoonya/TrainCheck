"""Official training feedback after a post-training assessment: ten ratings and optional comments.

Asked once per assessment (obligation), on the result page of its first submitted attempt; retakes do not ask
again. Pre-tests never ask. L&D Admins read every response and the per-training averages.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
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
from app.core.routing import ReleasingRoute
from app.models import AssessmentAttempt, AssessmentFeedback, Employee, Training
from app.modules.assessment.gate import feedback_exempt
from app.modules.assessment.service import get_own_attempt
from app.modules.feedback.questionnaire import LEGACY_COLUMNS, LEGACY_QUESTIONS, QUESTIONS, RETIRED_TRAINER_QUESTION
from app.modules.training.locks import hold_training

router = APIRouter(route_class=ReleasingRoute, tags=["Assessment feedback"])

MAX_COMMENT = 2000


class Ratings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    satisfaction: int = Field(ge=1, le=5)
    role_relevance: int = Field(ge=1, le=5)
    objectives: int = Field(ge=1, le=5)
    applicability: int = Field(ge=1, le=5)
    interaction: int = Field(ge=1, le=5)
    pace: int = Field(ge=1, le=5)
    trainer_preparation: int = Field(ge=1, le=5)
    materials: int = Field(ge=1, le=5)
    environment: int = Field(ge=1, le=5)
    logistics: int = Field(ge=1, le=5)


class FeedbackIn(BaseModel):
    ratings: Ratings
    comment: str | None = Field(default=None, max_length=MAX_COMMENT)


def questions_payload(feedback: AssessmentFeedback | None = None) -> list[dict]:
    if feedback is not None:
        if feedback.training_ratings is None:
            return LEGACY_QUESTIONS
        if RETIRED_TRAINER_QUESTION["key"] in feedback.training_ratings:
            return QUESTIONS[:7] + [RETIRED_TRAINER_QUESTION] + QUESTIONS[7:]
    return QUESTIONS


def ratings_of(feedback: AssessmentFeedback) -> dict[str, int]:
    if feedback.training_ratings is not None:
        return feedback.training_ratings
    return {key: getattr(feedback, column) for key, column in LEGACY_COLUMNS.items()}


def _average(values: list[int]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _feedback_for(db: Session, attempt: AssessmentAttempt) -> AssessmentFeedback | None:
    return db.scalar(select(AssessmentFeedback).where(AssessmentFeedback.obligation_id == attempt.obligation_id))


def _feedback_view(db: Session, attempt: AssessmentAttempt, feedback: AssessmentFeedback | None) -> dict:
    eligible = attempt.assessment_type == AssessmentType.POST_TEST and attempt.result_status is not None
    # Same rule as the gate (assessment.gate.feedback_due): results from before the cutoff are never asked.
    required = eligible and feedback is None and not feedback_exempt(db, attempt.obligation_id)
    return {
        "required": required,
        "training_title": attempt.training.title,
        "questions": questions_payload(feedback),
        "submitted": None if feedback is None else {"ratings": ratings_of(feedback), "comment": feedback.comment_text, "submitted_at": iso(feedback.submitted_at)},
    }


@router.get("/attempts/{attempt_id}/feedback")
def get_feedback(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = get_own_attempt(db, attempt_id, user.employee_id)
    return ok(_feedback_view(db, attempt, _feedback_for(db, attempt)))


@router.post("/attempts/{attempt_id}/feedback")
def submit_feedback(attempt_id: uuid.UUID, body: FeedbackIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = get_own_attempt(db, attempt_id, user.employee_id)
    hold_training(db, attempt.training_id)  # A training deleted meanwhile is a 404, never a foreign-key error.
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
        training_ratings=body.ratings.model_dump(),
    )
    db.add(feedback)
    try:
        db.flush()  # Assigns the ID, so the audit record names the feedback it is about.
        record_audit(db, user.id, "ASSESSMENT_FEEDBACK_SUBMITTED", "assessment_feedback", feedback.id, after={"attempt_id": str(attempt.id)})
        db.commit()
    except IntegrityError as error:  # The same feedback sent twice at once, e.g. from two tabs.
        db.rollback()
        raise conflict("FEEDBACK_ALREADY_SUBMITTED", "You have already given feedback for this assessment.") from error
    return ok(_feedback_view(db, attempt, feedback))


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
    # Never present old assessment-specific answers as answers to the new training questions.
    report_questions = list(QUESTIONS)
    if any(RETIRED_TRAINER_QUESTION["key"] in (r.training_ratings or {}) for r in rows):
        report_questions.insert(7, RETIRED_TRAINER_QUESTION)
    if any(r.training_ratings is None for r in rows):
        report_questions += LEGACY_QUESTIONS

    by_training: dict[uuid.UUID, list[AssessmentFeedback]] = {}
    for row in rows:
        by_training.setdefault(row.training_id, []).append(row)

    def averages(items: list[AssessmentFeedback]) -> dict[str, float | None]:
        return {q["key"]: _average([ratings_of(i)[q["key"]] for i in items if q["key"] in ratings_of(i)]) for q in report_questions}

    def overall(items: list[AssessmentFeedback]) -> float | None:
        return _average([value for i in items for value in ratings_of(i).values()])

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
            "questions": report_questions,
            "summary": {"responses": len(rows), "trainings": len(by_training), "averages": averages(rows), "overall": overall(rows)},
            "trainings": trainings,
            "responses": responses,
            "training_options": [{"id": str(i), "name": t} for i, t in filter_options],
        }
    )
