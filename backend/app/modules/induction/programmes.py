"""Induction cards, their monthly batches, batch members and assignments.

Every card belongs to one department. Only active employees of that department can join its batches or be
assigned, checked here on the server for single, selected and whole-batch requests alike. An employee has at most
one assignment in the whole module (unique employee_id), so another card, month or batch can never add a second one.
"""
import secrets
import uuid
from datetime import date

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.enums import EmploymentStatus, InductionAssignmentStatus, InductionStatus
from app.core.errors import ApiError, conflict, not_found, validation
from app.core.responses import iso
from app.models import (
    Department,
    Employee,
    InductionAssignment,
    InductionAttempt,
    InductionBatch,
    InductionBatchMember,
    InductionProgramme,
    Trainer,
)
from app.modules.induction.common import STATUS_LABEL, batch_label, batch_view
from app.modules.organisation.people import is_learner

MAX_ASSIGN = 2000


# ---------- Induction cards ----------

class InductionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=2, max_length=200)
    category: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    department_id: uuid.UUID
    trainer_id: uuid.UUID | None = None


def _check_links(db: Session, body: InductionIn) -> Department:
    department = db.get(Department, body.department_id)
    if department is None:
        raise validation("Choose a department.", [{"field": "department_id", "message": "This department does not exist."}])
    if not department.is_active:
        raise validation("Choose an active department.", [{"field": "department_id", "message": "This department is inactive."}])
    if body.trainer_id is not None:
        trainer = db.get(Trainer, body.trainer_id)
        if trainer is None or not trainer.is_active:
            raise validation("Choose an active trainer, or leave Trainer empty.", [{"field": "trainer_id", "message": "This trainer is not available."}])
    return department


def create_induction(db: Session, body: InductionIn, actor_id: uuid.UUID) -> InductionProgramme:
    _check_links(db, body)
    for _ in range(5):
        code = f"IND-{secrets.token_hex(3).upper()}"
        if db.scalar(select(InductionProgramme.id).where(InductionProgramme.induction_code == code)) is None:
            break
    else:
        raise ApiError(500, "CODE_GENERATION_FAILED", "An induction code could not be generated. Try again.")
    induction = InductionProgramme(
        induction_code=code,
        name=body.name,
        category=body.category or None,
        description=body.description or None,
        department_id=body.department_id,
        trainer_id=body.trainer_id,
        status=InductionStatus.ACTIVE,
        created_by=actor_id,
    )
    db.add(induction)
    db.flush()
    record_audit(db, actor_id, "INDUCTION_CREATED", "induction_programme", induction.id, after={"code": code, "name": body.name, "department_id": str(body.department_id)})
    return induction


def update_induction(db: Session, induction: InductionProgramme, body: InductionIn, actor_id: uuid.UUID) -> InductionProgramme:
    """Details only. The department cannot change once anyone joined a batch: their eligibility was checked against it."""
    _check_links(db, body)
    if body.department_id != induction.department_id and db.scalar(select(InductionBatchMember.id).where(InductionBatchMember.induction_id == induction.id).limit(1)) is not None:
        raise conflict("IN_USE", "The department cannot be changed because employees have already joined this induction's batches. Create a new induction for another department.")
    before = {"name": induction.name, "department_id": str(induction.department_id)}
    induction.name = body.name
    induction.category = body.category or None
    induction.description = body.description or None
    induction.department_id = body.department_id
    induction.trainer_id = body.trainer_id
    db.flush()
    record_audit(db, actor_id, "INDUCTION_UPDATED", "induction_programme", induction.id, before=before, after={"name": induction.name, "department_id": str(induction.department_id)})
    return induction


def set_status(db: Session, induction: InductionProgramme, status: InductionStatus, actor_id: uuid.UUID) -> None:
    before = induction.status
    induction.status = status
    db.flush()
    record_audit(db, actor_id, "INDUCTION_STATUS_CHANGED", "induction_programme", induction.id, before={"status": before}, after={"status": status.value})


def _counts(db: Session, induction_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    A = InductionAssignment
    rows = db.execute(
        select(
            A.induction_id,
            func.count(A.id),
            func.count(case((A.status == InductionAssignmentStatus.COMPLETED, 1))),
            func.count(A.assessment_submitted_at),
        )
        .where(A.induction_id.in_(induction_ids))
        .group_by(A.induction_id)
    ).all()
    out = {i: {"assigned": 0, "completed": 0, "assessment_submitted": 0} for i in induction_ids}
    for induction_id, assigned, completed, submitted in rows:
        out[induction_id] = {"assigned": assigned, "completed": completed, "assessment_submitted": submitted}
    batches = dict(db.execute(select(InductionBatch.induction_id, func.count(InductionBatch.id)).where(InductionBatch.induction_id.in_(induction_ids)).group_by(InductionBatch.induction_id)).all())
    members = dict(db.execute(select(InductionBatchMember.induction_id, func.count(InductionBatchMember.id)).where(InductionBatchMember.induction_id.in_(induction_ids)).group_by(InductionBatchMember.induction_id)).all())
    for induction_id, counts in out.items():
        counts["pending"] = counts["assigned"] - counts["completed"]
        counts["batches"] = batches.get(induction_id, 0)
        counts["members"] = members.get(induction_id, 0)
    return out


def induction_view(induction: InductionProgramme, counts: dict | None = None) -> dict:
    return {
        "id": str(induction.id),
        "induction_code": induction.induction_code,
        "name": induction.name,
        "category": induction.category,
        "description": induction.description,
        "department": {"id": str(induction.department.id), "name": induction.department.name, "code": induction.department.code},
        "trainer": {"id": str(induction.trainer.id), "name": induction.trainer.name} if induction.trainer else None,
        "status": induction.status,
        "counts": counts,
        "created_at": iso(induction.created_at),
    }


def list_inductions(db: Session) -> list[dict]:
    inductions = db.scalars(select(InductionProgramme).options(joinedload(InductionProgramme.department), joinedload(InductionProgramme.trainer)).order_by(InductionProgramme.status, InductionProgramme.name, InductionProgramme.id)).unique().all()
    counts = _counts(db, [i.id for i in inductions]) if inductions else {}
    return [induction_view(i, counts.get(i.id)) for i in inductions]


def detail(db: Session, induction: InductionProgramme) -> dict:
    return induction_view(induction, _counts(db, [induction.id])[induction.id])


def require_active(induction: InductionProgramme) -> None:
    if induction.status != InductionStatus.ACTIVE:
        raise conflict("INDUCTION_ARCHIVED", "This induction is archived. Reactivate it before adding batches, employees or assignments.")


# ---------- Batches ----------

class BatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    batch_number: int = Field(ge=1, le=999)
    name: str | None = Field(default=None, max_length=120)
    start_date: date | None = None


class BatchUpdateIn(BaseModel):
    """The label only. Month, year and number are the batch's identity and stay as created."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str | None = Field(default=None, max_length=120)
    start_date: date | None = None


def create_batch(db: Session, induction: InductionProgramme, body: BatchIn, actor_id: uuid.UUID) -> InductionBatch:
    require_active(induction)
    batch = InductionBatch(induction_id=induction.id, batch_year=body.year, batch_month=body.month, batch_number=body.batch_number, name=body.name or None, start_date=body.start_date, created_by=actor_id)
    try:
        with db.begin_nested():  # Added inside the savepoint: begin_nested() flushes pending objects first.
            db.add(batch)
            db.flush()
    except IntegrityError as exc:
        raise conflict("BATCH_EXISTS", f"{batch_label(batch)} already exists in {induction.name}. Choose another batch number.") from exc
    record_audit(db, actor_id, "INDUCTION_BATCH_CREATED", "induction_batch", batch.id, after={"induction_id": str(induction.id), "label": batch_label(batch)})
    return batch


def update_batch(db: Session, batch: InductionBatch, body: BatchUpdateIn, actor_id: uuid.UUID) -> InductionBatch:
    before = batch_label(batch)
    batch.name = body.name or None
    batch.start_date = body.start_date
    db.flush()
    record_audit(db, actor_id, "INDUCTION_BATCH_UPDATED", "induction_batch", batch.id, before={"label": before}, after={"label": batch_label(batch)})
    return batch


def list_batches(db: Session, induction: InductionProgramme) -> list[dict]:
    batches = db.scalars(
        select(InductionBatch).where(InductionBatch.induction_id == induction.id).order_by(InductionBatch.batch_year.desc(), InductionBatch.batch_month.desc(), InductionBatch.batch_number, InductionBatch.id)
    ).all()
    A = InductionAssignment
    stats = {
        batch_id: (assigned, submitted, completed)
        for batch_id, assigned, submitted, completed in db.execute(
            select(A.batch_id, func.count(A.id), func.count(A.assessment_submitted_at), func.count(case((A.status == InductionAssignmentStatus.COMPLETED, 1))))
            .where(A.induction_id == induction.id)
            .group_by(A.batch_id)
        ).all()
    }
    members = dict(db.execute(select(InductionBatchMember.batch_id, func.count(InductionBatchMember.id)).where(InductionBatchMember.induction_id == induction.id).group_by(InductionBatchMember.batch_id)).all())
    out = []
    for b in batches:
        assigned, submitted, completed = stats.get(b.id, (0, 0, 0))
        out.append({**batch_view(b), "members": members.get(b.id, 0), "assigned": assigned, "assessment_submitted": submitted, "feedback_submitted": completed, "completed": completed, "created_at": iso(b.created_at)})
    return out


# ---------- Members (the Employees tab) ----------

def list_members(db: Session, induction: InductionProgramme) -> list[dict]:
    rows = db.execute(
        select(InductionBatchMember, Employee, InductionBatch, InductionAssignment, InductionAttempt)
        .join(Employee, Employee.id == InductionBatchMember.employee_id)
        .join(InductionBatch, InductionBatch.id == InductionBatchMember.batch_id)
        .outerjoin(InductionAssignment, InductionAssignment.employee_id == InductionBatchMember.employee_id)
        .outerjoin(InductionAttempt, InductionAttempt.assignment_id == InductionAssignment.id)
        .options(joinedload(Employee.department))
        .where(InductionBatchMember.induction_id == induction.id)
        .order_by(Employee.full_name, Employee.employee_code, Employee.id)
    ).all()
    out = []
    for member, employee, batch, assignment, attempt in rows:
        # An assignment under another card (made before this membership) belongs to that card, not this one.
        own = assignment if assignment is not None and assignment.induction_id == induction.id else None
        out.append(
            {
                "employee_id": str(employee.id),
                "employee_code": employee.employee_code,
                "full_name": employee.full_name,
                "department": employee.department.name if employee.department else None,
                "employment_status": employee.employment_status,
                "batch": batch_view(batch),
                "added_at": iso(member.added_at),
                "assignment_id": str(own.id) if own else None,
                "status": own.status if own else "NOT_ASSIGNED",
                "status_label": STATUS_LABEL.get(own.status, own.status) if own else "Not assigned",
                "assigned_at": iso(own.assigned_at) if own else None,
                "elsewhere": _context(assignment) if assignment is not None and own is None else None,
                "result_status": attempt.result_status if own and attempt else None,
            }
        )
    return out


def _context(assignment: InductionAssignment) -> dict:
    return {
        "assignment_id": str(assignment.id),
        "induction_id": str(assignment.induction_id),
        "induction_name": assignment.induction.name,
        "batch_label": batch_label(assignment.batch),
        "status": assignment.status,
        "status_label": STATUS_LABEL.get(assignment.status, assignment.status),
    }


# ---------- Eligibility and assignment ----------

def _department_people(db: Session, induction: InductionProgramme):
    return (
        select(Employee)
        .options(joinedload(Employee.department))
        .where(Employee.department_id == induction.department_id, Employee.employment_status != EmploymentStatus.INACTIVE, is_learner())
    )


def eligible(db: Session, induction: InductionProgramme, batch: InductionBatch) -> list[dict]:
    """The department's active employees with whether each can be assigned in this batch, and why not."""
    people = db.scalars(_department_people(db, induction).order_by(Employee.full_name, Employee.employee_code, Employee.id)).unique().all()
    ids = [p.id for p in people]
    memberships = {m.employee_id: m for m in db.scalars(select(InductionBatchMember).options(joinedload(InductionBatchMember.batch)).where(InductionBatchMember.induction_id == induction.id, InductionBatchMember.employee_id.in_(ids)))} if ids else {}
    assignments = {a.employee_id: a for a in db.scalars(select(InductionAssignment).options(joinedload(InductionAssignment.induction), joinedload(InductionAssignment.batch)).where(InductionAssignment.employee_id.in_(ids)))} if ids else {}
    out = []
    for p in people:
        member = memberships.get(p.id)
        assignment = assignments.get(p.id)
        if assignment is not None:
            here = assignment.induction_id == induction.id and assignment.batch_id == batch.id
            state, reason = ("ASSIGNED_HERE", f"Already assigned in this batch ({STATUS_LABEL.get(assignment.status, assignment.status)}).") if here else ("ASSIGNED_ELSEWHERE", f"Already assigned under {assignment.induction.name} · {batch_label(assignment.batch)} ({STATUS_LABEL.get(assignment.status, assignment.status)}). Each employee takes the induction once.")
        elif member is not None and member.batch_id != batch.id:
            state, reason = "OTHER_BATCH", f"Member of {batch_label(member.batch)}. Assign them from that batch."
        else:
            state, reason = ("IN_BATCH" if member is not None else "ELIGIBLE"), None
        out.append(
            {
                "employee_id": str(p.id),
                "employee_code": p.employee_code,
                "full_name": p.full_name,
                "department": p.department.name if p.department else None,
                "in_batch": member is not None and member.batch_id == batch.id,
                "eligible": state in ("ELIGIBLE", "IN_BATCH"),
                "state": state,
                "reason": reason,
                "existing": _context(assignment) if assignment is not None else None,
            }
        )
    return out


class AssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: uuid.UUID
    employee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_ASSIGN)
    whole_batch: bool = False  # The batch's current members only: later additions are never assigned by this.


def _skip(employee: Employee | None, employee_id: uuid.UUID, reason: str, existing: dict | None = None) -> dict:
    return {"employee_id": str(employee_id), "employee_code": employee.employee_code if employee else None, "full_name": employee.full_name if employee else None, "reason": reason, "existing": existing}


def assign(db: Session, induction: InductionProgramme, batch: InductionBatch, body: AssignIn, actor_id: uuid.UUID) -> dict:
    """Assigns the chosen employees in this batch. Each request is checked again here: employees outside the card's
    department, inactive, already assigned anywhere in Induction, or in another batch of this card are skipped with
    the reason. Repeating the request assigns no one twice."""
    require_active(induction)
    if body.whole_batch:
        ids = list(db.scalars(select(InductionBatchMember.employee_id).where(InductionBatchMember.batch_id == batch.id)))
    else:
        ids = list(dict.fromkeys(body.employee_ids))
    if not ids:
        raise validation("This batch has no members to assign." if body.whole_batch else "Select at least one employee.")
    people = {e.id: e for e in db.scalars(select(Employee).options(joinedload(Employee.department)).where(Employee.id.in_(ids), is_learner())).unique()}
    memberships = {m.employee_id: m for m in db.scalars(select(InductionBatchMember).options(joinedload(InductionBatchMember.batch)).where(InductionBatchMember.induction_id == induction.id, InductionBatchMember.employee_id.in_(ids)))}
    department = induction.department
    now = utcnow()
    assigned, skipped = [], []
    for employee_id in ids:
        employee = people.get(employee_id)
        if employee is None:
            skipped.append(_skip(None, employee_id, "This employee does not exist."))
            continue
        if employee.employment_status == EmploymentStatus.INACTIVE:
            skipped.append(_skip(employee, employee_id, "Inactive employees cannot be assigned."))
            continue
        if employee.department_id != induction.department_id:
            skipped.append(_skip(employee, employee_id, f"Not in the {department.name} department, so not eligible for {induction.name}."))
            continue
        existing = db.scalar(select(InductionAssignment).options(joinedload(InductionAssignment.induction), joinedload(InductionAssignment.batch)).where(InductionAssignment.employee_id == employee_id))
        if existing is not None:
            skipped.append(_skip(employee, employee_id, f"Already assigned under {existing.induction.name} · {batch_label(existing.batch)}. Each employee takes the induction once.", _context(existing)))
            continue
        member = memberships.get(employee_id)
        if member is not None and member.batch_id != batch.id:
            skipped.append(_skip(employee, employee_id, f"Member of {batch_label(member.batch)}. Assign them from that batch."))
            continue
        try:
            with db.begin_nested():
                if member is None:
                    db.add(InductionBatchMember(induction_id=induction.id, batch_id=batch.id, employee_id=employee_id, added_by=actor_id))
                db.add(InductionAssignment(employee_id=employee_id, induction_id=induction.id, batch_id=batch.id, department_id=employee.department_id, status=InductionAssignmentStatus.ASSIGNED, assigned_at=now, assigned_by=actor_id))
                db.flush()
        except IntegrityError:
            # Another request assigned them (or put them in another batch) at the same moment: one record is kept.
            existing = db.scalar(select(InductionAssignment).where(InductionAssignment.employee_id == employee_id))
            skipped.append(_skip(employee, employee_id, "Assigned by another request at the same moment. Each employee takes the induction once." if existing else "Joined another batch at the same moment.", _context(existing) if existing else None))
            continue
        assigned.append({"employee_id": str(employee_id), "employee_code": employee.employee_code, "full_name": employee.full_name})
    if assigned:
        record_audit(db, actor_id, "INDUCTION_ASSIGNED", "induction_batch", batch.id, after={"induction_id": str(induction.id), "assigned": len(assigned), "skipped": len(skipped), "whole_batch": body.whole_batch})
    return {"batch": batch_view(batch), "assigned": assigned, "skipped": skipped}


# ---------- New employees straight into a batch ----------

def add_members(db: Session, induction: InductionProgramme, batch: InductionBatch, employees: list[Employee], actor_id: uuid.UUID) -> None:
    """Called in the same transaction as the employees' creation: both are saved, or neither."""
    for employee in employees:
        if employee.department_id != induction.department_id:
            raise RuntimeError("add_members() was given an employee outside the induction's department.")
        db.add(InductionBatchMember(induction_id=induction.id, batch_id=batch.id, employee_id=employee.id, added_by=actor_id))
    db.flush()


def get_assignment(db: Session, induction: InductionProgramme, assignment_id: uuid.UUID) -> InductionAssignment:
    assignment = db.get(InductionAssignment, assignment_id)
    if assignment is None or assignment.induction_id != induction.id:
        raise not_found("This record does not exist in this induction.")
    return assignment
