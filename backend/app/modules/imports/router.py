"""Import Centre APIs for L&D."""
import csv
import io
import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import Response
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin
from app.core.enums import ImportStatus, ImportType
from app.core.errors import conflict, not_found
from app.core.ratelimit import expensive
from app.core.responses import iso, ok
from app.models import ImportJob, Training
from app.modules.imports import parsing, service

router = APIRouter(prefix="/admin/imports", tags=["Import Centre"])

XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def training_ref(training: Training) -> dict:
    return {"id": str(training.id), "code": training.training_code, "title": training.title, "status": training.status}


def resolved_trainings(db: Session, job: ImportJob) -> list[dict]:
    """The trainings that accepted question rows link to, so every import shows where its questions go."""
    if job.training is not None:
        return [training_ref(job.training)]
    ids = {r.payload["training_id"] for r in job.rows if r.row_status in ("VALID", "IMPORTED") and r.payload and r.payload.get("training_id")}
    if job.import_type != ImportType.QUESTIONS or not ids:
        return []
    trainings = db.scalars(select(Training).where(Training.id.in_([uuid.UUID(i) for i in ids])).order_by(Training.title)).all()
    return [training_ref(t) for t in trainings]


def job_view(job: ImportJob, with_rows: bool = True, db: Session | None = None) -> dict:
    data = {
        "id": str(job.id),
        "import_type": job.import_type,
        "file_name": job.file_name,
        "status": job.status,
        "total_rows": job.total_rows,
        "accepted_rows": job.accepted_rows,
        "rejected_rows": job.rejected_rows,
        "created_at": iso(job.created_at),
        "completed_at": iso(job.completed_at),
        # The training selected in the Import Centre; None for completion and file-based question imports.
        "training": training_ref(job.training) if job.training else None,
    }
    if with_rows:
        data["trainings"] = resolved_trainings(db, job) if db is not None else []
        data["rows"] = [{"row": r.row_number, "record": r.record_label, "status": r.row_status, "errors": r.errors} for r in job.rows]
        # Notes on accepted rows. Before commit they say what will happen; after commit, what did.
        accepted = [r for r in job.rows if r.row_status in ("VALID", "IMPORTED")]
        data["assessments_not_scheduled"] = sum(1 for r in accepted if any(e["field"] == "assessment" for e in r.errors))
        data["assignments_created"] = sum(1 for r in accepted if any(e["field"] == "assignment" for e in r.errors))
    return data


@router.get("")
def list_jobs(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    jobs = db.scalars(select(ImportJob).options(selectinload(ImportJob.training)).order_by(ImportJob.created_at.desc()).limit(50)).all()
    return ok([job_view(j, with_rows=False) for j in jobs])


@router.get("/templates/{import_type}")
def template(import_type: ImportType, format: str = "csv", _: CurrentUser = Depends(require_admin)) -> Response:
    rows = service.TEMPLATES[import_type]
    name = f"traincheck-{import_type.lower()}-template"
    if format == "xlsx":
        workbook = Workbook()
        sheet = workbook.active
        for row in rows:
            sheet.append(row)
        buffer = io.BytesIO()
        workbook.save(buffer)
        return Response(buffer.getvalue(), media_type=XLSX_TYPE, headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
    buffer = io.StringIO()
    csv.writer(buffer).writerows(rows)
    return Response("﻿" + buffer.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


@router.post("", dependencies=[expensive("import")])
async def upload(
    import_type: ImportType = Form(...),
    file: UploadFile = File(...),
    training_id: str | None = Form(default=None),
    user: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Validates and previews. Nothing is applied until the commit call.

    Question imports normally name one training (training_id): every question is linked to it. Without it,
    the file-based behaviour is kept for existing clients: each row names its training code.
    """
    training = service.selected_training(db, training_id)
    limit = get_settings().max_upload_bytes
    content = await file.read(limit + 1)
    rows = parsing.read_table(file.filename or "upload", content, limit)
    job = service.create_job(db, import_type, file.filename or "upload", rows, user.id, training)
    record_audit(db, user.id, "IMPORT_VALIDATED", "import_job", job.id, after={"type": import_type, "valid": job.accepted_rows, "rejected": job.rejected_rows, "training": training.training_code if training else None})
    db.commit()
    db.refresh(job)
    return ok(job_view(job, db=db))


def _job(db: Session, job_id: uuid.UUID, lock: bool = False) -> ImportJob:
    """`lock=True` holds the job row until the request commits, so two commits, edits or deletes of the same
    import run one after the other and the second sees the first one's result."""
    if lock and db.execute(select(ImportJob.id).where(ImportJob.id == job_id).with_for_update()).first() is None:
        raise not_found()
    job = db.scalar(select(ImportJob).options(selectinload(ImportJob.rows)).where(ImportJob.id == job_id).execution_options(populate_existing=True))
    if job is None:
        raise not_found()
    return job


@router.get("/{job_id}")
def get_job(job_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(job_view(_job(db, job_id), db=db))


@router.post("/{job_id}/commit", dependencies=[expensive("import")])
def commit(job_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    job = _job(db, job_id, lock=True)
    service.commit_job(db, job, user.id)
    record_audit(db, user.id, "IMPORT_COMMITTED", "import_job", job.id, after={"imported": job.accepted_rows, "rejected": job.rejected_rows, "training": job.training.training_code if job.training else None})
    db.commit()
    db.refresh(job)
    return ok(job_view(job, db=db))


@router.post("/{job_id}/cancel")
def cancel(job_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    job = _job(db, job_id, lock=True)
    if job.status != ImportStatus.READY:
        raise conflict("IMPORT_ALREADY_PROCESSED", "This import has already been processed.")
    job.status = ImportStatus.CANCELLED
    record_audit(db, user.id, "IMPORT_CANCELLED", "import_job", job.id)
    db.commit()
    return ok({"cancelled": True})


@router.post("/{job_id}/replace", dependencies=[expensive("import")])
async def replace(
    job_id: uuid.UUID,
    file: UploadFile = File(...),
    training_id: str | None = Form(default=None),
    user: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Edits an import that was never applied: a corrected file (and training) is validated into the same entry."""
    job = _job(db, job_id, lock=True)
    if job.status not in service.UNAPPLIED_STATUSES:
        raise conflict("IMPORT_ALREADY_PROCESSED", "This import has already been imported and can no longer be edited.")
    training = service.selected_training(db, training_id)
    limit = get_settings().max_upload_bytes
    content = await file.read(limit + 1)
    rows = parsing.read_table(file.filename or "upload", content, limit)
    before = {"file": job.file_name, "training": job.training.training_code if job.training else None, "valid": job.accepted_rows, "rejected": job.rejected_rows}
    service.replace_job(db, job, file.filename or "upload", rows, user.id, training)
    record_audit(db, user.id, "IMPORT_EDITED", "import_job", job.id, before=before, after={"file": job.file_name, "training": training.training_code if training else None, "valid": job.accepted_rows, "rejected": job.rejected_rows})
    db.commit()
    db.refresh(job)
    return ok(job_view(job, db=db))


@router.delete("/{job_id}")
def delete(job_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    job = _job(db, job_id, lock=True)
    if job.status not in service.UNAPPLIED_STATUSES:
        raise conflict("IMPORT_ALREADY_PROCESSED", "A completed import is kept as the record of what it added and cannot be deleted.")
    record_audit(db, user.id, "IMPORT_DELETED", "import_job", job.id, before={"file": job.file_name, "type": job.import_type, "status": job.status, "rows": job.total_rows})
    db.delete(job)
    db.commit()
    return ok({"deleted": True})


@router.get("/{job_id}/error-report")
def error_report(job_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> Response:
    job = _job(db, job_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Row", "Record", "Status", "Field", "Problem"])
    for row in job.rows:
        for error in row.errors:
            writer.writerow([row.row_number, _safe(row.record_label or ""), row.row_status, error["field"], _safe(error["message"])])
    return Response("﻿" + buffer.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="traincheck-import-errors.csv"'})


def _safe(value: str) -> str:
    return "'" + value if value[:1] in ("=", "+", "-", "@") else value
