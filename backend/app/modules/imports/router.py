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
from app.models import ImportJob
from app.modules.imports import parsing, service

router = APIRouter(prefix="/admin/imports", tags=["Import Centre"])

XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def job_view(job: ImportJob, with_rows: bool = True) -> dict:
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
    }
    if with_rows:
        data["rows"] = [{"row": r.row_number, "record": r.record_label, "status": r.row_status, "errors": r.errors} for r in job.rows]
        # Notes on accepted rows. Before commit they say what will happen; after commit, what did.
        accepted = [r for r in job.rows if r.row_status in ("VALID", "IMPORTED")]
        data["assessments_not_scheduled"] = sum(1 for r in accepted if any(e["field"] == "assessment" for e in r.errors))
        data["assignments_created"] = sum(1 for r in accepted if any(e["field"] == "assignment" for e in r.errors))
    return data


@router.get("")
def list_jobs(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    jobs = db.scalars(select(ImportJob).order_by(ImportJob.created_at.desc()).limit(50)).all()
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
async def upload(import_type: ImportType = Form(...), file: UploadFile = File(...), user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Validates and previews. Nothing is applied until the commit call."""
    limit = get_settings().max_upload_bytes
    content = await file.read(limit + 1)
    rows = parsing.read_table(file.filename or "upload", content, limit)
    job = service.create_job(db, import_type, file.filename or "upload", rows, user.id)
    record_audit(db, user.id, "IMPORT_VALIDATED", "import_job", job.id, after={"type": import_type, "valid": job.accepted_rows, "rejected": job.rejected_rows})
    db.commit()
    db.refresh(job)
    return ok(job_view(job))


def _job(db: Session, job_id: uuid.UUID) -> ImportJob:
    job = db.scalar(select(ImportJob).options(selectinload(ImportJob.rows)).where(ImportJob.id == job_id))
    if job is None:
        raise not_found()
    return job


@router.get("/{job_id}")
def get_job(job_id: uuid.UUID, _: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(job_view(_job(db, job_id)))


@router.post("/{job_id}/commit", dependencies=[expensive("import")])
def commit(job_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    job = _job(db, job_id)
    service.commit_job(db, job, user.id)
    record_audit(db, user.id, "IMPORT_COMMITTED", "import_job", job.id, after={"imported": job.accepted_rows, "rejected": job.rejected_rows})
    db.commit()
    db.refresh(job)
    return ok(job_view(job))


@router.post("/{job_id}/cancel")
def cancel(job_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    job = _job(db, job_id)
    if job.status != ImportStatus.READY:
        raise conflict("IMPORT_ALREADY_PROCESSED", "This import has already been processed.")
    job.status = ImportStatus.CANCELLED
    record_audit(db, user.id, "IMPORT_CANCELLED", "import_job", job.id)
    db.commit()
    return ok({"cancelled": True})


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
