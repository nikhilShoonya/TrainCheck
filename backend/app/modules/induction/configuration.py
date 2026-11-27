"""The common induction configuration, shared by every induction card and batch.

- Assessment rules: numbered versions; one is current. An attempt copies the version it starts with.
- The question paper: one ordered list of induction questions (separate from the Training question bank). Every
  employee gets every active question, in this order. Attempts snapshot each question, so later edits never change
  a started or finished attempt.
- The feedback form: numbered versions; one is current. Assignments freeze the version when the assessment starts.

Nothing here has a default: until L&D saves the official content, the module reports itself not ready.
"""
import re
import secrets
import uuid
from decimal import Decimal
from types import SimpleNamespace

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.enums import InductionFeedbackControl, QuestionStatus, QuestionType
from app.core.errors import ApiError, conflict, not_found, validation
from app.core.responses import num
from app.models import (
    InductionAssessmentSettings,
    InductionFeedbackForm,
    InductionQuestion,
    InductionQuestionOption,
)
from app.modules.feedback.questionnaire import STANDARD_OPTIONS, question as feedback_question
from app.modules.imports import question_format as qf
from app.modules.induction.common import FORM_LOCK, QUESTIONS_LOCK, SETTINGS_LOCK, advisory_lock
from app.modules.question_bank.router import MAX_OPTIONS, question_problem

MAX_FEEDBACK_QUESTIONS = 30
MAX_COMMENT = 2000
STAR_OPTIONS = [(n, f"{n} star{'s' if n != 1 else ''}") for n in range(1, 6)]


# ---------- Assessment rules ----------

class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_minutes: int = Field(ge=1, le=600)
    pass_mark_percent: Decimal = Field(ge=0, le=100, decimal_places=2)
    violation_limit: int = Field(ge=1, le=20)
    require_fullscreen: bool = True


def current_settings(db: Session) -> InductionAssessmentSettings | None:
    return db.scalar(select(InductionAssessmentSettings).where(InductionAssessmentSettings.is_current.is_(True)))


def settings_view(settings: InductionAssessmentSettings | None) -> dict | None:
    if settings is None:
        return None
    return {
        "id": str(settings.id),
        "version": settings.version,
        "duration_seconds": settings.duration_seconds,
        "pass_mark_percent": num(settings.pass_mark_percent),
        "violation_limit": settings.violation_limit,
        "require_fullscreen": settings.require_fullscreen,
        "max_attempts": 1,
        "created_at": settings.created_at.isoformat() if settings.created_at else None,
    }


def save_settings(db: Session, body: SettingsIn, actor_id: uuid.UUID) -> InductionAssessmentSettings:
    advisory_lock(db, SETTINGS_LOCK)
    before = current_settings(db)
    version = (db.scalar(select(func.max(InductionAssessmentSettings.version))) or 0) + 1
    db.execute(update(InductionAssessmentSettings).where(InductionAssessmentSettings.is_current.is_(True)).values(is_current=False))
    settings = InductionAssessmentSettings(
        version=version,
        duration_seconds=body.duration_minutes * 60,
        pass_mark_percent=body.pass_mark_percent,
        violation_limit=body.violation_limit,
        require_fullscreen=body.require_fullscreen,
        is_current=True,
        created_by=actor_id,
    )
    db.add(settings)
    db.flush()
    record_audit(db, actor_id, "INDUCTION_SETTINGS_SAVED", "induction_assessment_settings", settings.id, before=settings_view(before), after=settings_view(settings))
    return settings


# ---------- The question paper ----------

class QuestionIn(BaseModel):
    """The Question Bank's own rules (question_problem) apply, so the two forms can never disagree."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    topic: str = Field(min_length=1, max_length=160)
    question_type: QuestionType
    question_text: str = Field(min_length=3, max_length=4000)
    options: list[str] = Field(min_length=2, max_length=MAX_OPTIONS)
    correct_option_indexes: list[int] = Field(min_length=1, max_length=MAX_OPTIONS)
    explanation: str | None = Field(default=None, max_length=4000)
    marks: Decimal = Field(gt=0, le=100, decimal_places=2)
    status: QuestionStatus = QuestionStatus.ACTIVE
    expected_version: int | None = Field(default=None, ge=1)  # Edits: the version the editor loaded.

    @model_validator(mode="after")
    def check_answer_key(self) -> "QuestionIn":
        problem = question_problem(self.question_type, self.options, self.correct_option_indexes, "English")
        if problem:
            raise ValueError(problem)
        return self


def question_view(q: InductionQuestion) -> dict:
    """L&D only: includes the answer key."""
    return {
        "id": str(q.id),
        "question_code": q.question_code,
        "topic": q.topic,
        "question_type": q.question_type,
        "question_text": q.question_text,
        "explanation": q.explanation,
        "marks": num(q.marks),
        "status": q.status,
        "display_order": q.display_order,
        "version": q.version,
        "options": [{"id": str(o.id), "text": o.option_text, "is_correct": o.is_correct} for o in q.options],
        "updated_at": q.updated_at.isoformat() if q.updated_at else None,
    }


def all_questions(db: Session) -> list[InductionQuestion]:
    return list(db.scalars(select(InductionQuestion).options(selectinload(InductionQuestion.options)).order_by(InductionQuestion.display_order, InductionQuestion.id)))


def active_questions(db: Session) -> list[InductionQuestion]:
    """The paper every employee gets, in its fixed order."""
    return list(
        db.scalars(
            select(InductionQuestion)
            .options(selectinload(InductionQuestion.options))
            .where(InductionQuestion.status == QuestionStatus.ACTIVE)
            .order_by(InductionQuestion.display_order, InductionQuestion.id)
        )
    )


def _new_code(db: Session, taken: set[str] | None = None) -> str:
    for _ in range(10):
        code = f"IQ-{secrets.token_hex(qf.CODE_RANDOM_BYTES).upper()}"
        if (taken is None or code not in taken) and db.scalar(select(InductionQuestion.id).where(InductionQuestion.question_code == code)) is None:
            if taken is not None:
                taken.add(code)
            return code
    raise ApiError(500, "CODE_GENERATION_FAILED", "A question ID could not be generated. Try again.")


def _set_options(db: Session, q: InductionQuestion, options: list[str], correct: list[int]) -> None:
    for option in list(q.options):
        db.delete(option)
    db.flush()
    db.expire(q, ["options"])
    db.add_all(InductionQuestionOption(question_id=q.id, option_text=text.strip(), display_order=i, is_correct=i in correct) for i, text in enumerate(options))
    db.flush()
    db.expire(q, ["options"])


def _next_order(db: Session) -> int:
    return (db.scalar(select(func.max(InductionQuestion.display_order))) or 0) + 1


def create_question(db: Session, body: QuestionIn, actor_id: uuid.UUID, source: str = "FORM") -> InductionQuestion:
    advisory_lock(db, QUESTIONS_LOCK)
    q = InductionQuestion(
        question_code=_new_code(db),
        topic=body.topic,
        question_type=body.question_type,
        question_text=body.question_text,
        explanation=body.explanation or None,
        marks=body.marks,
        status=body.status,
        display_order=_next_order(db),
        version=1,
        created_by=actor_id,
    )
    db.add(q)
    db.flush()
    _set_options(db, q, body.options, body.correct_option_indexes)
    record_audit(db, actor_id, "INDUCTION_QUESTION_CREATED", "induction_question", q.id, after={"code": q.question_code, "source": source})
    return q


def update_question(db: Session, question_id: uuid.UUID, body: QuestionIn, actor_id: uuid.UUID) -> InductionQuestion:
    q = db.scalar(select(InductionQuestion).where(InductionQuestion.id == question_id).with_for_update())
    if q is None:
        raise not_found("This induction question does not exist.")
    if body.expected_version is None:
        raise validation("Reload the question and edit it again.")
    if body.expected_version != q.version:
        raise conflict("QUESTION_CHANGED", "Someone changed this question after you opened it. Reload it and make your change again.")
    before = {"version": q.version, "status": q.status}
    q.topic = body.topic
    q.question_type = body.question_type
    q.question_text = body.question_text
    q.explanation = body.explanation or None
    q.marks = body.marks
    q.status = body.status
    q.version += 1
    _set_options(db, q, body.options, body.correct_option_indexes)
    record_audit(db, actor_id, "INDUCTION_QUESTION_UPDATED", "induction_question", q.id, before=before, after={"version": q.version, "status": q.status})
    return q


def move_question(db: Session, question_id: uuid.UUID, direction: str, actor_id: uuid.UUID) -> None:
    """Swaps the question with its neighbour in the paper's order."""
    advisory_lock(db, QUESTIONS_LOCK)
    q = db.get(InductionQuestion, question_id)
    if q is None:
        raise not_found("This induction question does not exist.")
    earlier = direction == "up"
    neighbour = db.scalar(
        select(InductionQuestion)
        .where(InductionQuestion.display_order < q.display_order if earlier else InductionQuestion.display_order > q.display_order)
        .order_by(InductionQuestion.display_order.desc() if earlier else InductionQuestion.display_order)
        .limit(1)
    )
    if neighbour is None:
        return
    q.display_order, neighbour.display_order = neighbour.display_order, q.display_order
    db.flush()
    record_audit(db, actor_id, "INDUCTION_QUESTION_MOVED", "induction_question", q.id, after={"direction": direction})


# ---------- Question import: the existing seven-field MCQ format ----------

# The Import Centre's row rules are reused unchanged. They need a "selected training" only to label the payload;
# induction questions belong to the common paper, so a placeholder stands in for it and its fields are dropped.
_PAPER = SimpleNamespace(id="induction-paper")


def preview_question_rows(db: Session, rows: list[list[str]]) -> dict:
    """Validates a question file without saving. VALID rows are importable; INVALID rows need correcting;
    DUPLICATE (same question already in the paper or earlier in the file) and CONFLICT (same text, different
    content) rows are skipped, as in the Import Centre."""
    from app.modules.imports import service as import_service

    headers = import_service._question_header_map(rows)
    existing = {qf.content_key(q.question_text): q for q in all_questions(db)}
    in_file: dict[str, tuple[int, dict]] = {}
    out = []
    first = getattr(rows, "first_data_row", 2)
    for number, row in enumerate(rows[1:], start=first):
        cells = import_service._cells(row, headers)
        errors, status, payload = import_service._validate_question(cells, set(), db, {"training": _PAPER, "test_type": None})
        if payload is not None:
            payload = {k: payload[k] for k in ("topic", "question_type", "question_text", "options", "correct")}
            key = qf.content_key(payload["question_text"])
            signature = qf.payload_signature(payload)
            match = existing.get(key)
            if match is not None:
                theirs = qf.signature(options=[o.option_text for o in match.options], correct_texts=[o.option_text for o in match.options if o.is_correct], topic=match.topic, question_type_value=match.question_type)
                different = qf.differences(signature, theirs)
                status = "CONFLICT" if different else "DUPLICATE"
                errors = [{"field": "question", "message": f"{match.question_code} already has this question text with a different {', '.join(different)}. Skipped; edit it in the paper if needed." if different else f"Already in the induction paper as {match.question_code}. Skipped."}]
            elif key in in_file:
                earlier_row, earlier_payload = in_file[key]
                different = qf.differences(signature, qf.payload_signature(earlier_payload))
                status = "CONFLICT" if different else "DUPLICATE"
                errors = [{"field": "question", "message": f"Row {earlier_row} has the same question text{' with a different ' + ', '.join(different) if different else ''}. Skipped."}]
            else:
                in_file[key] = (number, payload)
        out.append({"row": number, "status": status, "question": qf.excerpt(cells.get("question", "")) or f"Row {number}", "topic": cells.get("topic", ""), "correct": cells.get("correct", ""), "errors": errors, "payload": payload if status == "VALID" else None})
    counts = {s: sum(1 for r in out if r["status"] == s) for s in ("VALID", "INVALID", "DUPLICATE", "CONFLICT")}
    return {"total_rows": len(out), "valid_rows": counts["VALID"], "invalid_rows": counts["INVALID"], "duplicate_rows": counts["DUPLICATE"], "conflict_rows": counts["CONFLICT"], "ready": counts["VALID"] > 0, "rows": out}


def import_question_rows(db: Session, rows: list[list[str]], actor_id: uuid.UUID) -> tuple[dict, list[InductionQuestion]]:
    """Re-validates under the paper lock and adds every VALID row, in file order, at the end of the paper. Other
    rows are skipped and reported. Marks 1 and Single choice, as for every import in this format."""
    advisory_lock(db, QUESTIONS_LOCK)
    result = preview_question_rows(db, rows)
    if not result["ready"]:
        raise conflict("IMPORT_NOT_READY", "Nothing was imported: no row can be added. Fix the file and validate it again.", _public_preview(result))
    created = []
    for row in result["rows"]:
        if row["status"] != "VALID":
            continue
        p = row["payload"]
        created.append(
            create_question(
                db,
                QuestionIn(topic=p["topic"], question_type=p["question_type"], question_text=p["question_text"], options=p["options"], correct_option_indexes=p["correct"], marks=qf.DEFAULT_MARKS),
                actor_id,
                source="IMPORT",
            )
        )
    return _public_preview(result), created


def _public_preview(result: dict) -> dict:
    return {**result, "rows": [{k: v for k, v in r.items() if k != "payload"} for r in result["rows"]]}


# ---------- The feedback form ----------

_KEY = re.compile(r"[^a-z0-9]+")


class FeedbackQuestionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    section: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=3, max_length=400)
    control: InductionFeedbackControl = InductionFeedbackControl.SCALE


class FeedbackFormIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    questions: list[FeedbackQuestionIn] = Field(min_length=1, max_length=MAX_FEEDBACK_QUESTIONS)
    comment_enabled: bool = True
    comment_label: str | None = Field(default=None, max_length=300)
    expected_version: int | None = Field(default=None, ge=0)  # 0 when no form exists yet.

    @model_validator(mode="after")
    def distinct(self) -> "FeedbackFormIn":
        texts = [q.text.casefold() for q in self.questions]
        if len(set(texts)) != len(texts):
            raise ValueError("Each feedback question must be different.")
        return self


def current_form(db: Session) -> InductionFeedbackForm | None:
    return db.scalar(select(InductionFeedbackForm).where(InductionFeedbackForm.is_current.is_(True)))


def form_view(form: InductionFeedbackForm | None) -> dict | None:
    if form is None:
        return None
    return {
        "id": str(form.id),
        "version": form.version,
        "questions": form.questions,
        "comment_enabled": form.comment_enabled,
        "comment_label": form.comment_label,
        "created_at": form.created_at.isoformat() if form.created_at else None,
    }


def save_form(db: Session, body: FeedbackFormIn, actor_id: uuid.UUID) -> InductionFeedbackForm:
    advisory_lock(db, FORM_LOCK)
    before = current_form(db)
    if body.expected_version is not None and body.expected_version != (before.version if before else 0):
        raise conflict("FORM_CHANGED", "Someone saved the feedback form after you opened it. Reload it and make your change again.")
    version = (db.scalar(select(func.max(InductionFeedbackForm.version))) or 0) + 1
    questions = []
    for index, q in enumerate(body.questions, start=1):
        slug = _KEY.sub("_", q.text.casefold()).strip("_")[:40] or "question"
        questions.append({"key": f"q{index}_{slug}", "section": q.section, "text": q.text, "control": q.control.value})
    db.execute(update(InductionFeedbackForm).where(InductionFeedbackForm.is_current.is_(True)).values(is_current=False))
    form = InductionFeedbackForm(
        version=version,
        questions=questions,
        comment_enabled=body.comment_enabled,
        comment_label=(body.comment_label or None) if body.comment_enabled else None,
        is_current=True,
        created_by=actor_id,
    )
    db.add(form)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("FORM_CHANGED", "Someone saved the feedback form at the same moment. Reload it and try again.") from exc
    record_audit(db, actor_id, "INDUCTION_FEEDBACK_FORM_SAVED", "induction_feedback_form", form.id, before={"version": before.version} if before else None, after={"version": form.version, "questions": len(questions)})
    return form


def form_questions_for_employee(form_questions: list[dict]) -> list[dict]:
    """The stored questions in the shape the existing feedback dialog renders (FeedbackView.questions)."""
    out = []
    for q in form_questions:
        stars = q["control"] == InductionFeedbackControl.STARS
        out.append(feedback_question(q["key"], q["section"], q["text"][:60], q["text"], STAR_OPTIONS if stars else STANDARD_OPTIONS, stars=stars))
    return out


def answer_label(question: dict, value: int | None) -> str:
    if value is None:
        return "—"
    choices = dict(STAR_OPTIONS if question.get("control") == InductionFeedbackControl.STARS else STANDARD_OPTIONS)
    return f"{value} – {choices.get(value, value)}"


# ---------- Readiness ----------

def readiness(db: Session) -> dict:
    """Whether an employee can start the induction assessment and then give feedback. Every reason is actionable."""
    settings = current_settings(db)
    questions = active_questions(db)
    form = current_form(db)
    assessment_problems = []
    if settings is None:
        assessment_problems.append("Set the assessment rules: duration, pass mark and violation limit.")
    if not questions:
        assessment_problems.append("Add at least one active question to the common induction paper.")
    broken = [q.question_code for q in questions if question_problem(q.question_type, [o.option_text for o in q.options], [i for i, o in enumerate(q.options) if o.is_correct], "English")]
    if broken:
        assessment_problems.append(f"Fix the answer options of {', '.join(broken[:5])}{' and others' if len(broken) > 5 else ''}.")
    feedback_problems = [] if form and form.questions else ["Create the common induction feedback form (at least one question)."]
    return {
        "ready": not assessment_problems and not feedback_problems,
        "assessment": {"ready": not assessment_problems, "problems": assessment_problems, "question_count": len(questions), "total_marks": num(sum((q.marks for q in questions), Decimal(0)))},
        "feedback": {"ready": not feedback_problems, "problems": feedback_problems, "question_count": len(form.questions) if form else 0},
    }
