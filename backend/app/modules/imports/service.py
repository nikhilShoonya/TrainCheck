"""Question-bank and completion imports. Validate, preview, then commit only valid rows."""
import re
import uuid
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.enums import ImportStatus, ImportType, QuestionStatus
from app.core.errors import ApiError
from app.models import Competency, Department, Employee, Function, ImportJob, ImportJobRow, Question, QuestionRevision, Training
from app.modules.assessment.scheduling import load_calendar
from app.modules.imports.parsing import clip, has_formula
from app.modules.question_bank.router import question_problem, revision_snapshot, set_content
from app.modules.training.service import find_enrolment, record_completion

QUESTION_HEADERS = ["id", "training", "topic", "competency", "type", "question", "option_a", "option_b", "option_c", "option_d", "options_extra", "correct", "explanation", "difficulty", "marks", "level", "language", "active"]
QUESTION_OPTIONAL_HEADERS = ["department", "function"]
COMPLETION_HEADERS = ["employee", "training", "completion_date"]
COMPLETION_OPTIONAL_HEADERS = ["source_event_id"]
TYPE_MAP = {"single": "MCQ_SINGLE", "multiple": "MCQ_MULTIPLE", "boolean": "TRUE_FALSE", "scenario": "SCENARIO"}
DIFFICULTY_MAP = {"Easy": "EASY", "Medium": "MEDIUM", "Hard": "HARD"}

TEMPLATES = {
    ImportType.QUESTIONS: [
        QUESTION_HEADERS + QUESTION_OPTIONAL_HEADERS,
        ["SAMPLE-Q01", "T001", "Identity checks", "Applies the documented process", "single", "A customer uploads an expired address proof. What should you do?", "Approve it because the name matches", "Request a valid document through the approved process", "Ask a colleague to approve it", "Close the application without notice", "", "B", "Expired documents cannot complete verification.", "Easy", "1", "L2", "English", "Active", "", ""],
    ],
    ImportType.COMPLETIONS: [
        COMPLETION_HEADERS + COMPLETION_OPTIONAL_HEADERS,
        ["E001", "T003", "2026-11-03", ""],
    ],
}


def _header_map(rows: list[list[str]], required: list[str]) -> dict[str, int]:
    headers = [h.strip().lower().lstrip("﻿") for h in rows[0]]
    missing = [h for h in required if h not in headers]
    if missing:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck template. Missing columns: {', '.join(missing)}.")
    return {h: i for i, h in enumerate(headers)}


def _cells(row: list[str], headers: dict[str, int]) -> dict[str, str]:
    return {h: clip(row[i].strip()) if i < len(row) else "" for h, i in headers.items()}


def _error(field: str, message: str) -> dict[str, str]:
    return {"field": field, "message": message}


# ---------- Validation ----------

def _validate_question(v: dict[str, str], seen: set[str], db: Session) -> tuple[list[dict[str, str]], str, dict | None]:
    errors = [_error(k, "Required.") for k in ("id", "training", "topic", "competency", "type", "question", "option_a", "option_b", "correct", "difficulty", "marks", "level", "language", "active") if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]
    status = "INVALID" if errors else "VALID"

    code = v.get("id", "").upper()
    duplicate = code in seen or bool(code and db.scalar(select(Question.id).where(func.upper(Question.question_code) == code)))
    seen.add(code)

    training_id = db.scalar(select(Training.id).where(func.upper(Training.training_code) == v.get("training", "").upper()))
    if v.get("training") and training_id is None:
        errors.append(_error("training", "Use an existing training code."))

    question_type = TYPE_MAP.get(v.get("type", "").lower())
    if v.get("type") and question_type is None:
        errors.append(_error("type", "Use single, multiple, boolean or scenario."))
    difficulty = DIFFICULTY_MAP.get(v.get("difficulty", ""))
    if v.get("difficulty") and difficulty is None:
        errors.append(_error("difficulty", "Use Easy, Medium or Hard."))

    marks = None
    try:
        marks = Decimal(v.get("marks") or "x")
        if not 0 < marks <= 100:
            errors.append(_error("marks", "Use a positive number up to 100."))
    except InvalidOperation:
        if v.get("marks"):
            errors.append(_error("marks", "Use a positive number up to 100."))

    if v.get("level") and v["level"] != "L2":
        errors.append(_error("level", "Assessment questions must be L2."))
    if v.get("active") and v["active"] not in ("Active", "Inactive"):
        errors.append(_error("active", "Use Active or Inactive."))

    options = [v.get(k, "") for k in ("option_a", "option_b", "option_c", "option_d")]
    options = [o for o in options if o] + [o.strip() for o in v.get("options_extra", "").split("|") if o.strip()]
    letters = [c.strip().upper() for c in re.split(r"[|,]", v.get("correct", "")) if c.strip()]
    if any(len(letter) != 1 or not "A" <= letter <= "Z" for letter in letters):
        errors.append(_error("correct", "Use option letters such as A or A|C."))
        correct: list[int] = []
    else:
        correct = [ord(letter) - 65 for letter in letters]
    if question_type and v.get("correct") and not any(e["field"] == "correct" for e in errors):
        problem = question_problem(question_type, options, correct, v.get("language") or "English")
        if problem:
            errors.append(_error("correct" if "orrect" in problem else "language" if "Language" in problem else "options", problem))

    department_id = function_id = None
    if v.get("department"):
        department_id = db.scalar(select(Department.id).where(func.upper(Department.code) == v["department"].upper()))
        if department_id is None:
            errors.append(_error("department", "Use an existing department code."))
    if v.get("function"):
        function_id = db.scalar(select(Function.id).where(func.upper(Function.code) == v["function"].upper()))
        if function_id is None:
            errors.append(_error("function", "Use an existing function code."))

    if errors:
        return errors, "INVALID", None
    if duplicate:
        # Never silently overwrite an existing question or answer key.
        return [_error("id", "This question ID already exists. The row was skipped.")], "DUPLICATE", None
    return [], status, {
        "question_code": code,
        "training_id": str(training_id),
        "topic": v["topic"],
        "competency": v["competency"],
        "question_type": question_type,
        "question_text": v["question"],
        "options": options,
        "correct": correct,
        "explanation": v.get("explanation") or None,
        "difficulty": difficulty,
        "marks": str(marks),
        "language": v["language"],
        "status": QuestionStatus.ACTIVE if v["active"] == "Active" else QuestionStatus.INACTIVE,
        "department_id": str(department_id) if department_id else None,
        "function_id": str(function_id) if function_id else None,
    }


def _validate_completion(v: dict[str, str], seen: set[str], db: Session) -> tuple[list[dict[str, str]], str, dict | None]:
    errors = [_error(k, "Required.") for k in COMPLETION_HEADERS if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]

    employee_id = db.scalar(select(Employee.id).where(func.upper(Employee.employee_code) == v.get("employee", "").upper()))
    if v.get("employee") and employee_id is None:
        errors.append(_error("employee", "Unknown employee ID."))
    training_id = db.scalar(select(Training.id).where(func.upper(Training.training_code) == v.get("training", "").upper()))
    if v.get("training") and training_id is None:
        errors.append(_error("training", "Use an existing training code."))

    completed: date | None = None
    if v.get("completion_date"):
        try:
            completed = date.fromisoformat(v["completion_date"].split(" ")[0])
            if completed > utcnow().date():
                errors.append(_error("completion_date", "The date cannot be in the future."))
        except ValueError:
            errors.append(_error("completion_date", "Use a valid YYYY-MM-DD date."))

    if errors:
        return errors, "INVALID", None
    key = f"{employee_id}|{training_id}"
    enrolment = find_enrolment(db, employee_id, training_id)
    if key in seen or (enrolment is not None and enrolment.completion is not None):
        # Replaying a file must not create a second completion or obligation.
        seen.add(key)
        return [_error("employee", "Completion is already recorded. The row was skipped.")], "DUPLICATE", None
    seen.add(key)
    return [], "VALID", {"employee_id": str(employee_id), "training_id": str(training_id), "completion_date": completed.isoformat(), "source_event_id": v.get("source_event_id") or None}


def create_job(db: Session, import_type: ImportType, file_name: str, rows: list[list[str]], user_id: uuid.UUID) -> ImportJob:
    if import_type == ImportType.QUESTIONS:
        headers = _header_map(rows, QUESTION_HEADERS)
        validate, label = _validate_question, "id"
    else:
        headers = _header_map(rows, COMPLETION_HEADERS)
        validate, label = _validate_completion, "employee"

    job = ImportJob(import_type=import_type, uploaded_by=user_id, file_name=file_name[:255], status=ImportStatus.READY, total_rows=len(rows) - 1, created_at=utcnow())
    db.add(job)
    db.flush()
    seen: set[str] = set()
    accepted = rejected = 0
    for number, row in enumerate(rows[1:], start=2):
        cells = _cells(row, headers)
        errors, status, payload = validate(cells, seen, db)
        accepted += status == "VALID"
        rejected += status != "VALID"
        record = cells.get(label, "") or f"Row {number}"
        if import_type == ImportType.COMPLETIONS and cells.get("training"):
            record = f"{record} · {cells['training']}"
        db.add(ImportJobRow(import_job_id=job.id, row_number=number, row_status=status, record_label=record[:200], errors=errors, payload=payload))
    job.accepted_rows, job.rejected_rows = accepted, rejected
    db.flush()
    return job


# ---------- Commit ----------

def _competency(db: Session, name: str) -> Competency:
    competency = db.scalar(select(Competency).where(func.lower(Competency.name) == name.lower()))
    if competency is None:
        competency = Competency(code=uuid.uuid4().hex[:12].upper(), name=name)
        db.add(competency)
        db.flush()
    return competency


def _commit_question(db: Session, payload: dict, user_id: uuid.UUID) -> None:
    question = Question(
        question_code=payload["question_code"],
        topic=payload["topic"],
        competency_id=_competency(db, payload["competency"]).id,
        department_id=payload["department_id"],
        function_id=payload["function_id"],
        question_type=payload["question_type"],
        question_text=payload["question_text"],
        explanation=payload["explanation"],
        difficulty=payload["difficulty"],
        language=payload["language"],
        marks=Decimal(payload["marks"]),
        status=payload["status"],
        created_by=user_id,
    )
    question.trainings = [db.get(Training, uuid.UUID(payload["training_id"]))]
    db.add(question)
    db.flush()
    set_content(db, question, payload["options"], payload["correct"])
    db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question), changed_by=user_id))


def _commit_completion(db: Session, payload: dict, user_id: uuid.UUID, job_id: uuid.UUID) -> None:
    employee_id, training_id = uuid.UUID(payload["employee_id"]), uuid.UUID(payload["training_id"])
    enrolment = find_enrolment(db, employee_id, training_id)
    if enrolment is None:
        from app.models import Enrolment

        enrolment = Enrolment(training_id=training_id, employee_id=employee_id, assigned_at=utcnow())
        db.add(enrolment)
        db.flush()
    calendar = load_calendar(db)
    completed_at = datetime.combine(date.fromisoformat(payload["completion_date"]), time.min, calendar.tz).astimezone(UTC)
    record_completion(db, enrolment, completed_at, "IMPORT", user_id, source_event_id=payload.get("source_event_id"), import_job_id=job_id)


def commit_job(db: Session, job: ImportJob, user_id: uuid.UUID) -> ImportJob:
    """Re-validates duplicates at commit time. Invalid and duplicate rows are never applied."""
    if job.status != ImportStatus.READY:
        raise ApiError(409, "IMPORT_ALREADY_PROCESSED", "This import has already been processed.")
    imported = 0
    seen_codes: set[str] = set()
    for row in job.rows:
        if row.row_status != "VALID":
            continue
        savepoint = db.begin_nested()
        try:
            if job.import_type == ImportType.QUESTIONS:
                code = row.payload["question_code"]
                if code in seen_codes or db.scalar(select(Question.id).where(Question.question_code == code)):
                    raise ApiError(409, "DUPLICATE", "This question ID now exists. The row was skipped.")
                seen_codes.add(code)
                _commit_question(db, row.payload, user_id)
            else:
                _commit_completion(db, row.payload, user_id, job.id)
            savepoint.commit()
            row.row_status = "IMPORTED"
            imported += 1
        except ApiError as exc:
            savepoint.rollback()
            row.row_status = "DUPLICATE" if exc.status == 409 else "INVALID"
            row.errors = [_error("record", exc.message)]
    job.accepted_rows = imported
    job.rejected_rows = job.total_rows - imported
    job.status = ImportStatus.COMPLETED if job.rejected_rows == 0 else ImportStatus.COMPLETED_WITH_ERRORS
    job.completed_at = utcnow()
    db.flush()
    return job
