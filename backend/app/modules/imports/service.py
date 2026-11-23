"""Question-bank and completion imports. Validate, preview, then commit only valid rows."""
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.enums import AssessmentType, AttendanceStatus, EnrolmentStatus, ImportStatus, ImportType, QuestionStatus, TrainingStatus
from app.core.errors import ApiError, conflict, validation
from app.models import Employee, Enrolment, ImportJob, ImportJobRow, Question, QuestionRevision, QuestionTrainingTag, Training, TrainingCompletion
from app.modules.assessment.scheduling import load_calendar
from app.modules.assessment.service import active_config, pool_report
from app.modules.imports import question_format as qf
from app.modules.imports.parsing import clip, has_formula
from app.modules.organisation.people import is_learner
from app.modules.question_bank.router import revision_snapshot, set_content
from app.modules.training import service as training_service

COMPLETION_HEADERS = ["employee", "training", "completion_date"]
COMPLETION_OPTIONAL_HEADERS = ["attendance", "source_event_id"]
# PENDING is not an attendance outcome, so a file cannot import it. Blank means Present.
IMPORT_ATTENDANCE = {a.value for a in AttendanceStatus} - {AttendanceStatus.PENDING.value}
# Questions can be prepared before activation, so Draft trainings are accepted; Archived ones are not.
IMPORTABLE_TRAINING_STATUSES = (TrainingStatus.DRAFT, TrainingStatus.ACTIVE)

# Three sample MCQs: four options and one correct letter each.
QUESTION_SAMPLES = [
    {"question": "A customer uploads an expired address proof. What should you do?", "option_a": "Approve it because the name matches", "option_b": "Request a valid document through the approved process", "option_c": "Ask a colleague to approve it", "option_d": "Close the application without notice", "correct": "B", "topic": "Identity checks"},
    {"question": "Which of these can be accepted as current proof of address?", "option_a": "A passport that expired last year", "option_b": "A handwritten note from a neighbour", "option_c": "A bank statement dated this quarter", "option_d": "A photo of an unsigned form", "correct": "C", "topic": "Identity checks"},
    {"question": "How should customer identity documents be shared with a colleague?", "option_a": "Through personal email", "option_b": "Through the approved document system", "option_c": "Through a messaging app", "option_d": "On a printed copy left at the desk", "correct": "B", "topic": "Data protection"},
]


def question_samples() -> list[dict[str, str]]:
    return [dict(sample) for sample in QUESTION_SAMPLES]


def template_rows(import_type: ImportType) -> list[list[str]]:
    if import_type == ImportType.QUESTIONS:
        return [list(qf.FIELDS)] + [[sample[f] for f in qf.FIELDS] for sample in question_samples()]
    return [COMPLETION_HEADERS + COMPLETION_OPTIONAL_HEADERS, ["E001", "T003", "2026-11-03", "PRESENT", ""]]


def _header_map(rows: list[list[str]], required: list[str]) -> dict[str, int]:
    headers = [h.strip().lower().lstrip("﻿") for h in rows[0]]
    missing = [h for h in required if h not in headers]
    if missing:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck template. Missing columns: {', '.join(missing)}.")
    return {h: i for i, h in enumerate(headers)}


def _question_header_map(rows: list[list[str]]) -> dict[str, int]:
    """The seven-field MCQ format. Earlier-template and unknown columns are refused, never silently ignored."""
    headers = [h.strip().lower().lstrip("﻿") for h in rows[0]]
    old = [h for h in qf.OLD_COLUMNS if h in headers]
    if old:
        raise ApiError(400, "INVALID_HEADERS", f"This file uses an old question template (column{'s' if len(old) > 1 else ''} {', '.join(old)}). Download the new template: it has only question, option_a, option_b, option_c, option_d, correct and topic. The training and test type are chosen on the import screen; TrainCheck sets the rest.")
    unknown = [h for h in headers if h and h not in qf.FIELDS]
    if unknown:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck question template. Unknown columns: {', '.join(unknown)}.")
    repeated = sorted({h for h in headers if h and headers.count(h) > 1})
    if repeated:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck question template. Columns appearing more than once: {', '.join(repeated)}.")
    missing = [h for h in qf.REQUIRED if h not in headers]
    if missing:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck question template. Missing columns: {', '.join(missing)}.")
    return {h: i for i, h in enumerate(headers) if h}


def _cells(row: list[str], headers: dict[str, int]) -> dict[str, str]:
    return {h: clip(row[i].strip()) if i < len(row) else "" for h, i in headers.items()}


def _error(field: str, message: str) -> dict[str, str]:
    return {"field": field, "message": message}


# ---------- Validation ----------


class Lookups:
    """Everything row validation reads from the database, loaded once per file instead of once per row.

    A 5,000-row file used to cost several round trips per row; against Neon that outlasts the 30-second proxy
    timeout (audit F-13). Matching is case-insensitive, exactly as the per-row queries were.
    """

    def __init__(self, db: Session, import_type: str, cells: list[dict[str, str]]) -> None:
        def upper(values) -> set[str]:
            return {v.upper() for v in values if v}

        training_codes = upper(c.get("training", "") for c in cells)
        self.trainings: dict[str, Training] = {
            t.training_code.upper(): t for t in db.scalars(select(Training).where(func.upper(Training.training_code).in_(training_codes)))
        } if training_codes else {}
        self.employees: dict[str, Employee] = {}
        self.live: dict[tuple[uuid.UUID, uuid.UUID], Enrolment] = {}
        self.cancelled: set[tuple[uuid.UUID, uuid.UUID]] = set()
        self.events: set[str] = set()
        if import_type == ImportType.QUESTIONS:
            return  # Question rows name no training, department or competency: nothing to look up per row.
        employee_codes = upper(c.get("employee", "") for c in cells)
        if employee_codes:
            # The designated L&D Admin sign-in record is not a learner: its ID reads as an unknown employee.
            self.employees = {e.employee_code.upper(): e for e in db.scalars(select(Employee).where(func.upper(Employee.employee_code).in_(employee_codes), is_learner()))}
        employee_ids, training_ids = [e.id for e in self.employees.values()], [t.id for t in self.trainings.values()]
        if employee_ids and training_ids:
            for enrolment in db.scalars(
                select(Enrolment)
                .options(selectinload(Enrolment.completion))
                .where(Enrolment.employee_id.in_(employee_ids), Enrolment.training_id.in_(training_ids))
            ):
                pair = (enrolment.employee_id, enrolment.training_id)
                if enrolment.enrolment_status == EnrolmentStatus.CANCELLED:
                    self.cancelled.add(pair)
                else:
                    self.live[pair] = enrolment
        events = {c.get("source_event_id") for c in cells if c.get("source_event_id")}
        if events:
            self.events = set(db.scalars(select(TrainingCompletion.source_event_id).where(TrainingCompletion.source_event_id.in_(events))))

TEST_TYPE_LABEL = {AssessmentType.PRE_TEST.value: "Pre-test", AssessmentType.POST_TEST.value: "Post-test"}


def selected_training(db: Session, raw_id: str | None) -> Training | None:
    """The training chosen in the Import Centre. None when nothing was chosen (completion imports)."""
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


def selected_test_type(raw: str | None) -> str | None:
    """The test type chosen for a question import: PRE_TEST or POST_TEST. None when nothing was chosen."""
    if raw is None or not raw.strip():
        return None
    value = raw.strip().upper()
    if value not in TEST_TYPE_LABEL:
        raise validation("Choose Pre-test or Post-test as the test type.")
    return value


def check_selections(import_type: ImportType, training: Training | None, test_type: str | None) -> None:
    """Question imports name one training and one test type, chosen explicitly; completion imports name neither.

    Nothing is defaulted: a question import without a test type would put its questions in both pools.
    """
    if import_type == ImportType.QUESTIONS:
        if training is None:
            raise validation("Select the training these questions belong to.")
        if test_type is None:
            raise validation("Select the test type: Pre-test or Post-test. The questions will be used only for that test.")
        return
    if training is not None or test_type is not None:
        raise validation("A training and test type are selected only for question bank imports. Completion files name the training on each row.")


def training_import_problem(training: Training) -> ApiError | None:
    if training.status not in IMPORTABLE_TRAINING_STATUSES:
        return conflict("TRAINING_NOT_IMPORTABLE", f"{training.title} ({training.training_code}) is {training.status.lower()}. Questions can be imported only into a draft or active training.")
    return None


def _validate_question(v: dict[str, str], seen: set[str], db: Session, context: dict) -> tuple[list[dict[str, str]], str, dict | None]:
    """One row of the seven-field MCQ format. Duplicates and conflicts are decided afterwards for the whole file
    (_classify_questions), because they depend on the other rows and on the selected training's pool."""
    selected: Training = context["training"]
    errors = [_error(k, "Required.") for k in qf.REQUIRED if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]

    if len(v.get("topic", "")) > qf.MAX_TOPIC:
        errors.append(_error("topic", f"Use at most {qf.MAX_TOPIC:,} characters."))
    if len(v.get("question", "")) > qf.MAX_TEXT:
        errors.append(_error("question", f"Use at most {qf.MAX_TEXT:,} characters."))
    elif v.get("question") and len(v["question"]) < qf.MIN_QUESTION:
        errors.append(_error("question", f"Use at least {qf.MIN_QUESTION} characters."))

    # Four options, all different. Compared as the duplicate check compares them: case and spacing do not count.
    options = [v.get(field, "") for field in qf.OPTION_FIELDS]
    if all(options):
        seen_options: dict[str, str] = {}
        for field, option in zip(qf.OPTION_FIELDS, options, strict=True):
            key = qf.normalise(option)
            if key in seen_options:
                errors.append(_error(field, f"This option is the same as {seen_options[key]}. Give four different options."))
            else:
                seen_options[key] = field

    correct = None
    if v.get("correct"):
        correct, problem = qf.correct_letter(v["correct"])
        if problem:
            errors.append(_error("correct", problem))

    if errors:
        return errors, "INVALID", None
    return [], "VALID", {
        "format": qf.PAYLOAD_FORMAT,
        "training_id": str(selected.id),
        "test_type": context["test_type"],
        "topic": v["topic"],
        "question_type": qf.IMPORT_TYPE,
        "question_text": v["question"],
        "options": options,
        "correct": [correct],
    }


@dataclass
class _Row:
    number: int
    status: str
    record: str
    errors: list[dict[str, str]]
    payload: dict | None


OTHER_TEST_TYPE = {AssessmentType.PRE_TEST.value: AssessmentType.POST_TEST.value, AssessmentType.POST_TEST.value: AssessmentType.PRE_TEST.value}


def _classify_questions(rows: list[_Row], pool: qf.Pool, test_type: str) -> None:
    """Content-based duplicates and conflicts, scoped to the selected training and test type.

    Against the pool: identical content is a duplicate (skipped); the same text with different content is a conflict
    (skipped for review, never overwritten). Within the file: identical repeats after the first row are duplicates;
    rows sharing a text with different content are all conflicts, because the right version cannot be chosen.
    """
    label, other = TEST_TYPE_LABEL[test_type], TEST_TYPE_LABEL[OTHER_TEST_TYPE[test_type]]
    groups: dict[str, list[_Row]] = {}
    for row in rows:
        if row.status != "VALID":
            continue
        found = pool.match(row.payload, label)
        if found:
            row.status, row.errors, row.payload = found[0], [_error("question", found[1])], None
            continue
        groups.setdefault(qf.content_key(row.payload["question_text"]), []).append(row)
    for members in groups.values():
        if len(members) == 1:
            continue
        first = members[0]
        signatures = [qf.payload_signature(m.payload) for m in members]
        if all(sig == signatures[0] for sig in signatures):
            for row in members[1:]:
                row.status, row.payload = "DUPLICATE", None
                row.errors = [_error("question", f"Same question as row {first.number} in this file. Only row {first.number} is imported; this row was skipped.")]
            continue
        numbers = ", ".join(str(m.number) for m in members)
        changed = ", ".join(dict.fromkeys(d for sig in signatures[1:] for d in qf.differences(signatures[0], sig)))
        for row in members:
            row.status, row.payload = "CONFLICT", None
            row.errors = [_error("question", f"Rows {numbers} have the same question text but different {changed}. None of them is imported, because the right version cannot be chosen automatically. Correct the file and validate it again. {qf.GENERIC_STEM_HINT}")]
    for row in rows:
        if row.status == "VALID":
            note = pool.other_test_note(row.payload, label, other)
            if note:
                row.errors = [_error("note", note)]


def completion_eligibility(db: Session, employee: Employee, training: Training, attendance: str, lookups: "Lookups | None" = None) -> tuple[ApiError | None, bool]:
    """The manual-completion rules applied to an import row. Returns (problem, needs_new_assignment).

    A row may create the assignment only when manual assignment would also allow it: the training is
    active, the employee is active and in its audience, and the assignment was never cancelled.
    """
    pair = (employee.id, training.id)
    enrolment = lookups.live.get(pair) if lookups else training_service.find_enrolment(db, employee.id, training.id)
    if enrolment is not None:
        return training_service.completion_problem(enrolment, attendance), False
    label = training_service.employee_label(employee)
    cancelled = pair in lookups.cancelled if lookups else training_service.cancelled_enrolment(db, employee.id, training.id) is not None
    if cancelled:
        return ApiError(409, "ENROLMENT_CANCELLED", f"The assignment of {label} to {training.title} was cancelled. Assign the employee again in Employee Assignments before importing completion."), False
    problem = training_service.new_assignment_problem(training, employee)
    if problem:
        return problem, False
    return training_service.attendance_problem(attendance, label), True


def _validate_completion(v: dict[str, str], seen: set[str], db: Session, context: dict) -> tuple[list[dict[str, str]], str, dict | None]:
    errors = [_error(k, "Required.") for k in COMPLETION_HEADERS if not v.get(k)]
    errors += [_error(k, "Use plain values, not formulas.") for k, value in v.items() if has_formula(value)]

    lookups: Lookups = context["lookups"]
    employee = lookups.employees.get(v.get("employee", "").upper()) if v.get("employee") else None
    if v.get("employee") and employee is None:
        errors.append(_error("employee", "Unknown employee ID."))
    training = lookups.trainings.get(v.get("training", "").upper()) if v.get("training") else None
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
    enrolment = lookups.live.get((employee.id, training.id))
    if key in seen or (enrolment is not None and enrolment.completion is not None):
        # Replaying a file must not create a second completion or obligation.
        seen.add(key)
        return [_error("employee", "Completion is already recorded. The row was skipped.")], "DUPLICATE", None
    event = v.get("source_event_id") or None
    if event and (event in context["events"] or event in lookups.events):
        return [_error("source_event_id", "This source event ID was already imported. The row was skipped.")], "DUPLICATE", None
    seen.add(key)
    if event:
        context["events"].add(event)

    problem, creates_assignment = completion_eligibility(db, employee, training, attendance, lookups)
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


def create_job(db: Session, import_type: ImportType, file_name: str, rows: list[list[str]], user_id: uuid.UUID, training: Training | None = None, test_type: str | None = None) -> ImportJob:
    validate, label, headers = _row_rules(import_type, rows, training, test_type)
    job = ImportJob(import_type=import_type, uploaded_by=user_id, file_name=file_name[:255], status=ImportStatus.READY, total_rows=len(rows) - 1, created_at=utcnow(), training_id=training.id if training else None, test_type=test_type)
    db.add(job)
    db.flush()
    _validate_rows(db, job, rows, training, test_type, validate, label, headers)
    return job


# Only unapplied imports can be edited or permanently deleted. Completed entries retain their source records when removed from history.
UNAPPLIED_STATUSES = (ImportStatus.READY, ImportStatus.CANCELLED, ImportStatus.FAILED)


def replace_job(db: Session, job: ImportJob, file_name: str, rows: list[list[str]], user_id: uuid.UUID, training: Training | None = None, test_type: str | None = None) -> ImportJob:
    """Edits an unapplied import: validates a corrected file, optionally for another training or test type, into the same entry."""
    if job.status not in UNAPPLIED_STATUSES:
        raise ApiError(409, "IMPORT_ALREADY_PROCESSED", "This import has already been imported and can no longer be edited.")
    validate, label, headers = _row_rules(ImportType(job.import_type), rows, training, test_type)
    job.rows.clear()
    db.flush()
    job.file_name = file_name[:255]
    job.training_id = training.id if training else None
    job.training = training
    job.test_type = test_type
    job.uploaded_by = user_id
    job.status = ImportStatus.READY
    job.total_rows = len(rows) - 1
    job.created_at = utcnow()
    job.completed_at = None
    _validate_rows(db, job, rows, training, test_type, validate, label, headers)
    return job


def _row_rules(import_type: ImportType, rows: list[list[str]], training: Training | None, test_type: str | None):
    check_selections(import_type, training, test_type)
    if import_type == ImportType.QUESTIONS:
        return _validate_question, "question", _question_header_map(rows)
    return _validate_completion, "employee", _header_map(rows, COMPLETION_HEADERS)


def _validate_rows(db: Session, job: ImportJob, rows: list[list[str]], training: Training | None, test_type: str | None, validate, label: str, headers: dict[str, int]) -> None:
    import_type = job.import_type
    seen: set[str] = set()
    all_cells = [_cells(row, headers) for row in rows[1:]]
    context: dict = {"events": set(), "readiness": {}, "training": training, "test_type": test_type, "lookups": Lookups(db, import_type, all_cells)}
    results: list[_Row] = []
    # Spreadsheets number data rows from 2 (row 1 is the header); PDFs number question blocks from 1.
    for number, cells in enumerate(all_cells, start=getattr(rows, "first_data_row", 2)):
        errors, status, payload = validate(cells, seen, db, context)
        if import_type == ImportType.QUESTIONS:
            record = qf.excerpt(cells.get("question", "")) or f"Row {number}"
        else:
            record = cells.get(label, "") or f"Row {number}"
            if cells.get("training"):
                record = f"{record} · {cells['training']}"  # Each row names its own training.
        results.append(_Row(number, status, record, errors, payload))
    if import_type == ImportType.QUESTIONS:
        _classify_questions(results, qf.Pool(db, training.id, test_type), test_type)
    for row in results:
        db.add(ImportJobRow(import_job_id=job.id, row_number=row.number, row_status=row.status, record_label=row.record[:200], errors=row.errors, payload=row.payload))
    job.accepted_rows = sum(1 for r in results if r.status == "VALID")
    job.rejected_rows = len(results) - job.accepted_rows
    db.flush()


# ---------- Commit ----------

CODE_ATTEMPTS = 3


def _commit_question(db: Session, payload: dict, user_id: uuid.UUID, training: Training, test_type: str, taken: set[str]) -> str:
    """Creates one confirmed question and returns its generated ID.

    Backend-managed fields: a new unique question ID; Single choice; 1 mark and Easy difficulty; no competency,
    explanation, department or function; Active status, because L&D Admin has reviewed the preview and confirmed it
    (the question can be drawn by the selected test straight away and can be deactivated in the Question Bank); the
    internal English language default; L2 is implicit. The text is stored as supplied.
    """
    for attempt in range(CODE_ATTEMPTS):
        question = Question(
            question_code=qf.new_code(db, taken),
            topic=payload["topic"],
            competency_id=None,
            department_id=None,
            function_id=None,
            question_type=payload["question_type"],
            question_text=payload["question_text"],
            explanation=None,
            difficulty=qf.DEFAULT_DIFFICULTY,
            language=qf.IMPORT_LANGUAGE,
            marks=qf.DEFAULT_MARKS,
            status=QuestionStatus.ACTIVE,
            created_by=user_id,
        )
        attempt_point = db.begin_nested()
        try:
            db.add(question)
            db.flush()
        except IntegrityError:
            # Only a concurrent insert of the same generated ID can collide: try another ID.
            attempt_point.rollback()
            if attempt == CODE_ATTEMPTS - 1:
                raise
            continue
        attempt_point.commit()
        break
    # The one link this import makes: the selected training, for the selected test only.
    db.add(QuestionTrainingTag(question_id=question.id, training_id=training.id, test_type=test_type))
    set_content(db, question, payload["options"], payload["correct"])
    db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question), changed_by=user_id))
    return question.question_code


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


def _check_row_selection(job: ImportJob, payload: dict) -> None:
    """A validated question row must carry the job's saved training and test type, or it is not applied."""
    if payload.get("training_id") != str(job.training_id) or payload.get("test_type") != job.test_type:
        raise ApiError(422, "SELECTION_MISMATCH", "This row was validated for a different training or test type. Validate the file again.")


def check_commit_selection(job: ImportJob, training_id: str | None, test_type: str | None) -> None:
    """When the page says which training and test type it is confirming, they must be the ones validated.

    The saved selection is always what is applied; this only refuses a confirmation made from a form that changed.
    """
    if job.import_type != ImportType.QUESTIONS:
        return
    changed = (training_id is not None and training_id != str(job.training_id)) or (test_type is not None and test_type != job.test_type)
    if changed:
        raise conflict("IMPORT_SELECTION_CHANGED", "The training or test type was changed after this file was validated. Validate the file again before importing.")


# Namespace of the two-key advisory lock taken while question imports into one training are confirmed.
QUESTION_IMPORT_LOCK = 0x7C_EE_02


def lock_training_imports(db: Session, training_id: uuid.UUID) -> None:
    """Confirmations into the same training run one after another, until the transaction ends, so two imports of the
    same file (or a double-click) cannot both pass the duplicate recheck. Other trainings are not held up."""
    key = int.from_bytes(training_id.bytes[:4], "big", signed=True)
    db.execute(text("SELECT pg_advisory_xact_lock(CAST(:space AS integer), CAST(:key AS integer))"), {"space": QUESTION_IMPORT_LOCK, "key": key})


def difficulty_notice(db: Session, job: ImportJob) -> str | None:
    """Imported questions are Easy. When the selected test's active configuration requires Medium or Hard questions
    that the pool does not have (counting this import's questions as Easy), say so: readiness will report the same
    shortfall and keep blocking until L&D changes difficulties in the Question Bank or the configured mix."""
    if job.import_type != ImportType.QUESTIONS or job.training_id is None or job.test_type is None:
        return None
    config = active_config(db, job.training_id, job.test_type)
    if config is None or not config.difficulty_mix:
        return None
    report = pool_report(db, job.training_id, config.question_count, config.difficulty_mix, assessment_type=job.test_type)
    available = dict(report["eligible_by_difficulty"])
    if job.status == ImportStatus.READY:
        available[qf.DEFAULT_DIFFICULTY] += sum(1 for r in job.rows if r.row_status == "VALID")
    short = [(level, config.difficulty_mix.get(level, 0), available[level]) for level in ("EASY", "MEDIUM", "HARD") if config.difficulty_mix.get(level, 0) > available[level]]
    if not short:
        return None
    test = TEST_TYPE_LABEL[job.test_type]
    needs = ", ".join(f"{wanted} {level.title()}" for level, wanted, _ in short)
    has = ", ".join(f"{have} {level.title()}" for level, _, have in short)
    after = "after this import" if job.status == ImportStatus.READY else "now"
    return (
        f"This training's {test} configuration requires {needs} questions; available {after}: {has}. "
        "Imported questions are Easy, so they do not count toward Medium or Hard. The assessment stays not ready until you change "
        "question difficulties in the Question Bank or adjust the difficulty mix in Assessment Configuration."
    )


def outdated_question_preview(job: ImportJob) -> bool:
    """A question preview validated with the old template (its rows carry a file-supplied ID, type and status)."""
    return job.import_type == ImportType.QUESTIONS and any(r.row_status == "VALID" and (not r.payload or r.payload.get("format") != qf.PAYLOAD_FORMAT) for r in job.rows)


def commit_job(db: Session, job: ImportJob, user_id: uuid.UUID) -> ImportJob:
    """Re-validates every row at commit time. Invalid and duplicate rows are never applied.

    Question rows use only the training and test type saved when the file was validated, never values sent now.
    """
    if job.status != ImportStatus.READY:
        raise ApiError(409, "IMPORT_ALREADY_PROCESSED", "This import has already been processed.")
    if job.import_type == ImportType.QUESTIONS:
        if job.test_type is None:
            # Validated before test types existed (or without one): importing it would make unclassified links.
            raise conflict("IMPORT_NEEDS_REVALIDATION", "This preview has no test type. Edit the import, choose the training and test type, and validate the file again.")
        if job.training is None:
            raise conflict("TRAINING_NOT_FOUND", "The training selected for this import no longer exists. Edit the import, choose a training, and validate the file again.")
        # The saved selection decides the link. Its conditions are checked again, as they may have changed.
        problem = training_import_problem(job.training)
        if problem:
            raise ApiError(409, problem.code, f"{problem.message} Cancel this preview and validate the file again.")
        if outdated_question_preview(job):
            raise conflict("IMPORT_NEEDS_REVALIDATION", "This preview was validated with an old question template. Edit the import and validate a file made from the new template before importing.")
        # Duplicates and conflicts are checked again, under the lock, against the pool as it is now.
        lock_training_imports(db, job.training.id)
        pool = qf.Pool(db, job.training.id, job.test_type)
        test_label = TEST_TYPE_LABEL[job.test_type]
        taken: set[str] = set()
    imported = 0
    for row in job.rows:
        if row.row_status != "VALID":
            continue
        savepoint = db.begin_nested()
        try:
            notes: list[dict[str, str]] = []
            if job.import_type == ImportType.QUESTIONS:
                _check_row_selection(job, row.payload)
                found = pool.match(row.payload, test_label)
                if found:
                    raise ApiError(409, "DUPLICATE" if found[0] == "DUPLICATE" else "QUESTION_CONFLICT", f"Rechecked when importing: {found[1]}")
                code = _commit_question(db, row.payload, user_id, job.training, job.test_type, taken)
                pool.add(row.payload, code)
                row.record_label = f"{code} · {row.record_label or ''}"[:200]
                notes = list(row.errors or [])  # A note about the other test type's pool stays with the row.
            else:
                notes = _commit_completion(db, row.payload, user_id, job.id)
            savepoint.commit()
            row.row_status = "IMPORTED"
            row.errors = notes
            imported += 1
        except ApiError as exc:
            savepoint.rollback()
            row.row_status = "DUPLICATE" if exc.status == 409 and exc.code in ("DUPLICATE", "COMPLETION_EXISTS") else "CONFLICT" if exc.code == "QUESTION_CONFLICT" else "INVALID"
            row.errors = [_error("question" if job.import_type == ImportType.QUESTIONS else "record", exc.message)]
        except IntegrityError:
            savepoint.rollback()
            if job.import_type == ImportType.QUESTIONS:
                row.row_status = "INVALID"
                row.errors = [_error("record", "This question could not be saved because of a conflicting record. Nothing was changed; validate the file again.")]
            else:
                # A completion or source event ID recorded by a concurrent request or another import.
                row.row_status = "DUPLICATE"
                row.errors = [_error("record", "This completion or source event ID already exists. The row was skipped.")]
    job.accepted_rows = imported
    job.rejected_rows = job.total_rows - imported
    job.status = ImportStatus.COMPLETED if job.rejected_rows == 0 else ImportStatus.COMPLETED_WITH_ERRORS
    job.completed_at = utcnow()
    db.flush()
    return job
