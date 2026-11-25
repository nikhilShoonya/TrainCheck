"""Central reusable question bank. Answer keys appear only in these L&D-only responses."""
import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin
from app.core.enums import AssessmentType, Difficulty, QuestionStatus, QuestionType
from app.core.errors import conflict, not_found, validation
from app.core.responses import num, ok
from app.core.routing import ReleasingRoute
from app.models import Competency, Department, Function, Question, QuestionAnswerKey, QuestionOption, QuestionRevision, QuestionTrainingTag, Training
from app.modules.assessment.service import TEST_TYPE_LABEL, link_serves, link_serves_clause
from app.modules.training.locks import hold_trainings, training_gone

router = APIRouter(route_class=ReleasingRoute, prefix="/admin/questions", tags=["Question Bank"])

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
    # Optional, used only when a question is created: the test (PRE_TEST or POST_TEST) that one of the selected
    # trainings may draw it for, e.g. when it is added from that training's test in the Question Bank. Trainings
    # not named here get an unclassified link (eligible for both of their tests), as before. Edits ignore it, so
    # an existing link's classification is never changed by the form.
    training_test_types: dict[uuid.UUID, AssessmentType] = Field(default_factory=dict, max_length=1)
    status: QuestionStatus = QuestionStatus.ACTIVE
    # Edits only, and required there: the version the editor loaded. An edit made from an older version is refused
    # (409 QUESTION_CHANGED) instead of overwriting a newer one. Ignored when a question is created.
    expected_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def check_answer_key(self) -> "QuestionIn":
        problem = question_problem(self.question_type, self.options, self.correct_option_indexes, self.language)
        if problem:
            raise ValueError(problem)
        if any(training_id not in self.training_ids for training_id in self.training_test_types):
            raise ValueError("A test type can only be set for a selected training.")
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
    test_types = {link.training_id: link.test_type for link in q.training_links}
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
        # test_type: the test of that training that may draw the question. None is a legacy, unclassified link
        # (eligible for both tests of that training until classified).
        "trainings": [{"id": str(t.id), "title": t.title, "code": t.training_code, "test_type": test_types.get(t.id)} for t in q.trainings],
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
    test_type: AssessmentType | None = None,
    unassigned: bool = False,
) -> dict:
    """With training_id and test_type: only the questions that training's pre-test or post-test may draw, by the
    same link rule as the assessment engine (link_serves_clause), so an unclassified legacy link is listed for both
    tests and a link for the other test never is. Every other filter narrows within that selection.

    With unassigned=true: only questions linked to no training at all (a link to an archived training still counts)."""
    if test_type and not training_id:
        raise validation("Choose a training to filter by test type.")
    if unassigned and training_id:
        raise validation("Unassigned questions have no training: remove the training filter.")
    query = (
        select(Question)
        .options(selectinload(Question.competency), selectinload(Question.department), selectinload(Question.function), selectinload(Question.trainings), selectinload(Question.training_links))
        .order_by(Question.question_code)
    )
    if search:
        like = f"%{search}%"
        query = query.where(Question.question_text.ilike(like) | Question.question_code.ilike(like) | Question.topic.ilike(like))
    if training_id and test_type:
        query = query.where(Question.training_links.any(and_(QuestionTrainingTag.training_id == training_id, link_serves_clause(test_type))))
    elif training_id:
        query = query.where(Question.trainings.any(Training.id == training_id))
    if unassigned:
        query = query.where(~Question.training_links.any())
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


@router.get("/summary")
def question_summary(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """One entry per training and test with linked questions (pre-test, then post-test).

    question_count is exactly what GET /admin/questions?training_id=…&test_type=… lists with no other filter:
    every linked question once (Active and Inactive), counting an unclassified legacy link for both tests.
    """
    counts: dict[tuple[uuid.UUID, str], dict[str, int]] = {}
    rows = db.execute(
        select(QuestionTrainingTag.training_id, QuestionTrainingTag.test_type, Question.status, func.count())
        .join(Question, Question.id == QuestionTrainingTag.question_id)
        .group_by(QuestionTrainingTag.training_id, QuestionTrainingTag.test_type, Question.status)
    ).all()
    for training_id, link_type, status, n in rows:
        for test in AssessmentType:
            if not link_serves(link_type, test):
                continue
            entry = counts.setdefault((training_id, test), {"question_count": 0, "active": 0, "inactive": 0, "unclassified": 0})
            entry["question_count"] += n
            entry["active" if status == QuestionStatus.ACTIVE else "inactive"] += n
            if link_type is None:
                entry["unclassified"] += n
    return ok(
        [
            {"training_id": str(t.id), "title": t.title, "code": t.training_code, "status": t.status, "test_type": test.value, **counts[t.id, test]}
            for t in db.scalars(select(Training).order_by(Training.title))
            for test in (AssessmentType.PRE_TEST, AssessmentType.POST_TEST)
            if (t.id, test) in counts
        ]
    )


@router.get("/unassigned-summary")
def unassigned_summary(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """How many questions are linked to no training (the Unassigned Questions card): exactly what
    GET /admin/questions?unassigned=true lists with no other filter, Active and Inactive."""
    rows = db.execute(select(Question.status, func.count()).where(~Question.training_links.any()).group_by(Question.status)).all()
    by_status = {status: n for status, n in rows}
    total = sum(by_status.values())
    active = by_status.get(QuestionStatus.ACTIVE, 0)
    return ok({"question_count": total, "active": active, "inactive": total - active})


class AssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    training_id: uuid.UUID
    test_type: AssessmentType


def _not_drawn_reason(q: Question, has_key: bool) -> str | None:
    """Why a linked question would still not be drawn: the assessment engine's eligibility rule (pool_report)."""
    if q.status != QuestionStatus.ACTIVE:
        return "Inactive: it will not be drawn until it is activated."
    if not has_key:
        return "It has no correct answer: it will not be drawn until one is set."
    if len(q.options) < 2:
        return "It has fewer than two options: it will not be drawn until it has at least two."
    return None


# Declared before /{question_id}, so "assign" is never read as a question ID.
@router.post("/assign")
def assign_questions(body: AssignIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Links existing questions to one training's pre-test or post-test. Never copies a question or changes its
    content, answer key, revisions or status, and never changes a link that already exists.

    Each question gets its own outcome: ASSIGNED (a new link for this test), ALREADY_ASSIGNED (an existing link already
    serves this test, including an unclassified legacy link, which serves both), OTHER_TEST (an existing link to this
    training serves only the other test: kept unchanged, not assigned) or NOT_FOUND. A repeat of the same request
    changes nothing and reports ALREADY_ASSIGNED. Links to other trainings, including ones added meanwhile, are never
    touched. `warning` says why an assigned question will not be drawn yet (Inactive, no answer key, too few options)."""
    from app.modules.imports.service import training_import_problem  # Imports depend on this module.

    ids = list(dict.fromkeys(body.question_ids))
    # The training lock (training.locks): a training deleted at this moment is a clean 404, never a foreign-key error.
    training = db.scalar(select(Training).where(Training.id == body.training_id).with_for_update(read=True, key_share=True))
    if training is None:
        raise training_gone("The selected training no longer exists. Choose another training.")
    problem = training_import_problem(training)
    if problem:  # The Import Centre's rule: questions go only to a draft or active training.
        raise conflict(problem.code, f"{training.title} ({training.training_code}) is {training.status.lower()}. Questions can be assigned only to a draft or active training.")
    test = body.test_type
    questions = {q.id: q for q in db.scalars(select(Question).options(selectinload(Question.options)).where(Question.id.in_(ids)))}
    found = [i for i in ids if i in questions]
    inserted: set[uuid.UUID] = set()
    existing: dict[uuid.UUID, str | None] = {}
    keys: set[uuid.UUID] = set()
    if found:
        # ON CONFLICT DO NOTHING: a link that exists, or that a concurrent request creates first, is kept as it is.
        statement = pg_insert(QuestionTrainingTag).values([{"question_id": i, "training_id": training.id, "test_type": test.value} for i in found])
        inserted = set(db.scalars(statement.on_conflict_do_nothing(index_elements=["question_id", "training_id"]).returning(QuestionTrainingTag.question_id)))
        links = select(QuestionTrainingTag.question_id, QuestionTrainingTag.test_type).where(QuestionTrainingTag.training_id == training.id, QuestionTrainingTag.question_id.in_(found))
        existing = {question_id: link_type for question_id, link_type in db.execute(links)}
        keys = set(db.scalars(select(QuestionAnswerKey.question_id).where(QuestionAnswerKey.question_id.in_(found))))
    label = TEST_TYPE_LABEL[test]
    results = []
    for question_id in ids:
        q = questions.get(question_id)
        if q is None:
            results.append({"question_id": str(question_id), "question_code": None, "status": "NOT_FOUND", "test_type": None, "warning": None, "message": "This question no longer exists."})
            continue
        link_type = existing.get(question_id)
        warning = _not_drawn_reason(q, question_id in keys)
        if question_id in inserted:
            status, message = "ASSIGNED", f"Assigned to the {label}."
        elif link_type is None:
            status, message = "ALREADY_ASSIGNED", "Already linked to this training without a test type, so both of its tests use it. The link was not changed."
        elif link_serves(link_type, test):
            status, message = "ALREADY_ASSIGNED", f"Already assigned to this training's {label}."
        else:
            status, message = "OTHER_TEST", f"Already linked to this training's {TEST_TYPE_LABEL[link_type]} only. That link was kept; the question was not assigned to the {label}."
            warning = None
        results.append({"question_id": str(q.id), "question_code": q.question_code, "status": status, "test_type": link_type, "warning": warning, "message": message})
    summary = {key: sum(1 for r in results if r["status"] == key) for key in ("ASSIGNED", "ALREADY_ASSIGNED", "OTHER_TEST", "NOT_FOUND")}
    summary["NOT_DRAWN"] = sum(1 for r in results if r["warning"])
    after = {"test_type": test.value, "assigned": [r["question_code"] for r in results if r["status"] == "ASSIGNED"], **{k.lower(): v for k, v in summary.items()}}
    record_audit(db, user.id, "QUESTIONS_ASSIGNED", "training", training.id, after=after)
    db.commit()
    return ok({"training": {"id": str(training.id), "title": training.title, "code": training.training_code}, "test_type": test.value, "summary": summary, "results": results})


@router.get("/{question_id}")
def get_question(question_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    question = db.get(Question, question_id)
    if question is None:
        raise not_found()
    return ok(question_view(question, _keys(db, question.id)))


def _trainings(db: Session, ids: list[uuid.UUID]) -> list[Training]:
    """The selected trainings, with the training lock (training.locks): one deleted at this moment is reported as
    gone, never linked after its deletion."""
    if not ids:
        return []
    trainings = list(db.scalars(select(Training).where(Training.id.in_(ids)).order_by(Training.id).with_for_update(read=True, key_share=True)))
    if len(trainings) != len(set(ids)):
        raise validation("A selected training no longer exists.")
    return trainings


def _check_references(db: Session, body: QuestionIn) -> None:
    """A clear 400 for a competency, department or function that does not exist, instead of a foreign-key 500."""
    for model, value, label in ((Competency, body.competency_id, "competency"), (Department, body.department_id, "department"), (Function, body.function_id, "function")):
        if value and db.get(model, value) is None:
            raise validation(f"The selected {label} no longer exists.")


@router.post("")
def create_question(body: QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    _check_references(db, body)
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
    for training_id, test in body.training_test_types.items():
        link = db.get(QuestionTrainingTag, (question.id, training_id))
        link.test_type = test.value
    if body.training_test_types:
        db.flush()
        db.expire(question, ["training_links"])
    set_content(db, question, body.options, body.correct_option_indexes)
    db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question), changed_by=user.id))
    record_audit(db, user.id, "QUESTION_CREATED", "question", question.id, after={"code": question.question_code})
    db.commit()
    db.refresh(question)
    return ok(question_view(question, _keys(db, question.id)))


@router.patch("/{question_id}")
def update_question(question_id: uuid.UUID, body: QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Creates a new version. Running and past attempts keep their snapshot (TC-SCORE-011).

    Two admins editing the same question take turns: the question row is locked and read again, and an edit based on
    a version that is no longer current is refused with 409 QUESTION_CHANGED. The options, answer key and revision
    history are therefore only ever changed by one edit at a time, from the version it was made against."""
    if body.expected_version is None:
        raise validation("Reload the question and edit it again: the version being edited is missing.")
    question = db.scalar(select(Question).where(Question.id == question_id).with_for_update().execution_options(populate_existing=True))
    if question is None:
        raise not_found()
    if question.version != body.expected_version:
        raise conflict(
            "QUESTION_CHANGED",
            f"Someone else saved this question meanwhile (version {question.version}; you edited version {body.expected_version}). Reload it and make your change again.",
            {"current_version": question.version, "expected_version": body.expected_version},
        )
    _check_references(db, body)
    # The locks of the trainings linked now (training.locks), before their links are read: a link removed here is
    # never removed at the same moment by a permanent deletion of its training.
    hold_trainings(db, db.scalars(select(QuestionTrainingTag.training_id).where(QuestionTrainingTag.question_id == question.id)).all())
    question.version += 1
    question.topic = body.topic
    question.competency_id, question.department_id, question.function_id = body.competency_id, body.department_id, body.function_id
    question.question_type, question.question_text, question.explanation = body.question_type, body.question_text, body.explanation
    question.difficulty, question.language, question.marks = body.difficulty, body.language, body.marks
    question.randomise_options, question.status = body.randomise_options, body.status
    # Links kept in the list keep their row, so a pre-test or post-test classification is never lost by an edit.
    # A training added here gets an unclassified link (eligible for both of its tests), as before.
    question.trainings = _trainings(db, body.training_ids)
    set_content(db, question, body.options, body.correct_option_indexes)
    db.add(QuestionRevision(question_id=question.id, version=question.version, content_snapshot=revision_snapshot(db, question), changed_by=user.id))
    record_audit(db, user.id, "QUESTION_UPDATED", "question", question.id, after={"version": question.version})
    try:
        db.commit()
    except IntegrityError as exc:  # Defence in depth: the row lock makes a duplicate revision impossible.
        db.rollback()
        raise conflict("QUESTION_CHANGED", "Someone else saved this question at the same moment. Reload it and make your change again.") from exc
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
