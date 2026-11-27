"""L&D Admin APIs for Induction. Every route requires the L&D Admin role (require_admin, which also applies the
assessment gate). Nested batch, assignment and export IDs are always checked against the induction in the path."""
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.audit import record_audit
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin
from app.core.enums import ExportFormat, InductionRecordKind, InductionStatus
from app.core.errors import not_found
from app.core.ratelimit import expensive
from app.core.responses import ok
from app.core.routing import ReleasingRoute
from app.models import InductionExport, InductionProgramme
from app.modules.imports import parsing
from app.modules.induction import configuration, programmes, records
from app.modules.induction.common import batch_view, get_batch, get_induction
from app.modules.organisation import people
from app.modules.organisation.router import EmployeeIn, _not_ready, _read_people_rows, _single_candidate, _single_problems
from app.modules.reports import exports

router = APIRouter(route_class=ReleasingRoute, prefix="/admin", tags=["Induction (L&D)"])


# ---------- Common configuration (main Induction page) ----------

def _overview(db: Session) -> dict:
    return {
        "readiness": configuration.readiness(db),
        "settings": configuration.settings_view(configuration.current_settings(db)),
        "feedback_form": configuration.form_view(configuration.current_form(db)),
    }


@router.get("/induction/overview")
def overview(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(_overview(db))


@router.put("/induction/assessment/settings")
def save_settings(body: configuration.SettingsIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    configuration.save_settings(db, body, user.id)
    db.commit()
    return ok(_overview(db))


@router.get("/induction/questions")
def list_questions(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok({"questions": [configuration.question_view(q) for q in configuration.all_questions(db)], "readiness": configuration.readiness(db)})


@router.post("/induction/questions")
def create_question(body: configuration.QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    q = configuration.create_question(db, body, user.id)
    db.commit()
    db.refresh(q)
    return ok(configuration.question_view(q))


@router.patch("/induction/questions/{question_id}")
def update_question(question_id: uuid.UUID, body: configuration.QuestionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    q = configuration.update_question(db, question_id, body, user.id)
    db.commit()
    db.refresh(q)
    return ok(configuration.question_view(q))


class MoveIn(BaseModel):
    direction: Literal["up", "down"]


@router.post("/induction/questions/{question_id}/move")
def move_question(question_id: uuid.UUID, body: MoveIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    configuration.move_question(db, question_id, body.direction, user.id)
    db.commit()
    return ok({"moved": True})


def _question_rows(file: UploadFile) -> list[list[str]]:
    from app.core.config import get_settings

    limit = get_settings().max_upload_bytes
    content = file.file.read(limit + 1)
    return parsing.read_table(file.filename or "upload", content, limit, allow_pdf=True)


@router.post("/induction/questions/import/preview", dependencies=[expensive("import")])
def preview_question_import(file: UploadFile = File(...), _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Validates only: nothing is saved."""
    rows = _question_rows(file)
    result = configuration.preview_question_rows(db, rows)
    db.rollback()
    return ok({"file_name": file.filename, **configuration._public_preview(result)})


@router.post("/induction/questions/import", dependencies=[expensive("import")])
def confirm_question_import(file: UploadFile = File(...), user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Validated again under the paper lock; VALID rows are added, the rest are skipped and reported."""
    rows = _question_rows(file)
    result, created = configuration.import_question_rows(db, rows, user.id)
    record_audit(db, user.id, "INDUCTION_QUESTIONS_IMPORTED", "induction_question_import", None, after={"file_name": (file.filename or "")[:255], "created": len(created)})
    db.commit()
    return ok({"file_name": file.filename, "created": len(created), **result})


@router.get("/induction/feedback-form")
def get_form(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(_overview(db))


@router.put("/induction/feedback-form")
def save_form(body: configuration.FeedbackFormIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    configuration.save_form(db, body, user.id)
    db.commit()
    return ok(_overview(db))


# ---------- Induction cards ----------

def _induction(db: Session, induction_id: uuid.UUID, lock: bool = False) -> InductionProgramme:
    return get_induction(db, induction_id, lock)


@router.get("/inductions")
def list_inductions(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(programmes.list_inductions(db))


@router.post("/inductions")
def create_induction(body: programmes.InductionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = programmes.create_induction(db, body, user.id)
    db.commit()
    return ok(programmes.detail(db, _induction(db, induction.id)))


@router.get("/inductions/{induction_id}")
def get_detail(induction_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(programmes.detail(db, _induction(db, induction_id)))


@router.patch("/inductions/{induction_id}")
def update_induction(induction_id: uuid.UUID, body: programmes.InductionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = programmes.update_induction(db, _induction(db, induction_id, lock=True), body, user.id)
    db.commit()
    return ok(programmes.detail(db, _induction(db, induction.id)))


class StatusIn(BaseModel):
    status: InductionStatus


@router.post("/inductions/{induction_id}/status")
def set_status(induction_id: uuid.UUID, body: StatusIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    programmes.set_status(db, _induction(db, induction_id, lock=True), body.status, user.id)
    db.commit()
    return ok(programmes.detail(db, _induction(db, induction_id)))


@router.get("/inductions/{induction_id}/batches")
def list_batches(induction_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(programmes.list_batches(db, _induction(db, induction_id)))


@router.post("/inductions/{induction_id}/batches")
def create_batch(induction_id: uuid.UUID, body: programmes.BatchIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    batch = programmes.create_batch(db, _induction(db, induction_id, lock=True), body, user.id)
    db.commit()
    return ok(batch_view(batch))


@router.patch("/inductions/{induction_id}/batches/{batch_id}")
def update_batch(induction_id: uuid.UUID, batch_id: uuid.UUID, body: programmes.BatchUpdateIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id)
    batch = programmes.update_batch(db, get_batch(db, induction, batch_id), body, user.id)
    db.commit()
    return ok(batch_view(batch))


@router.get("/inductions/{induction_id}/members")
def list_members(induction_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(programmes.list_members(db, _induction(db, induction_id)))


@router.get("/inductions/{induction_id}/batches/{batch_id}/eligible")
def eligible(induction_id: uuid.UUID, batch_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id)
    return ok(programmes.eligible(db, induction, get_batch(db, induction, batch_id)))


@router.post("/inductions/{induction_id}/assignments", dependencies=[expensive("bulk")])
def assign(induction_id: uuid.UUID, body: programmes.AssignIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id, lock=True)  # One assignment request per induction at a time.
    result = programmes.assign(db, induction, get_batch(db, induction, body.batch_id), body, user.id)
    db.commit()
    return ok(result)


# ---------- Add employees into a batch (the existing single form and file import) ----------

def _department_problem(induction: InductionProgramme, department, field: str) -> dict | None:
    if department is not None and department.id != induction.department_id:
        return {"field": field, "message": f"{induction.name} is for the {induction.department.name} department. Choose {induction.department.name}, or add this employee from Employee Assignments."}
    return None


@router.post("/inductions/{induction_id}/batches/{batch_id}/employees", dependencies=[expensive("import")])
def add_employee(induction_id: uuid.UUID, batch_id: uuid.UUID, body: EmployeeIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """The existing New Employee form, with the batch chosen. The employee and their batch place are saved together.
    No assessment is assigned: that stays an explicit Assign Employees step."""
    induction = _induction(db, induction_id)
    programmes.require_active(induction)
    batch = get_batch(db, induction, batch_id)

    def check():
        person = _single_candidate(db, body)
        problem = _department_problem(induction, person.department, "department_id")
        if problem:
            person.errors.append(problem)
        return person

    person = check()
    db.rollback()  # Releases the connection while the password is hashed.
    if person.errors:
        raise _single_problems(person)
    hashes = people.password_hashes([person])
    people.lock_for_create(db)
    induction = _induction(db, induction_id, lock=True)
    batch = get_batch(db, induction, batch_id)
    person = check()  # Checked again under the lock.
    if person.errors:
        db.rollback()
        raise _single_problems(person)
    [employee] = people.create(db, [person], hashes, user.id, "SINGLE")
    programmes.add_members(db, induction, batch, [employee], user.id)
    db.commit()
    return ok({"created": 1, "batch": batch_view(batch), "employee": {"id": str(employee.id), "employee_code": employee.employee_code, "full_name": employee.full_name, "department": person.department.name}})


def _batch_file(db: Session, induction: InductionProgramme, rows: list[list[str]]) -> list:
    checked = people.validate_file(db, people.candidates_from_rows(rows))
    for person in checked:
        problem = _department_problem(induction, person.department, people.FILE_LABELS["department"])
        if problem:
            person.errors.append(problem)
    return checked


@router.post("/inductions/{induction_id}/batches/{batch_id}/employees/import/preview", dependencies=[expensive("import")])
def preview_batch_import(induction_id: uuid.UUID, batch_id: uuid.UUID, file: UploadFile = File(...), _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """The existing employee file check, plus: every row's department must be the induction's. Saves nothing."""
    induction = _induction(db, induction_id)
    batch = get_batch(db, induction, batch_id)
    name, rows = _read_people_rows(file)
    result = people.preview(_batch_file(db, induction, rows))
    view = batch_view(batch)
    db.rollback()
    return ok({"file_name": name, "batch": view, **result})


@router.post("/inductions/{induction_id}/batches/{batch_id}/employees/import", dependencies=[expensive("import")])
def confirm_batch_import(induction_id: uuid.UUID, batch_id: uuid.UUID, file: UploadFile = File(...), user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """The whole file or nothing, as for every employee import: the employees and their batch places are saved in one
    transaction, validated again under the creation lock. A repeated confirmation adds no one twice."""
    induction = _induction(db, induction_id)
    programmes.require_active(induction)
    get_batch(db, induction, batch_id)
    name, rows = _read_people_rows(file)
    checked = _batch_file(db, induction, rows)
    db.rollback()
    result = {"file_name": name, **people.preview(checked)}
    if not result["ready"]:
        raise _not_ready(result)
    hashes = people.password_hashes(checked)
    people.lock_for_create(db)
    induction = _induction(db, induction_id, lock=True)
    batch = get_batch(db, induction, batch_id)
    checked = _batch_file(db, induction, rows)
    result = {"file_name": name, **people.preview(checked)}
    if not result["ready"]:
        db.rollback()
        raise _not_ready(result)
    created = people.create(db, checked, hashes, user.id, "BULK_IMPORT")
    programmes.add_members(db, induction, batch, created, user.id)
    record_audit(db, user.id, "EMPLOYEES_IMPORTED", "employee_import", None, after={"file_name": name[:255], "created": len(created), "induction_batch_id": str(batch.id)})
    db.commit()
    return ok({"file_name": name, "created": len(created), "batch": batch_view(batch), "employees": [{"id": str(e.id), "employee_code": e.employee_code, "full_name": e.full_name} for e in created]})


# ---------- Records (inside the selected induction) ----------

def _page(page: int = Query(default=1, ge=1, le=100000), page_size: int = Query(default=20)) -> tuple[int, int]:
    return page, page_size if page_size in records.PAGE_SIZES else 20


@router.get("/inductions/{induction_id}/records/assessment", dependencies=[expensive("report")])
def assessment_records(induction_id: uuid.UUID, f: records.RecordFilters = Depends(records.record_filters), paging: tuple[int, int] = Depends(_page), _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(records.assessment_records(db, _induction(db, induction_id), f, *paging))


@router.get("/inductions/{induction_id}/records/feedback", dependencies=[expensive("report")])
def feedback_records(induction_id: uuid.UUID, f: records.RecordFilters = Depends(records.record_filters), paging: tuple[int, int] = Depends(_page), _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(records.feedback_records(db, _induction(db, induction_id), f, *paging))


@router.get("/inductions/{induction_id}/records/assignments/{assignment_id}")
def record_detail(induction_id: uuid.UUID, assignment_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id)
    return ok(records.record_detail(db, induction, programmes.get_assignment(db, induction, assignment_id)))


class ExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_kind: InductionRecordKind
    export_format: ExportFormat
    filters: dict[str, str | int | None] = Field(default_factory=dict, max_length=20)


@router.post("/inductions/{induction_id}/exports", dependencies=[expensive("export")])
def create_export(induction_id: uuid.UUID, body: ExportIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id)
    record = records.create_export(db, induction, body.record_kind, body.export_format, records.parse_filters(body.filters), user.id)
    db.commit()
    db.refresh(record)
    return ok(records.export_view(record))


@router.get("/inductions/{induction_id}/exports")
def list_exports(induction_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    induction = _induction(db, induction_id)
    rows = db.scalars(
        select(InductionExport).options(joinedload(InductionExport.artifact)).where(InductionExport.owner_user_id == user.id, InductionExport.induction_id == induction.id).order_by(InductionExport.created_at.desc()).limit(50)
    ).all()
    return ok([records.export_view(r) for r in rows])


@router.get("/inductions/{induction_id}/exports/{export_id}/download")
def download_export(induction_id: uuid.UUID, export_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> Response:
    """Owner only, and only through the induction it was made for. The admin role is checked again on every download."""
    record = records.own_export(db, _induction(db, induction_id), export_id, user.id)
    artifact = record.artifact
    if artifact is None:
        raise not_found("This export file is no longer available. Export the records again.")
    try:
        content = exports.read_file(artifact)
    except FileNotFoundError as exc:
        raise not_found("This export file is no longer available. Export the records again.") from exc
    return Response(content, media_type=artifact.content_type, headers={"Content-Disposition": f'attachment; filename="{artifact.file_name}"', "Cache-Control": "no-store"})


@router.delete("/inductions/{induction_id}/exports/{export_id}")
def delete_export(induction_id: uuid.UUID, export_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Removes a generated file from Downloads. The records themselves are untouched and can be exported again."""
    record = records.own_export(db, _induction(db, induction_id), export_id, user.id)
    artifact = record.artifact
    storage_key = artifact.storage_key if artifact else None
    db.delete(record)
    if artifact is not None:
        db.delete(artifact)
    db.commit()
    if storage_key:
        exports.remove_file(storage_key)
    return ok({"deleted": True})
