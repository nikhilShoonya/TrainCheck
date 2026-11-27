"""Small shared pieces of the Induction module: labels, locks and lookups."""
import uuid

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.enums import InductionAssignmentStatus
from app.core.errors import not_found
from app.models import InductionBatch, InductionProgramme

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

STATUS_LABEL = {
    InductionAssignmentStatus.ASSIGNED: "Assigned",
    InductionAssignmentStatus.IN_PROGRESS: "In progress",
    InductionAssignmentStatus.FEEDBACK_PENDING: "Feedback pending",
    InductionAssignmentStatus.COMPLETED: "Completed",
}

# Advisory lock keys (pg_advisory_xact_lock): versions of the common configuration are numbered one at a time.
SETTINGS_LOCK = 7_420_001
FORM_LOCK = 7_420_002
QUESTIONS_LOCK = 7_420_003


def advisory_lock(db: Session, key: int) -> None:
    """Held until the transaction ends. A no-op on databases without advisory locks."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})


def month_label(year: int, month: int) -> str:
    return f"{MONTHS[month - 1]} {year}"


def batch_label(batch: InductionBatch) -> str:
    """"November 2026 · Batch 1", with the optional name after it."""
    label = f"{month_label(batch.batch_year, batch.batch_month)} · Batch {batch.batch_number}"
    return f"{label} · {batch.name}" if batch.name else label


def batch_view(batch: InductionBatch) -> dict:
    return {
        "id": str(batch.id),
        "label": batch_label(batch),
        "year": batch.batch_year,
        "month": batch.batch_month,
        "batch_number": batch.batch_number,
        "name": batch.name,
        "start_date": batch.start_date.isoformat() if batch.start_date else None,
    }


def get_induction(db: Session, induction_id: uuid.UUID, lock: bool = False) -> InductionProgramme:
    query = select(InductionProgramme).where(InductionProgramme.id == induction_id)
    if lock:
        query = query.with_for_update()
    induction = db.scalar(query)
    if induction is None:
        raise not_found("This induction does not exist.")
    return induction


def get_batch(db: Session, induction: InductionProgramme, batch_id: uuid.UUID) -> InductionBatch:
    """A batch of this induction only: an ID from another induction is treated as missing."""
    batch = db.get(InductionBatch, batch_id)
    if batch is None or batch.induction_id != induction.id:
        raise not_found("This batch does not exist in this induction.")
    return batch
