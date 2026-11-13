"""Question-bank and completion imports. Validate, preview, then commit only valid rows."""
import re
import uuid
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.enums import AttendanceStatus, ImportStatus, ImportType, QuestionStatus, TrainingStatus
from app.core.errors import ApiError, conflict, validation
from app.models import Competency, Department, Employee, Enrolment, Function, ImportJob, ImportJobRow, Question, QuestionRevision, Training, TrainingCompletion
from app.modules.assessment.scheduling import load_calendar
from app.modules.imports.parsing import clip, has_formula
from app.modules.question_bank.router import question_problem, revision_snapshot, set_content
from app.modules.training import service as training_service

QUESTION_HEADERS = ["id", "training", "topic", "competency", "type", "question", "option_a", "option_b", "option_c", "option_d", "options_extra", "correct", "explanation", "difficulty", "marks", "level", "language", "active"]
QUESTION_OPTIONAL_HEADERS = ["department", "function"]
COMPLETION_HEADERS = ["employee", "training", "completion_date"]
COMPLETION_OPTIONAL_HEADERS = ["attendance", "source_event_id"]
# PENDING is not an attendance outcome, so a file cannot import it. Blank means Present.
IMPORT_ATTENDANCE = {a.value for a in AttendanceStatus} - {AttendanceStatus.PENDING.value}
TYPE_MAP = {"single": "MCQ_SINGLE", "multiple": "MCQ_MULTIPLE", "boolean": "TRUE_FALSE", "scenario": "SCENARIO"}
DIFFICULTY_MAP = {"Easy": "EASY", "Medium": "MEDIUM", "Hard": "HARD"}
# Questions can be prepared before activation, so Draft trainings are accepted; Archived ones are not.
IMPORTABLE_TRAINING_STATUSES = (TrainingStatus.DRAFT, TrainingStatus.ACTIVE)

TEMPLATES = {
    ImportType.QUESTIONS: [
        QUESTION_HEADERS + QUESTION_OPTIONAL_HEADERS,
        ["SAMPLE-Q01", "", "Identity checks", "Applies the documented process", "single", "A customer uploads an expired address proof. What should you do?", "Approve it because the name matches", "Request a valid document through the approved process", "Ask a colleague to approve it", "Close the application without notice", "", "B", "Expired documents cannot complete verification.", "Easy", "1", "L2", "English", "Active", "", ""],
    ],
    ImportType.COMPLETIONS: [
        COMPLETION_HEADERS + COMPLETION_OPTIONAL_HEADERS,
        ["E001", "T003", "2026-11-03", "PRESENT", ""],
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

def selected_training(db: Session, raw_id: str | None) -> Training | None:
    """The training chosen for a question import. None means a file-based import (each row names its training)."""
    if raw_id is None or not raw_id.strip():
        return None
    try:
        training = db.get(Training, uuid.UUID(raw_id.strip()))
    except ValueError:
        training = None
    if training is None:
        raise validation("The selected training does not exist. Choose a training from the list.")
    problem = training_import_problem(training)
    if problem:
        raise problem
    return training


def training_import_problem(training: Training) -> ApiError | None:
    if training.status not in IMPORTABLE_TRAINING_STATUSES:
        return conflict("TRAINING_NOT_IMPORTABLE", f"{training.title} ({training.training_code}) is {training.status.lower()}. Questions can be imported only into a draft or active training.")
    return None


def _validate_question(v: dict[str, str], seen: set[str], db: Session, context: dict | None = None) -> tuple[list[dict[str, str]], str, dict | None]:
    selected: Training | None = (context or {}).get("training")
    required = ("id", "topic", "competency", "type", "question", "option_a", "option_b", "correct", "difficulty", "marks", "level", "language", "active")
    if selected is None:
        required = ("id", "training", *required[1:])  # File-based imports name the training on every row.
    errors = [_error(k, "Required.") for k in required if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]
    status = "INVALID" if errors else "VALID"

    code = v.get("id", "").upper()
    duplicate = code in seen or bool(code and db.scalar(select(Question.id).where(func.upper(Question.question_code) == code)))
    seen.add(code)

    if selected is not None:
        # A blank training cell uses the selection. A code must match it: a mismatch is never overridden.
        training_id = selected.id
        if v.get("training") and v["training"].upper() != selected.training_code.upper():
            errors.append(_error("training", f"This row is for training {v['training']}, but the selected training is {selected.training_code}. Leave the cell blank, correct the code, or select the matching training."))
    else:
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


def completion_eligibility(db: Session, employee: Employee, training: Training, attendance: str) -> tuple[ApiError | None, bool]:
    """The manual-completion rules applied to an import row. Returns (problem, needs_new_assignment).

    A row may create the assignment only when manual assignment would also allow it: the training is
    active, the employee is active and in its audience, and the assignment was never cancelled.
    """
    enrolment = training_service.find_enrolment(db, employee.id, training.id)
    if enrolment is not None:
        return training_service.completion_problem(enrolment, attendance), False
    label = training_service.employee_label(employee)
    if training_service.cancelled_enrolment(db, employee.id, training.id) is not None:
        return ApiError(409, "ENROLMENT_CANCELLED", f"The assignment of {label} to {training.title} was cancelled. Assign the employee again in Employee Assignments before importing completion."), False
    problem = training_service.new_assignment_problem(training, employee)
    if problem:
        return problem, False
    return training_service.attendance_problem(attendance, label), True


def _validate_completion(v: dict[str, str], seen: set[str], db: Session, context: dict) -> tuple[list[dict[str, str]], str, dict | None]:
    errors = [_error(k, "Required.") for k in COMPLETION_HEADERS if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]

    employee = db.scalar(select(Employee).where(func.upper(Employee.employee_code) == v.get("employee", "").upper())) if v.get("employee") else None
    if v.get("employee") and employee is None:
        errors.append(_error("employee", "Unknown employee ID."))
    training = db.scalar(select(Training).where(func.upper(Training.training_code) == v.get("training", "").upper())) if v.get("training") else None
    if v.get("training") and training is None:
        errors.append(_error("training", "Use an existing training code."))

    attendance = (v.get("attendance") or AttendanceStatus.PRESENT.value).strip().upper()
    if attendance not in IMPORT_ATTENDANCE:
        errors.append(_error("attendance", "Use Present, Partial, Absent or Excused, or leave it blank for Present."))

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
    key = f"{employee.id}|{training.id}"
    enrolment = training_service.find_enrolment(db, employee.id, training.id)
    if key in seen or (enrolment is not None and enrolment.completion is not None):
        # Replaying a file must not create a second completion or obligation.
        seen.add(key)
        return [_error("employee", "Completion is already recorded. The row was skipped.")], "DUPLICATE", None
    event = v.get("source_event_id") or None
    if event and (event in context["events"] or db.scalar(select(TrainingCompletion.id).where(TrainingCompletion.source_event_id == event))):
        return [_error("source_event_id", "This source event ID was already imported. The row was skipped.")], "DUPLICATE", None
    seen.add(key)
    if event:
        context["events"].add(event)

    problem, creates_assignment = completion_eligibility(db, employee, training, attendance)
    if problem:
        return [_error("record", problem.message)], "INVALID", None
    notes = []
    if creates_assignment:
        notes.append(_error("assignment", "No assignment exists yet. One will be created, because the employee is active and in this training's audience."))
    if training.id not in context["readiness"]:
        context["readiness"][training.id] = training_service.assessment_readiness(db, training)
    readiness = context["readiness"][training.id]
    if not readiness.ready:
        notes.append(_error("assessment", f"Completion will be recorded, but the assessment will not be scheduled. {readiness.message} {readiness.action}"))
    return notes, "VALID", {"employee_id": str(employee.id), "training_id": str(training.id), "completion_date": completed.isoformat(), "source_event_id": event, "attendance": attendance}


def create_job(db: Session, import_type: ImportType, file_name: str, rows: list[list[str]], user_id: uuid.UUID, training: Training | None = None) -> ImportJob:
    validate, label, headers = _row_rules(import_type, rows, training)
    job = ImportJob(import_type=import_type, uploaded_by=user_id, file_name=file_name[:255], status=ImportStatus.READY, total_rows=len(rows) - 1, created_at=utcnow(), training_id=training.id if training else None)
    db.add(job)
    db.flush()
    _validate_rows(db, job, rows, training, validate, label, headers)
    return job


# Imports that never applied anything. Only these can be edited or deleted; a completed import is the record of what was added.
UNAPPLIED_STATUSES = (ImportStatus.READY, ImportStatus.CANCELLED, ImportStatus.FAILED)


def replace_job(db: Session, job: ImportJob, file_name: str, rows: list[list[str]], user_id: uuid.UUID, training: Training | None = None) -> ImportJob:
    """Edits an unapplied import: validates a corrected file, optionally for another training, into the same entry."""
    if job.status not in UNAPPLIED_STATUSES:
        raise ApiError(409, "IMPORT_ALREADY_PROCESSED", "This import has already been imported and can no longer be edited.")
    validate, label, headers = _row_rules(ImportType(job.import_type), rows, training)
    job.rows.clear()
    db.flush()
    job.file_name = file_name[:255]
    job.training_id = training.id if training else None
    job.training = training
    job.uploaded_by = user_id
    job.status = ImportStatus.READY
    job.total_rows = len(rows) - 1
    job.created_at = utcnow()
    job.completed_at = None
    _validate_rows(db, job, rows, training, validate, label, headers)
    return job


def _row_rules(import_type: ImportType, rows: list[list[str]], training: Training | None):
    if training is not None and import_type != ImportType.QUESTIONS:
        raise validation("A training is selected only for question bank imports. Completion files name the training on each row.")
    if import_type == ImportType.QUESTIONS:
        # With a selected training, the file's training column is optional.
        headers = _header_map(rows, [h for h in QUESTION_HEADERS if not (training is not None and h == "training")])
        return _validate_question, "id", headers
    return _validate_completion, "employee", _header_map(rows, COMPLETION_HEADERS)


def _validate_rows(db: Session, job: ImportJob, rows: list[list[str]], training: Training | None, validate, label: str, headers: dict[str, int]) -> None:
    import_type = job.import_type
    seen: set[str] = set()
    context: dict = {"events": set(), "readiness": {}, "training": training}
    accepted = rejected = 0
    for number, row in enumerate(rows[1:], start=2):
        cells = _cells(row, headers)
        errors, status, payload = validate(cells, seen, db, context)
        accepted += status == "VALID"
        rejected += status != "VALID"
        record = cells.get(label, "") or f"Row {number}"
        if (import_type == ImportType.COMPLETIONS or training is None) and cells.get("training"):
            record = f"{record} · {cells['training']}"  # Each row names its own training.
        db.add(ImportJobRow(import_job_id=job.id, row_number=number, row_status=status, record_label=record[:200], errors=errors, payload=payload))
    job.accepted_rows, job.rejected_rows = accepted, rejected
    db.flush()


# ---------- Commit ----------

def _competency(db: Session, name: str) -> Competency:
    competency = db.scalar(select(Competency).where(func.lower(Competency.name) == name.lower()))
    if competency is None:
        competency = Competency(code=uuid.uuid4().hex[:12].upper(), name=name)
        db.add(competency)
        db.flush()
    return competency


def _commit_question(db: Session, payload: dict, user_id: uuid.UUID, training: Training) -> None:
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
    question.trainings = [training]
    db.add(question)
    db.flush()
    set_content(db, question, payload["options"], payload["correct"])
    db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question), changed_by=user_id))


def _commit_completion(db: Session, payload: dict, user_id: uuid.UUID, job_id: uuid.UUID) -> list[dict[str, str]]:
    """Re-checks every rule at commit time, because records may have changed since the preview."""
    employee = db.get(Employee, uuid.UUID(payload["employee_id"]))
    training = db.get(Training, uuid.UUID(payload["training_id"]))
    attendance = payload.get("attendance") or AttendanceStatus.PRESENT.value
    problem, creates_assignment = completion_eligibility(db, employee, training, attendance)
    if problem:
        raise problem
    notes = []
    enrolment = training_service.find_enrolment(db, employee.id, training.id)
    if creates_assignment:
        enrolment = Enrolment(training_id=training.id, employee_id=employee.id, assigned_at=utcnow())
        db.add(enrolment)
        db.flush()
        record_audit(db, user_id, "ENROLMENT_CREATED_BY_IMPORT", "enrolment", enrolment.id, after={"import_job": str(job_id), "employee": employee.employee_code, "training": training.training_code})
        notes.append(_error("assignment", "Assignment created by this import."))
    calendar = load_calendar(db)
    completed_at = datetime.combine(date.fromisoformat(payload["completion_date"]), time.min, calendar.tz).astimezone(UTC)
    outcome = training_service.complete_enrolment(db, enrolment, completed_at, "IMPORT", user_id, source_event_id=payload.get("source_event_id"), import_job_id=job_id, attendance=attendance)
    if outcome.scheduling["status"] == "NOT_SCHEDULED":
        notes.append(_error("assessment", f"Assessment not scheduled. {outcome.scheduling['message']} {outcome.scheduling['action']}"))
    return notes


def _row_training(db: Session, job: ImportJob, payload: dict) -> Training:
    """The training a validated question row links to: the job's selection, or the row's own code."""
    training_id = uuid.UUID(payload["training_id"])
    if job.training_id is not None and training_id != job.training_id:
        raise ApiError(422, "TRAINING_MISMATCH", "This row was validated for a different training. Validate the file again.")
    training = db.get(Training, training_id)
    if training is None:
        raise ApiError(422, "TRAINING_NOT_FOUND", "The training for this row no longer exists. Validate the file again.")
    return training


def commit_job(db: Session, job: ImportJob, user_id: uuid.UUID) -> ImportJob:
    """Re-validates every row at commit time. Invalid and duplicate rows are never applied."""
    if job.status != ImportStatus.READY:
        raise ApiError(409, "IMPORT_ALREADY_PROCESSED", "This import has already been processed.")
    if job.training_id is not None:
        # The saved selection decides the link. Its conditions are checked again, as they may have changed.
        problem = training_import_problem(job.training)
        if problem:
            raise ApiError(409, problem.code, f"{problem.message} Cancel this preview and validate the file again.")
    imported = 0
    seen_codes: set[str] = set()
    for row in job.rows:
        if row.row_status != "VALID":
            continue
        savepoint = db.begin_nested()
        try:
            notes: list[dict[str, str]] = []
            if job.import_type == ImportType.QUESTIONS:
                code = row.payload["question_code"]
                if code in seen_codes or db.scalar(select(Question.id).where(Question.question_code == code)):
                    raise ApiError(409, "DUPLICATE", "This question ID now exists. The row was skipped.")
                seen_codes.add(code)
                _commit_question(db, row.payload, user_id, _row_training(db, job, row.payload))
            else:
                notes = _commit_completion(db, row.payload, user_id, job.id)
            savepoint.commit()
            row.row_status = "IMPORTED"
            row.errors = notes
            imported += 1
        except ApiError as exc:
            savepoint.rollback()
            row.row_status = "DUPLICATE" if exc.status == 409 and exc.code in ("DUPLICATE", "COMPLETION_EXISTS") else "INVALID"
            row.errors = [_error("record", exc.message)]
        except IntegrityError:
            # A completion or source event ID recorded by a concurrent request or another import.
            savepoint.rollback()
            row.row_status = "DUPLICATE"
            row.errors = [_error("record", "This completion or source event ID already exists. The row was skipped.")]
    job.accepted_rows = imported
    job.rejected_rows = job.total_rows - imported
    job.status = ImportStatus.COMPLETED if job.rejected_rows == 0 else ImportStatus.COMPLETED_WITH_ERRORS
    job.completed_at = utcnow()
    db.flush()
    return job
