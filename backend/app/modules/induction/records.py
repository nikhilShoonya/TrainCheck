"""Records of one selected induction: Assessment Records and Feedback Form Records, their detail and exports.

Every query is scoped to the induction on the server (induction_id in the WHERE clause), never filtered in the
browser. Exports apply the same filters and sort to every matching record, not only the visible page, and reuse
the report renderers (CSV, XLSX, PDF), their formula sanitising and private file storage.
"""
import uuid
from dataclasses import dataclass
from datetime import datetime

from fastapi import Query
from sqlalchemy import Select, case, func, or_, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.display import display_datetime, filename_stamp
from app.core.enums import ExportFormat, InductionAssignmentStatus, InductionRecordKind, ResultStatus
from app.core.errors import not_found, validation
from app.core.responses import display_percent, iso
from app.models import (
    Department,
    Employee,
    InductionAssignment,
    InductionAttempt,
    InductionBatch,
    InductionExport,
    InductionFeedback,
    InductionProgramme,
)
from app.modules.induction import configuration
from app.modules.induction.common import MONTHS, STATUS_LABEL, batch_label, batch_view, get_batch
from app.modules.reports import exports
from app.modules.reports.catalogue import Report

PAGE_SIZES = (10, 20, 50, 100)
ASSESSMENT_STATE = {None: "Pending", "IN_PROGRESS": "In progress", "SUBMITTED": "Submitted", "TIMED_OUT": "Submitted (time expired)"}
RESULT_LABEL = {ResultStatus.PASSED: "Passed", ResultStatus.NOT_PASSED: "Not passed"}
ASSESSMENT_SORT = {"employee", "batch", "assigned_on", "assessment", "score", "feedback", "status", "department"}
FEEDBACK_SORT = {"employee", "batch", "submitted_on", "department", "version"}


@dataclass
class RecordFilters:
    q: str | None = None
    year: int | None = None
    month: int | None = None
    batch_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None
    status: str | None = None  # Assessment records: the induction status.
    result: str | None = None  # Assessment records: PASSED or NOT_PASSED.
    sort: str | None = None
    direction: str = "asc"

    def stored(self) -> dict:
        return {k: str(v) for k, v in self.__dict__.items() if v not in (None, "") and k not in ("sort", "direction")}


def record_filters(
    q: str | None = Query(default=None, max_length=120),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    batch_id: uuid.UUID | None = None,
    department_id: uuid.UUID | None = None,
    status: InductionAssignmentStatus | None = None,
    result: ResultStatus | None = None,
    sort: str | None = Query(default=None, max_length=30),
    direction: str = Query(default="asc", pattern="^(asc|desc)$"),
) -> RecordFilters:
    return RecordFilters(q=(q or "").strip() or None, year=year, month=month, batch_id=batch_id, department_id=department_id, status=status.value if status else None, result=result.value if result else None, sort=sort, direction=direction)


def parse_filters(raw: dict) -> RecordFilters:
    """Filters sent with an export request, checked like the query-string ones."""
    try:
        f = RecordFilters(
            q=(str(raw.get("q") or "").strip()[:120]) or None,
            year=int(raw["year"]) if raw.get("year") else None,
            month=int(raw["month"]) if raw.get("month") else None,
            batch_id=uuid.UUID(str(raw["batch_id"])) if raw.get("batch_id") else None,
            department_id=uuid.UUID(str(raw["department_id"])) if raw.get("department_id") else None,
            status=InductionAssignmentStatus(raw["status"]).value if raw.get("status") else None,
            result=ResultStatus(raw["result"]).value if raw.get("result") else None,
            sort=str(raw["sort"])[:30] if raw.get("sort") else None,
            direction="desc" if raw.get("direction") == "desc" else "asc",
        )
    except (ValueError, KeyError) as exc:
        raise validation("These filters are not valid. Reset the filters and try again.") from exc
    if f.year is not None and not 2000 <= f.year <= 2100 or f.month is not None and not 1 <= f.month <= 12:
        raise validation("These filters are not valid. Reset the filters and try again.")
    return f


def _check_batch(db: Session, induction: InductionProgramme, f: RecordFilters) -> None:
    if f.batch_id is not None:
        get_batch(db, induction, f.batch_id)  # A batch of another induction is a 404, never a silent empty list.


def _common_where(query: Select, induction_id: uuid.UUID, f: RecordFilters, batch, employee) -> Select:
    if f.q:
        like = f"%{f.q.lower()}%"
        query = query.where(or_(func.lower(employee.full_name).like(like), func.lower(employee.employee_code).like(like)))
    if f.year:
        query = query.where(batch.batch_year == f.year)
    if f.month:
        query = query.where(batch.batch_month == f.month)
    if f.batch_id:
        query = query.where(batch.id == f.batch_id)
    if f.department_id:
        query = query.where(employee.department_id == f.department_id)
    return query


# ---------- Assessment records ----------

def _assessment_query(induction_id: uuid.UUID, f: RecordFilters) -> Select:
    A, T, F = InductionAssignment, InductionAttempt, InductionFeedback
    query = (
        select(A, Employee, InductionBatch, T, F, Department)
        .join(Employee, Employee.id == A.employee_id)
        .join(InductionBatch, InductionBatch.id == A.batch_id)
        .outerjoin(Department, Department.id == Employee.department_id)
        .outerjoin(T, T.assignment_id == A.id)
        .outerjoin(F, F.assignment_id == A.id)
        .where(A.induction_id == induction_id)
    )
    query = _common_where(query, induction_id, f, InductionBatch, Employee)
    if f.status:
        query = query.where(A.status == f.status)
    if f.result:
        query = query.where(T.result_status == f.result)
    direction = (lambda c: c.desc().nulls_last()) if f.direction == "desc" else (lambda c: c.asc().nulls_last())
    columns = {
        "employee": [Employee.full_name],
        "department": [Department.name],
        "batch": [InductionBatch.batch_year, InductionBatch.batch_month, InductionBatch.batch_number],
        "assigned_on": [A.assigned_at],
        "assessment": [case((T.status.is_(None), 0), (T.status == "IN_PROGRESS", 1), else_=2)],
        "score": [T.score_percent],
        "feedback": [case((F.id.is_(None), 0), else_=1)],
        "status": [case((A.status == "ASSIGNED", 0), (A.status == "IN_PROGRESS", 1), (A.status == "FEEDBACK_PENDING", 2), else_=3)],
    }.get(f.sort if f.sort in ASSESSMENT_SORT else "employee", [Employee.full_name])
    # Stable: equal values always come out in the same order, so pages never repeat or skip a record.
    return query.order_by(*[direction(c) for c in columns], Employee.employee_code, A.id)


def _assessment_row(a, e, b, t, fb, d) -> dict:
    return {
        "assignment_id": str(a.id),
        "employee": {"id": str(e.id), "full_name": e.full_name, "employee_code": e.employee_code},
        "department": d.name if d else None,
        "batch": batch_view(b),
        "assigned_at": iso(a.assigned_at),
        "assessment_status": t.status if t else None,
        "assessment_label": ASSESSMENT_STATE.get(t.status if t else None, t.status if t else "Pending"),
        "started_at": iso(t.started_at) if t else None,
        "submitted_at": iso(t.submitted_at) if t else None,
        "score_percent": display_percent(t.score_percent) if t and t.score_percent is not None else None,
        "result_status": t.result_status if t else None,
        "feedback_status": "SUBMITTED" if fb else "PENDING",
        "feedback_submitted_at": iso(fb.submitted_at) if fb else None,
        "status": a.status,
        "status_label": STATUS_LABEL.get(a.status, a.status),
        "completed_at": iso(a.completed_at),
    }


def assessment_records(db: Session, induction: InductionProgramme, f: RecordFilters, page: int, page_size: int) -> dict:
    _check_batch(db, induction, f)
    query = _assessment_query(induction.id, f)
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    rows = db.execute(query.limit(page_size).offset((page - 1) * page_size)).all()
    return {"rows": [_assessment_row(*r) for r in rows], "total": total, "page": page, "page_size": page_size}


# ---------- Feedback records ----------

def _feedback_query(induction_id: uuid.UUID, f: RecordFilters) -> Select:
    F = InductionFeedback
    query = (
        select(F, Employee, InductionBatch, Department)
        .join(Employee, Employee.id == F.employee_id)
        .join(InductionBatch, InductionBatch.id == F.batch_id)
        .outerjoin(Department, Department.id == Employee.department_id)
        .where(F.induction_id == induction_id)
    )
    query = _common_where(query, induction_id, f, InductionBatch, Employee)
    direction = (lambda c: c.desc().nulls_last()) if f.direction == "desc" else (lambda c: c.asc().nulls_last())
    columns = {
        "employee": [Employee.full_name],
        "department": [Department.name],
        "batch": [InductionBatch.batch_year, InductionBatch.batch_month, InductionBatch.batch_number],
        "submitted_on": [F.submitted_at],
        "version": [F.form_version],
    }.get(f.sort if f.sort in FEEDBACK_SORT else "submitted_on", [F.submitted_at])
    return query.order_by(*[direction(c) for c in columns], Employee.employee_code, F.id)


def _answers(fb: InductionFeedback) -> list[dict]:
    questions = fb.form_snapshot.get("questions", [])
    return [
        {"key": q["key"], "section": q["section"], "question": q["text"], "control": q["control"], "value": fb.ratings.get(q["key"]), "answer": configuration.answer_label(q, fb.ratings.get(q["key"]))}
        for q in questions
    ]


def _feedback_row(fb, e, b, d) -> dict:
    values = [v for v in fb.ratings.values() if isinstance(v, int)]
    return {
        "feedback_id": str(fb.id),
        "assignment_id": str(fb.assignment_id),
        "employee": {"id": str(e.id), "full_name": e.full_name, "employee_code": e.employee_code},
        "department": d.name if d else None,
        "batch": batch_view(b),
        "submitted_at": iso(fb.submitted_at),
        "form_version": fb.form_version,
        "answered": len(values),
        "average_rating": round(sum(values) / len(values), 2) if values else None,
        "has_comment": bool(fb.comment_text),
        "answers": _answers(fb),
        "comment": fb.comment_text,
        "comment_label": fb.form_snapshot.get("comment_label"),
    }


def feedback_records(db: Session, induction: InductionProgramme, f: RecordFilters, page: int, page_size: int) -> dict:
    _check_batch(db, induction, f)
    query = _feedback_query(induction.id, f)
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    rows = db.execute(query.limit(page_size).offset((page - 1) * page_size)).all()
    return {"rows": [_feedback_row(*r) for r in rows], "total": total, "page": page, "page_size": page_size}


# ---------- One record ----------

def record_detail(db: Session, induction: InductionProgramme, assignment: InductionAssignment) -> dict:
    from app.modules.induction.engine import result_facts

    attempt = db.scalar(select(InductionAttempt).where(InductionAttempt.assignment_id == assignment.id))
    fb = db.scalar(select(InductionFeedback).where(InductionFeedback.assignment_id == assignment.id))
    e = assignment.employee
    return {
        "assignment_id": str(assignment.id),
        "induction": {"id": str(induction.id), "name": induction.name},
        "employee": {"id": str(e.id), "full_name": e.full_name, "employee_code": e.employee_code, "work_email": e.work_email, "department": e.department.name if e.department else None, "joining_date": e.joining_date.isoformat() if e.joining_date else None},
        "batch": batch_view(assignment.batch),
        "status": assignment.status,
        "status_label": STATUS_LABEL.get(assignment.status, assignment.status),
        "assigned_at": iso(assignment.assigned_at),
        "completed_at": iso(assignment.completed_at),
        # Answer review is not enabled for induction, so the detail shows the outcome, not the answers.
        "assessment": result_facts(db, attempt) if attempt and attempt.submitted_at else ({"attempt_status": attempt.status, "started_at": iso(attempt.started_at), "expires_at": iso(attempt.expires_at)} if attempt else None),
        "feedback": {"submitted_at": iso(fb.submitted_at), "form_version": fb.form_version, "answers": _answers(fb), "comment": fb.comment_text, "comment_label": fb.form_snapshot.get("comment_label")} if fb else None,
    }


# ---------- Exports ----------

def _readable_filters(db: Session, induction: InductionProgramme, f: RecordFilters) -> dict:
    out: dict[str, str] = {}
    if f.q:
        out["search"] = f.q
    if f.year:
        out["year"] = str(f.year)
    if f.month:
        out["month"] = MONTHS[f.month - 1]
    if f.batch_id:
        out["batch"] = batch_label(get_batch(db, induction, f.batch_id))
    if f.department_id:
        department = db.get(Department, f.department_id)
        out["department"] = department.name if department else str(f.department_id)
    if f.status:
        out["status"] = STATUS_LABEL.get(f.status, f.status)
    if f.result:
        out["result"] = RESULT_LABEL.get(f.result, f.result)
    if f.sort:
        out["sort"] = f"{f.sort} {f.direction}"
    return out


def _when(value: datetime | None) -> str:
    return display_datetime(value) if value else ""


def assessment_report(db: Session, induction: InductionProgramme, f: RecordFilters) -> Report:
    rows = db.execute(_assessment_query(induction.id, f)).all()
    report = Report(
        code="INDUCTION_ASSESSMENT",
        title=f"{induction.name} · Induction Assessment Records",
        description="One row per assigned employee. Score and pass/fail are separate from induction completion.",
        columns=["Employee ID", "Employee", "Department", "Batch", "Assigned on", "Assessment", "Started on", "Submitted on", "Score %", "Result", "Feedback", "Feedback submitted on", "Induction status", "Completed on"],
    )
    for a, e, b, t, fb, d in rows:
        report.rows.append(
            [
                e.employee_code,
                e.full_name,
                d.name if d else "",
                batch_label(b),
                _when(a.assigned_at),
                ASSESSMENT_STATE.get(t.status if t else None, t.status if t else "Pending"),
                _when(t.started_at) if t else "",
                _when(t.submitted_at) if t else "",
                display_percent(t.score_percent) if t and t.score_percent is not None else "",
                RESULT_LABEL.get(t.result_status, "") if t else "",
                "Submitted" if fb else "Pending",
                _when(fb.submitted_at) if fb else "",
                STATUS_LABEL.get(a.status, a.status),
                _when(a.completed_at),
            ]
        )
    report.definitions = ["Induction status: Assigned → In progress → Feedback pending (assessment submitted) → Completed (feedback submitted). Completion does not imply a pass.", "Score % is truncated, never rounded up."]
    return report


def feedback_report(db: Session, induction: InductionProgramme, f: RecordFilters) -> Report:
    rows = db.execute(_feedback_query(induction.id, f)).all()
    # One column per question, labelled with its form version, so answers given on different versions never share a
    # column whose wording changed.
    columns: list[tuple[int, str, str]] = []
    seen: set[tuple[int, str]] = set()
    for fb, *_ in rows:
        for q in fb.form_snapshot.get("questions", []):
            if (fb.form_version, q["key"]) not in seen:
                seen.add((fb.form_version, q["key"]))
                columns.append((fb.form_version, q["key"], q["text"]))
    report = Report(
        code="INDUCTION_FEEDBACK",
        title=f"{induction.name} · Induction Feedback Form Records",
        description="Every submitted induction feedback form with its full answers.",
        columns=["Employee ID", "Employee", "Department", "Batch", "Submitted on", "Form version"] + [f"v{v}: {text}" for v, _, text in columns] + ["Comment"],
    )
    for fb, e, b, d in rows:
        by_key = {q["key"]: q for q in fb.form_snapshot.get("questions", [])}
        answers = [configuration.answer_label(by_key[key], fb.ratings.get(key)) if v == fb.form_version and key in by_key else "" for v, key, _ in columns]
        report.rows.append([e.employee_code, e.full_name, d.name if d else "", batch_label(b), _when(fb.submitted_at), f"v{fb.form_version}", *answers, fb.comment_text or ""])
    report.definitions = ["Ratings run from 1 (lowest) to 5 (highest). Answers keep the wording of the form version they were given on."]
    return report


def create_export(db: Session, induction: InductionProgramme, kind: InductionRecordKind, fmt: ExportFormat, f: RecordFilters, owner_id: uuid.UUID) -> InductionExport:
    _check_batch(db, induction, f)
    report = assessment_report(db, induction, f) if kind == InductionRecordKind.ASSESSMENT else feedback_report(db, induction, f)
    now = utcnow()
    readable = _readable_filters(db, induction, f)
    content = exports.RENDERERS[fmt](report, readable, now, f"Induction: {induction.name}")
    slug = "assessment-records" if kind == InductionRecordKind.ASSESSMENT else "feedback-records"
    file_name = f"traincheck-induction-{induction.induction_code.lower()}-{slug}-{filename_stamp(now)}.{fmt.value.lower()}"
    artifact = exports.store_file(db, owner_id, file_name, content, exports.CONTENT_TYPES[fmt], "INDUCTION_EXPORT")
    record = InductionExport(owner_user_id=owner_id, induction_id=induction.id, record_kind=kind, export_format=fmt, filters=f.stored(), row_count=len(report.rows), artifact_id=artifact.id, created_at=now)
    db.add(record)
    db.flush()
    record_audit(db, owner_id, "INDUCTION_RECORDS_EXPORTED", "induction_export", record.id, after={"induction_id": str(induction.id), "kind": kind.value, "format": fmt.value, "rows": len(report.rows), "filters": f.stored()})
    return record


def export_view(record: InductionExport) -> dict:
    return {
        "id": str(record.id),
        "record_kind": record.record_kind,
        "export_format": record.export_format,
        "filters": record.filters,
        "row_count": record.row_count,
        "file_name": record.artifact.file_name if record.artifact else None,
        "created_at": iso(record.created_at),
    }


def own_export(db: Session, induction: InductionProgramme, export_id: uuid.UUID, owner_id: uuid.UUID) -> InductionExport:
    record = db.get(InductionExport, export_id)
    if record is None or record.owner_user_id != owner_id or record.induction_id != induction.id:
        raise not_found()
    return record
