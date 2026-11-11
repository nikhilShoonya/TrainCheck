"""Enrolment and completion rules. Assignment, attendance, completion and result stay separate facts."""
import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.enums import (
    AssessmentType,
    EmploymentStatus,
    EnrolmentStatus,
    ObligationStatus,
    TargetScope,
    TrainingStatus,
)
from app.core.errors import conflict, validation
from app.models import AssessmentObligation, Employee, Enrolment, Training, TrainingBatch, TrainingCompletion
from app.modules.assessment.scheduling import calculate_due_at, load_calendar, schedule_snapshot
from app.modules.assessment.service import active_config
from app.modules.behaviour.service import create_cycles


def in_target(training: Training, employee: Employee) -> bool:
    """Common, department-specific, function-specific or combined targeting (SC-2L-103)."""
    in_department = employee.department_id in {d.id for d in training.departments}
    in_function = employee.function_id in {f.id for f in training.functions}
    return {
        TargetScope.COMMON: True,
        TargetScope.DEPARTMENT: in_department,
        TargetScope.FUNCTION: in_function,
        TargetScope.COMBINED: in_department and in_function,
    }[TargetScope(training.target_scope)]


def targeted_employees(db: Session, training: Training) -> list[Employee]:
    active = db.scalars(select(Employee).where(Employee.employment_status != EmploymentStatus.INACTIVE)).all()
    return [e for e in active if in_target(training, e)]


def find_enrolment(db: Session, employee_id: uuid.UUID, training_id: uuid.UUID) -> Enrolment | None:
    return db.scalar(
        select(Enrolment).where(
            Enrolment.employee_id == employee_id,
            Enrolment.training_id == training_id,
            Enrolment.enrolment_status != EnrolmentStatus.CANCELLED,
        )
    )


def assign_employees(db: Session, training: Training, batch: TrainingBatch | None, employees: list[Employee], now: datetime | None = None) -> dict:
    """Never creates a duplicate enrolment; the partial unique index backs this up."""
    now = now or utcnow()
    if training.status == TrainingStatus.ARCHIVED:
        raise conflict("TRAINING_ARCHIVED", "This training is archived and cannot take new assignments.")
    created, duplicates, out_of_target = 0, 0, 0
    for employee in employees:
        if not in_target(training, employee):
            out_of_target += 1
        elif find_enrolment(db, employee.id, training.id):
            duplicates += 1
        else:
            db.add(Enrolment(training_id=training.id, batch_id=batch.id if batch else None, employee_id=employee.id, assigned_at=now))
            db.flush()
            created += 1
    return {"created": created, "skipped_existing": duplicates, "skipped_out_of_target": out_of_target}


def record_completion(
    db: Session,
    enrolment: Enrolment,
    completed_at: datetime,
    source: str,
    recorded_by: uuid.UUID | None,
    source_event_id: str | None = None,
    import_job_id: uuid.UUID | None = None,
) -> AssessmentObligation | None:
    """Completion is the only trigger for the post-test and the 30/60/90-day follow-ups."""
    if enrolment.enrolment_status == EnrolmentStatus.CANCELLED:
        raise conflict("ENROLMENT_CANCELLED", "This assignment was cancelled.")
    if enrolment.completion is not None:
        raise conflict("COMPLETION_EXISTS", "Completion is already recorded for this employee and training.")
    if completed_at > utcnow():
        raise validation("The completion date cannot be in the future.")

    db.add(
        TrainingCompletion(
            enrolment_id=enrolment.id,
            completed_at=completed_at,
            completion_source=source,
            source_event_id=source_event_id,
            recorded_by=recorded_by,
            import_job_id=import_job_id,
        )
    )
    enrolment.enrolment_status = EnrolmentStatus.COMPLETED
    if enrolment.attendance_status == "PENDING":
        enrolment.attendance_status = "PRESENT"

    obligation = None
    config = active_config(db, enrolment.training_id, AssessmentType.POST_TEST)
    calendar = load_calendar(db)
    if config is not None:
        obligation = AssessmentObligation(
            enrolment_id=enrolment.id,
            employee_id=enrolment.employee_id,
            training_id=enrolment.training_id,
            config_id=config.id,
            assessment_type=AssessmentType.POST_TEST,
            status=ObligationStatus.SCHEDULED,
            completed_training_at=completed_at,
            due_at=calculate_due_at(calendar, completed_at, config),
            schedule_snapshot=schedule_snapshot(calendar, config),
        )
        db.add(obligation)
    create_cycles(db, enrolment, completed_at)
    db.flush()
    db.expire(enrolment, ["completion", "obligations"])
    return obligation
