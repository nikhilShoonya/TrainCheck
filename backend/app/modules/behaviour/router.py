"""Behaviour APIs: employee self-assessment, manager observation and L&D template management."""
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_gate_clear, require_manager, require_reader, team_employee_ids
from app.core.enums import ReviewerType
from app.core.errors import forbidden, not_found, validation
from app.core.responses import iso, ok
from app.models import BehaviourReview, BehaviourTemplate, BehaviourTemplateQuestion, Competency
from app.modules.behaviour import service

router = APIRouter(tags=["Behaviour"])


class ResponseIn(BaseModel):
    template_question_id: uuid.UUID
    rating: int
    example_text: str | None = None
    comment_text: str | None = None


class SubmitReviewIn(BaseModel):
    responses: list[ResponseIn] = Field(max_length=50)


class TemplateQuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    competency_id: uuid.UUID
    prompt: str = Field(min_length=5, max_length=2000)
    example_required: bool = True


class TemplateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=3, max_length=200)
    training_id: uuid.UUID | None = None
    function_id: uuid.UUID | None = None
    questions: list[TemplateQuestionIn] = Field(min_length=1, max_length=30)


def review_summary(review: BehaviourReview) -> dict:
    cycle = review.cycle
    return {
        "review_id": str(review.id),
        "reviewer_type": review.reviewer_type,
        "employee_id": str(cycle.employee_id),
        "employee_name": cycle.employee.full_name,
        "employee_code": cycle.employee.employee_code,
        "training_id": str(cycle.training_id),
        "training_title": cycle.training.title,
        "period_days": cycle.period_days,
        "due_at": iso(cycle.due_at),
        "status": service.review_status(review),
        "submitted_at": iso(review.submitted_at),
        "submitted_by": review.submitted_by.full_name if review.submitted_by else None,
        "template_name": cycle.template.name,
    }


def review_form(review: BehaviourReview) -> dict:
    by_question = {r.template_question_id: r for r in review.responses}
    return {
        **review_summary(review),
        "questions": [
            {
                "template_question_id": str(q.id),
                "competency": q.competency.name,
                "competency_description": q.competency.description,
                "prompt": q.prompt,
                "example_required": q.example_required,
                "rating": by_question[q.id].rating if q.id in by_question else None,
                "example_text": by_question[q.id].example_text if q.id in by_question else None,
                "comment_text": by_question[q.id].comment_text if q.id in by_question else None,
            }
            for q in review.cycle.template.questions
        ],
    }


def _load_review(db: Session, review_id: uuid.UUID) -> BehaviourReview:
    review = db.get(BehaviourReview, review_id)
    if review is None:
        raise not_found()
    return review


# ---------- Employee ----------

@router.get("/me/behaviour-reviews")
def my_reviews(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    return ok([review_summary(r) for r in service.reviews_for_self(db, user.employee_id)])


def _own_review(db: Session, review_id: uuid.UUID, user: CurrentUser) -> BehaviourReview:
    review = _load_review(db, review_id)
    if review.reviewer_type != ReviewerType.SELF or review.cycle.employee_id != user.employee_id:
        raise not_found()
    return review


@router.get("/me/behaviour-reviews/{review_id}")
def my_review(review_id: uuid.UUID, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    return ok(review_form(_own_review(db, review_id, user)))


@router.post("/me/behaviour-reviews/{review_id}/submit")
def submit_my_review(review_id: uuid.UUID, body: SubmitReviewIn, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    review = _own_review(db, review_id, user)
    service.submit_review(db, review, user.employee_id, [r.model_dump() for r in body.responses])
    record_audit(db, user.id, "BEHAVIOUR_SELF_SUBMITTED", "behaviour_review", review.id)
    db.commit()
    return ok(review_summary(review))


# ---------- Manager ----------

@router.get("/manager/behaviour-reviews")
def manager_reviews(user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    team = team_employee_ids(db, user.employee_id)
    return ok([review_summary(r) for r in service.reviews_for_team(db, team, user.employee_id)])


def _team_review(db: Session, review_id: uuid.UUID, user: CurrentUser, for_submit: bool = False) -> BehaviourReview:
    review = _load_review(db, review_id)
    if review.reviewer_type != ReviewerType.MANAGER:
        raise not_found()
    in_team = review.cycle.employee_id in team_employee_ids(db, user.employee_id)
    wrote_it = review.submitted_by_employee_id == user.employee_id
    if (for_submit and not in_team) or not (in_team or wrote_it):
        raise not_found()  # The same response whether the record exists or not.
    return review


@router.get("/manager/behaviour-reviews/{review_id}")
def manager_review(review_id: uuid.UUID, user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    review = _team_review(db, review_id, user)
    data = review_form(review)
    own = next((r for r in review.cycle.reviews if r.reviewer_type == ReviewerType.SELF), None)
    # Self-ratings appear only after the manager has submitted, so they cannot anchor the observation.
    data["self_assessment"] = review_form(own)["questions"] if own and own.submitted_at and review.submitted_at else None
    return ok(data)


@router.post("/manager/behaviour-reviews/{review_id}/submit")
def submit_manager_review(review_id: uuid.UUID, body: SubmitReviewIn, user: CurrentUser = Depends(require_manager), db: Session = Depends(get_db)) -> dict:
    review = _team_review(db, review_id, user, for_submit=True)
    if review.cycle.employee_id == user.employee_id:
        raise forbidden("A manager cannot observe their own behaviour review.")
    service.submit_review(db, review, user.employee_id, [r.model_dump() for r in body.responses])
    record_audit(db, user.id, "BEHAVIOUR_OBSERVATION_SUBMITTED", "behaviour_review", review.id)
    db.commit()
    return ok(review_summary(review))


# ---------- L&D templates ----------

def template_view(template: BehaviourTemplate) -> dict:
    return {
        "id": str(template.id),
        "code": template.code,
        "version": template.version,
        "name": template.name,
        "training_id": str(template.training_id) if template.training_id else None,
        "training_title": template.training.title if template.training else None,
        "function_id": str(template.function_id) if template.function_id else None,
        "function_name": template.function.name if template.function else None,
        "is_active": template.is_active,
        "questions": [
            {
                "id": str(q.id),
                "competency_id": str(q.competency_id),
                "competency": q.competency.name,
                "prompt": q.prompt,
                "example_required": q.example_required,
                "display_order": q.display_order,
            }
            for q in template.questions
        ],
    }


def _add_questions(db: Session, template: BehaviourTemplate, questions: list[TemplateQuestionIn]) -> None:
    seen = set()
    for order, question in enumerate(questions, start=1):
        if db.get(Competency, question.competency_id) is None:
            raise validation("A selected competency no longer exists.")
        seen.add(question.competency_id)
        db.add(BehaviourTemplateQuestion(template_id=template.id, competency_id=question.competency_id, prompt=question.prompt.strip(), example_required=question.example_required, display_order=order))


@router.get("/admin/behaviour-templates")
def list_templates(_: CurrentUser = Depends(require_reader), db: Session = Depends(get_db)) -> dict:
    templates = db.scalars(
        select(BehaviourTemplate)
        .options(selectinload(BehaviourTemplate.questions).selectinload(BehaviourTemplateQuestion.competency), selectinload(BehaviourTemplate.training), selectinload(BehaviourTemplate.function))
        .where(BehaviourTemplate.is_active)
        .order_by(BehaviourTemplate.name)
    ).all()
    return ok([template_view(t) for t in templates])


@router.post("/admin/behaviour-templates")
def create_template(body: TemplateIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    if body.training_id is None and body.function_id is None:
        raise validation("Choose a training, a function or both for this questionnaire.")
    count = db.scalar(select(func.count()).select_from(BehaviourTemplate)) or 0
    template = BehaviourTemplate(code=f"BT-{count + 1:04d}-{uuid.uuid4().hex[:6]}", name=body.name.strip(), training_id=body.training_id, function_id=body.function_id, created_by=user.id)
    db.add(template)
    db.flush()
    _add_questions(db, template, body.questions)
    record_audit(db, user.id, "BEHAVIOUR_TEMPLATE_CREATED", "behaviour_template", template.id, after={"name": template.name})
    db.commit()
    db.refresh(template)
    return ok(template_view(template))


@router.patch("/admin/behaviour-templates/{template_id}")
def update_template(template_id: uuid.UUID, body: TemplateIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Creates a new version. Cycles already created keep the version they started with."""
    current = db.get(BehaviourTemplate, template_id)
    if current is None or not current.is_active:
        raise not_found()
    if body.training_id is None and body.function_id is None:
        raise validation("Choose a training, a function or both for this questionnaire.")
    current.is_active = False
    db.flush()
    template = BehaviourTemplate(code=current.code, version=current.version + 1, name=body.name.strip(), training_id=body.training_id, function_id=body.function_id, created_by=user.id)
    db.add(template)
    db.flush()
    _add_questions(db, template, body.questions)
    record_audit(db, user.id, "BEHAVIOUR_TEMPLATE_VERSIONED", "behaviour_template", template.id, before={"version": current.version}, after={"version": template.version})
    db.commit()
    db.refresh(template)
    return ok(template_view(template))


@router.delete("/admin/behaviour-templates/{template_id}")
def retire_template(template_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Stops future use. Existing cycles and answers stay intact."""
    template = db.get(BehaviourTemplate, template_id)
    if template is None or not template.is_active:
        raise not_found()
    template.is_active = False
    record_audit(db, user.id, "BEHAVIOUR_TEMPLATE_RETIRED", "behaviour_template", template.id)
    db.commit()
    return ok({"retired": True})

