"""Central reusable question bank. Answer keys appear only in these L&D-only responses."""
import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin
from app.core.enums import Difficulty, QuestionStatus, QuestionType
from app.core.errors import conflict, not_found, validation
from app.core.responses import num, ok
from app.models import Competency, Question, QuestionAnswerKey, QuestionOption, QuestionRevision, Training

router = APIRouter(prefix="/admin/questions", tags=["Question Bank"])

LANGUAGES = {"English", "Hindi", "Hinglish"}
MAX_OPTIONS = 12


class QuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    question_code: str | None = Field(default=None, max_length=60)
    topic: str = Field(min_length=1, max_length=160)
    competency_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None
    function_id: uuid.UUID | None = None
    question_type: QuestionType
    question_text: str = Field(min_length=3, max_length=4000)
    options: list[str] = Field(min_length=2, max_length=MAX_OPTIONS)
    correct_option_indexes: list[int] = Field(min_length=1, max_length=MAX_OPTIONS)
    explanation: str | None = Field(default=None, max_length=4000)
    difficulty: Difficulty
    marks: Decimal = Field(gt=0, le=100, decimal_places=2)
    language: str = "English"
    randomise_options: bool = True
    training_ids: list[uuid.UUID] = Field(default_factory=list)
    status: QuestionStatus = QuestionStatus.ACTIVE

    @model_validator(mode="after")
    def check_answer_key(self) -> "QuestionIn":
        problem = question_problem(self.question_type, self.options, self.correct_option_indexes, self.language)
        if problem:
            raise ValueError(problem)
        return self


def question_problem(question_type: str, options: list[str], correct: list[int], language: str) -> str | None:
    """Shared by the form and the bulk import so the two can never disagree."""
    clean = [o.strip() for o in options]
    if len(clean) < 2 or len(clean) > MAX_OPTIONS or not all(clean):
        return f"Provide 2 to {MAX_OPTIONS} answer options."
    if len({o.lower() for o in clean}) != len(clean):
        return "Answer options must be different from each other."
    if any(i < 0 or i >= len(clean) for i in correct) or len(set(correct)) != len(correct) or not correct:
        return "Correct answers must refer to listed options."
    if question_type != QuestionType.MCQ_MULTIPLE and len(correct) != 1:
        return "This question type needs exactly one correct option."
    if question_type == QuestionType.TRUE_FALSE and sorted(o.lower() for o in clean) != ["false", "true"]:
        return "True/False questions need exactly the options True and False."
    if language not in LANGUAGES:
        return "Language must be English, Hindi or Hinglish."
    return None


def question_view(q: Question, keys: list[str] | None = None) -> dict:
    data = {
        "id": str(q.id),
        "question_code": q.question_code,
        "topic": q.topic,
        "competency_id": str(q.competency_id) if q.competency_id else None,
        "competency": q.competency.name if q.competency else None,
        "department_id": str(q.department_id) if q.department_id else None,
        "department": q.department.name if q.department else None,
        "function_id": str(q.function_id) if q.function_id else None,
        "function": q.function.name if q.function else None,
        "question_type": q.question_type,
        "question_text": q.question_text,
        "difficulty": q.difficulty,
        "language": q.language,
        "marks": num(q.marks),
        "status": q.status,
        "version": q.version,
        "randomise_options": q.randomise_options,
        "trainings": [{"id": str(t.id), "title": t.title, "code": t.training_code} for t in q.trainings],
        "updated_at": q.updated_at.isoformat() if q.updated_at else None,
    }
    if keys is not None:
        data["explanation"] = q.explanation
        data["options"] = [{"id": str(o.id), "text": o.option_text, "is_correct": str(o.id) in keys} for o in q.options]
    return data


def _keys(db: Session, question_id: uuid.UUID) -> list[str]:
    return [str(k) for k in db.scalars(select(QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id == question_id))]


def set_content(db: Session, q: Question, options: list[str], correct: list[int]) -> None:
    """Replaces options and key. Attempts hold their own snapshot, so history is unaffected."""
    for option in list(q.options):
        db.delete(option)
    db.flush()
    db.expire(q, ["options"])
    created = [QuestionOption(question_id=q.id, option_text=text.strip(), display_order=i) for i, text in enumerate(options)]
    db.add_all(created)
    db.flush()
    for index in correct:
        db.add(QuestionAnswerKey(question_id=q.id, option_id=created[index].id))
    db.flush()
    db.expire(q, ["options"])


def revision_snapshot(db: Session, q: Question) -> dict:
    keys = _keys(db, q.id)
    return {
        "question_text": q.question_text,
        "topic": q.topic,
        "difficulty": q.difficulty,
        "marks": str(q.marks),
        "explanation": q.explanation,
        "options": [o.option_text for o in q.options],
        "correct": [o.option_text for o in q.options if str(o.id) in keys],
    }


@router.get("")
def search_questions(
    _: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
    search: str = Query(default="", max_length=200),
    training_id: uuid.UUID | None = None,
    competency_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
    function_id: uuid.UUID | None = None,
    question_type: QuestionType | None = None,
    difficulty: Difficulty | None = None,
    language: str | None = None,
    status: QuestionStatus | None = None,
) -> dict:
    query = (
        select(Question)
        .options(selectinload(Question.competency), selectinload(Question.department), selectinload(Question.function), selectinload(Question.trainings))
        .order_by(Question.question_code)
    )
    if search:
        like = f"%{search}%"
        query = query.where(Question.question_text.ilike(like) | Question.question_code.ilike(like) | Question.topic.ilike(like))
    if training_id:
        query = query.where(Question.trainings.any(Training.id == training_id))
    for column, value in (
        (Question.competency_id, competency_id),
        (Question.department_id, department_id),
        (Question.function_id, function_id),
        (Question.question_type, question_type),
        (Question.difficulty, difficulty),
        (Question.language, language),
        (Question.status, status),
    ):
        if value:
            query = query.where(column == value)
    return ok([question_view(q) for q in db.scalars(query)])


@router.get("/{question_id}")
def get_question(question_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    question = db.get(Question, question_id)
    if question is None:
        raise not_found()
    return ok(question_view(question, _keys(db, question.id)))


def _trainings(db: Session, ids: list[uuid.UUID]) -> list[Training]:
    trainings = list(db.scalars(select(Training).where(Training.id.in_(ids))))
    if len(trainings) != len(set(ids)):
        raise validation("A selected training no longer exists.")
    return trainings


@router.post("")
def create_question(body: QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    if body.competency_id and db.get(Competency, body.competency_id) is None:
        raise validation("The selected competency no longer exists.")
    question = Question(
        question_code=(body.question_code or f"Q-{uuid.uuid4().hex[:8]}").upper(),
        topic=body.topic,
        competency_id=body.competency_id,
        department_id=body.department_id,
        function_id=body.function_id,
        question_type=body.question_type,
        question_text=body.question_text,
        explanation=body.explanation,
        difficulty=body.difficulty,
        language=body.language,
        marks=body.marks,
        randomise_options=body.randomise_options,
        status=body.status,
        created_by=user.id,
    )
    question.trainings = _trainings(db, body.training_ids)
    db.add(question)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("DUPLICATE_CODE", "A question with this ID already exists.") from exc
    set_content(db, question, body.options, body.correct_option_indexes)
    db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question), changed_by=user.id))
    record_audit(db, user.id, "QUESTION_CREATED", "question", question.id, after={"code": question.question_code})
    db.commit()
    db.refresh(question)
    return ok(question_view(question, _keys(db, question.id)))


@router.patch("/{question_id}")
def update_question(question_id: uuid.UUID, body: QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Creates a new version. Running and past attempts keep their snapshot (TC-SCORE-011)."""
    question = db.get(Question, question_id)
    if question is None:
        raise not_found()
    question.version += 1
    question.topic = body.topic
    question.competency_id, question.department_id, question.function_id = body.competency_id, body.department_id, body.function_id
    question.question_type, question.question_text, question.explanation = body.question_type, body.question_text, body.explanation
    question.difficulty, question.language, question.marks = body.difficulty, body.language, body.marks
    question.randomise_options, question.status = body.randomise_options, body.status
    question.trainings = _trainings(db, body.training_ids)
    set_content(db, question, body.options, body.correct_option_indexes)
    db.add(QuestionRevision(question_id=question.id, version=question.version, content_snapshot=revision_snapshot(db, question), changed_by=user.id))
    record_audit(db, user.id, "QUESTION_UPDATED", "question", question.id, after={"version": question.version})
    db.commit()
    db.refresh(question)
    return ok(question_view(question, _keys(db, question.id)))


class StatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: QuestionStatus


@router.post("/{question_id}/status")
def set_status(question_id: uuid.UUID, body: StatusIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Deactivation stops future selection. Questions are never deleted while history needs them."""
    question = db.get(Question, question_id)
    if question is None:
        raise not_found()
    before = question.status
    question.status = body.status
    record_audit(db, user.id, "QUESTION_STATUS_CHANGED", "question", question.id, before={"status": before}, after={"status": body.status})
    db.commit()
    return ok(question_view(question))
