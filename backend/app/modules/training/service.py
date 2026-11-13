"""Enrolment, attendance, completion and assessment-scheduling rules.

This module is the single place that decides who may be assigned, who may be marked complete and
whether a post-test can be scheduled. The manual actions, bulk assignment and the completion import
all call it, so the rules cannot drift apart. Assignment, attendance, completion and result stay
separate facts.
"""
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import exists, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.enums import (
    AssessmentType,
    AttendanceStatus,
    EmploymentStatus,
    EnrolmentStatus,
    ObligationStatus,
    TargetScope,
    TrainingStatus,
)
from app.core.errors import ApiError, conflict, validation
from app.core.responses import iso
from app.models import AssessmentConfig, AssessmentObligation, Employee, Enrolment, Training, TrainingBatch, TrainingCompletion
from app.modules.assessment.gate import obligation_startable
from app.modules.assessment.scheduling import calculate_due_at, load_calendar, schedule_snapshot
from app.modules.assessment.service import active_config, counted_attempts, pool_message, pool_report
from app.modules.behaviour.service import create_cycles
from app.modules.notifications.service import notify_employee, notify_roles

# Post-test obligations that are still waiting for the employee.
OPEN_OBLIGATION_STATUSES = (ObligationStatus.SCHEDULED, ObligationStatus.DUE, ObligationStatus.RETAKE_PENDING)


def employee_label(employee: Employee) -> str:
    return f"{employee.full_name} ({employee.employee_code})"


# ---------- Targeting ----------

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


def audience_text(training: Training) -> str:
    parts = []
    if training.departments:
        parts.append("departments: " + ", ".join(sorted(d.name for d in training.departments)))
    if training.functions:
        parts.append("functions: " + ", ".join(sorted(f.name for f in training.functions)))
    return "; ".join(parts) or "all employees"


def targeted_employees(db: Session, training: Training) -> list[Employee]:
    active = db.scalars(select(Employee).where(Employee.employment_status != EmploymentStatus.INACTIVE)).all()
    return [e for e in active if in_target(training, e)]


# ---------- Assignment eligibility ----------

def training_assignment_problem(training: Training) -> ApiError | None:
    """Only an ACTIVE training takes new assignments. Draft and archived ones are refused."""
    if training.status != TrainingStatus.ACTIVE:
        return conflict(
            "TRAINING_NOT_ACTIVE",
            f"{training.title} is {training.status.lower()}, so it cannot receive new assignments or completions. "
            "Activate it in Training Management first. Existing records are kept.",
            {"training_id": str(training.id), "status": training.status},
        )
    return None


def employee_assignment_problem(training: Training, employee: Employee) -> tuple[str, str] | None:
    """(status, reason) when this employee may not hold a new assignment to this training."""
    if employee.employment_status == EmploymentStatus.INACTIVE:
        return "INACTIVE", f"{employee_label(employee)} is inactive and cannot receive new assignments."
    if not in_target(training, employee):
        return "OUT_OF_TARGET", f"{employee_label(employee)} is outside this training's audience ({audience_text(training)})."
    return None


def new_assignment_problem(training: Training, employee: Employee) -> ApiError | None:
    problem = training_assignment_problem(training)
    if problem:
        return problem
    blocked = employee_assignment_problem(training, employee)
    if blocked:
        code = "INACTIVE_EMPLOYEE" if blocked[0] == "INACTIVE" else "OUT_OF_TARGET"
        return conflict(code, blocked[1], {"employee_code": employee.employee_code})
    return None


def find_enrolment(db: Session, employee_id: uuid.UUID, training_id: uuid.UUID) -> Enrolment | None:
    return db.scalar(
        select(Enrolment).where(
            Enrolment.employee_id == employee_id,
            Enrolment.training_id == training_id,
            Enrolment.enrolment_status != EnrolmentStatus.CANCELLED,
        )
    )


def cancelled_enrolment(db: Session, employee_id: uuid.UUID, training_id: uuid.UUID) -> Enrolment | None:
    return db.scalar(
        select(Enrolment)
        .where(Enrolment.employee_id == employee_id, Enrolment.training_id == training_id, Enrolment.enrolment_status == EnrolmentStatus.CANCELLED)
        .order_by(Enrolment.updated_at.desc())
        .limit(1)
    )


def assign_employees(
    db: Session,
    training: Training,
    batch: TrainingBatch | None,
    employees: list[Employee],
    now: datetime | None = None,
    missing_ids: list[uuid.UUID] | tuple = (),
) -> dict:
    """Validates every employee against the same rules and reports each outcome.

    Never creates a duplicate enrolment; the partial unique index backs this up. Each insert runs in
    its own savepoint, so a concurrent duplicate is reported instead of failing the whole request.
    """
    now = now or utcnow()
    problem = training_assignment_problem(training)
    if problem:
        raise problem
    results: list[dict] = []
    seen: set[uuid.UUID] = set()
    for employee in employees:
        if employee.id in seen:
            continue
        seen.add(employee.id)
        row: dict = {"employee_id": str(employee.id), "employee_code": employee.employee_code, "employee_name": employee.full_name, "status": "ASSIGNED", "reason": None}
        blocked = employee_assignment_problem(training, employee)
        if blocked:
            row["status"], row["reason"] = blocked
        elif find_enrolment(db, employee.id, training.id):
            row["status"], row["reason"] = "ALREADY_ASSIGNED", f"{employee_label(employee)} is already assigned to this training."
        else:
            try:
                with db.begin_nested():
                    db.add(Enrolment(training_id=training.id, batch_id=batch.id if batch else None, employee_id=employee.id, assigned_at=now))
                    db.flush()
            except IntegrityError:
                row["status"], row["reason"] = "ALREADY_ASSIGNED", f"{employee_label(employee)} was assigned by another request at the same moment."
        results.append(row)
    for missing in dict.fromkeys(missing_ids):
        results.append({"employee_id": str(missing), "employee_code": None, "employee_name": None, "status": "NOT_FOUND", "reason": "No employee record matches this ID."})

    def count(status: str) -> int:
        return sum(1 for r in results if r["status"] == status)

    return {
        "created": count("ASSIGNED"),
        "skipped_existing": count("ALREADY_ASSIGNED"),
        "skipped_out_of_target": count("OUT_OF_TARGET"),
        "skipped_inactive": count("INACTIVE"),
        "not_found": count("NOT_FOUND"),
        "results": results,
    }


# ---------- Attendance and completion eligibility ----------

def completable_attendance() -> set[str]:
    """Attendance that counts as completion. PENDING is also accepted: recording completion confirms
    attendance, and the record is saved as PRESENT."""
    allowed = {AttendanceStatus.PRESENT.value}
    if get_settings().completion_allows_partial_attendance:
        allowed.add(AttendanceStatus.PARTIAL.value)
    return allowed


ATTENDANCE_HINT = {
    AttendanceStatus.ABSENT: "Absent employees cannot be marked complete. Record Present once they attend the training, or cancel the assignment.",
    AttendanceStatus.EXCUSED: "Excused employees did not attend, so they cannot be marked complete. Assign them to a later batch or cancel the assignment.",
    AttendanceStatus.PARTIAL: "Partial attendance does not count as completion under the current policy. Record Present if the employee finished the training.",
}


def attendance_problem(attendance: str, label: str) -> ApiError | None:
    if attendance == AttendanceStatus.PENDING or attendance in completable_attendance():
        return None
    return conflict(
        "ATTENDANCE_NOT_COMPLETABLE",
        f"{label}: attendance is {attendance.lower()}. {ATTENDANCE_HINT[AttendanceStatus(attendance)]}",
        {"attendance_status": attendance, "completable": sorted(completable_attendance())},
    )


def completion_problem(enrolment: Enrolment, attendance: str | None = None) -> ApiError | None:
    """Everything that must hold before a completion is recorded, for the manual action and the import."""
    employee, training = enrolment.employee, enrolment.training
    label = employee_label(employee)
    if enrolment.enrolment_status == EnrolmentStatus.CANCELLED:
        return conflict("ENROLMENT_CANCELLED", f"The assignment of {label} to {training.title} was cancelled. Assign the employee again before recording completion.")
    if enrolment.completion is not None:
        return conflict("COMPLETION_EXISTS", f"Completion is already recorded for {label} in {training.title}. A second completion would duplicate the assessment.")
    problem = training_assignment_problem(training)
    if problem:
        return problem
    blocked = employee_assignment_problem(training, employee)
    if blocked:
        code = "INACTIVE_EMPLOYEE" if blocked[0] == "INACTIVE" else "OUT_OF_TARGET"
        hint = "" if blocked[0] == "INACTIVE" else " If the employee changed department or function, cancel this assignment or update the training audience."
        return conflict(code, f"{blocked[1]} Completion cannot be recorded.{hint}")
    return attendance_problem(attendance or enrolment.attendance_status, label)


# ---------- Assessment readiness and scheduling ----------

@dataclass
class Readiness:
    ready: bool
    reason: str | None = None
    message: str = ""
    action: str | None = None
    config: AssessmentConfig | None = None
    pool: dict | None = None

    def view(self) -> dict:
        return {"ready": self.ready, "reason": self.reason, "message": self.message, "action": self.action}


SCHEDULE_ACTION = "then open the training in Training Management and select Schedule pending assessments."


def readiness_from(training: Training, config: AssessmentConfig | None, report: dict | None) -> Readiness:
    """Readiness from an already-computed pool report, so callers never count the pool twice."""
    if config is None:
        return Readiness(False, "NOT_CONFIGURED", f"{training.title} has no active assessment configuration.", f"Save the assessment rules in Assessment Configuration, {SCHEDULE_ACTION}")
    if report is None or not report.get("ready"):
        message = pool_message(report, training.title) if report else "The question pool could not be checked."
        return Readiness(False, "QUESTION_POOL_INSUFFICIENT", message, f"Add or import questions, or reduce questions per attempt in Assessment Configuration, {SCHEDULE_ACTION}", config, report)
    return Readiness(True, None, f"{training.title} is ready: {report['eligible']} eligible questions for {config.question_count} per attempt.", None, config, report)


def assessment_readiness(db: Session, training: Training) -> Readiness:
    """Whether a post-test can be scheduled now: an active configuration whose pool can run."""
    config = active_config(db, training.id, AssessmentType.POST_TEST)
    report = pool_report(db, training.id, config.question_count, config.difficulty_mix) if config else None
    return readiness_from(training, config, report)


def latest_post_obligation(db: Session, enrolment_id: uuid.UUID) -> AssessmentObligation | None:
    return db.scalar(
        select(AssessmentObligation)
        .where(AssessmentObligation.enrolment_id == enrolment_id, AssessmentObligation.assessment_type == AssessmentType.POST_TEST)
        .order_by(AssessmentObligation.cycle_number.desc())
        .limit(1)
    )


def alert_not_scheduled(db: Session, training: Training, readiness: Readiness, now: datetime) -> None:
    """One in-app alert per training per day to L&D, however many completions were affected."""
    notify_roles(
        db,
        ("LD_ADMIN",),
        "ASSESSMENT_NOT_SCHEDULED",
        f"Assessments not scheduled: {training.title}",
        f"Training completion was recorded, but the mandatory assessment could not be scheduled. {readiness.message} {readiness.action}",
        "/lnd/completion",
        f"not-scheduled:{training.id}:{load_calendar(db).local_date(now).isoformat()}",
        now,
    )


def schedule_post_test(db: Session, enrolment: Enrolment, completed_at: datetime, actor_id: uuid.UUID | None, now: datetime, readiness: Readiness | None = None) -> dict:
    """Creates the post-test obligation for a completed enrolment, or explains why it cannot.

    Never creates an obligation the employee could not start (BR §20.4) and never a second one.
    The returned dict carries the obligation under "obligation"; strip it with scheduling_view().
    """
    employee, training = enrolment.employee, enrolment.training
    label = employee_label(employee)
    existing = latest_post_obligation(db, enrolment.id)
    if existing is not None:
        return {"status": "ALREADY_SCHEDULED", "reason": None, "message": f"An assessment already exists for {label}.", "action": None, "due_at": iso(existing.due_at), "obligation": existing}
    readiness = readiness or assessment_readiness(db, training)
    if not readiness.ready:
        record_audit(db, actor_id, "ASSESSMENT_NOT_SCHEDULED", "enrolment", enrolment.id, reason=readiness.reason, after={"employee": employee.employee_code, "training": training.training_code, "message": readiness.message})
        alert_not_scheduled(db, training, readiness, now)
        return {
            "status": "NOT_SCHEDULED",
            "reason": readiness.reason,
            "message": f"Completion was recorded for {label}, but the assessment was not scheduled. {readiness.message}",
            "action": readiness.action,
            "due_at": None,
            "obligation": None,
        }
    config = readiness.config
    calendar = load_calendar(db)
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
    db.flush()
    due_day = calendar.local_date(obligation.due_at).isoformat()
    record_audit(db, actor_id, "ASSESSMENT_OBLIGATION_CREATED", "assessment_obligation", obligation.id, after={"employee": employee.employee_code, "training": training.training_code, "due_at": iso(obligation.due_at), "config_version": config.version})
    notify_employee(
        db,
        enrolment.employee_id,
        "ASSESSMENT_SCHEDULED",
        f"Assessment scheduled: {training.title}",
        f"Your mandatory assessment is due from {due_day}. You will be asked to complete it when you sign in after that time.",
        "/employee/assessments",
        f"scheduled:{obligation.id}",
        now,
    )
    return {"status": "SCHEDULED", "reason": None, "message": f"Assessment scheduled for {label}, due from {due_day}.", "action": None, "due_at": iso(obligation.due_at), "obligation": obligation}


def scheduling_view(outcome: dict) -> dict:
    return {k: v for k, v in outcome.items() if k != "obligation"}


@dataclass
class CompletionOutcome:
    completion: TrainingCompletion
    obligation: AssessmentObligation | None
    scheduling: dict


def complete_enrolment(
    db: Session,
    enrolment: Enrolment,
    completed_at: datetime,
    source: str,
    recorded_by: uuid.UUID | None,
    source_event_id: str | None = None,
    import_job_id: uuid.UUID | None = None,
    attendance: str | None = None,
    now: datetime | None = None,
) -> CompletionOutcome:
    """Records completion, then schedules the post-test when the training can run one.

    A completion is kept even when the assessment cannot be scheduled; the outcome says so, L&D is
    alerted and the enrolment appears as "not scheduled" until L&D schedules it.
    """
    now = now or utcnow()
    problem = completion_problem(enrolment, attendance)
    if problem:
        raise problem
    if completed_at > now:
        raise validation("The completion date cannot be in the future.")

    completion = TrainingCompletion(
        enrolment_id=enrolment.id,
        completed_at=completed_at,
        completion_source=source,
        source_event_id=source_event_id,
        recorded_by=recorded_by,
        import_job_id=import_job_id,
    )
    db.add(completion)
    enrolment.enrolment_status = EnrolmentStatus.COMPLETED
    status = attendance or enrolment.attendance_status
    enrolment.attendance_status = AttendanceStatus.PRESENT if status == AttendanceStatus.PENDING else status
    db.flush()

    scheduling = schedule_post_test(db, enrolment, completed_at, recorded_by, now)
    if get_settings().behaviour_enabled:  # Level 3 is out of scope; legacy follow-ups only when switched on.
        create_cycles(db, enrolment, completed_at)
    db.flush()
    db.expire(enrolment, ["completion", "obligations"])
    return CompletionOutcome(completion, scheduling["obligation"], scheduling)


def record_completion(
    db: Session,
    enrolment: Enrolment,
    completed_at: datetime,
    source: str,
    recorded_by: uuid.UUID | None,
    source_event_id: str | None = None,
    import_job_id: uuid.UUID | None = None,
    attendance: str | None = None,
) -> AssessmentObligation | None:
    """Completion is the only trigger for the post-test. Returns the obligation, if one was scheduled."""
    return complete_enrolment(db, enrolment, completed_at, source, recorded_by, source_event_id, import_job_id, attendance).obligation


# ---------- Recovery ----------

def unscheduled_completions(db: Session, training_id: uuid.UUID) -> list[Enrolment]:
    """Completed, live enrolments with no post-test obligation: completions whose assessment was not scheduled."""
    has_post = exists().where(AssessmentObligation.enrolment_id == Enrolment.id, AssessmentObligation.assessment_type == AssessmentType.POST_TEST)
    return list(
        db.scalars(
            select(Enrolment)
            .join(TrainingCompletion, TrainingCompletion.enrolment_id == Enrolment.id)
            .where(Enrolment.training_id == training_id, Enrolment.enrolment_status != EnrolmentStatus.CANCELLED, ~has_post)
            .order_by(TrainingCompletion.completed_at)
        )
    )


def unavailable_for_training(db: Session, training_id: uuid.UUID) -> list[AssessmentObligation]:
    """Open post-tests of a training that cannot start because their question pool no longer suffices."""
    cache: dict = {}
    open_ones = db.scalars(
        select(AssessmentObligation).where(
            AssessmentObligation.training_id == training_id,
            AssessmentObligation.assessment_type == AssessmentType.POST_TEST,
            AssessmentObligation.status.in_(OPEN_OBLIGATION_STATUSES),
        )
    ).all()
    return [o for o in open_ones if not obligation_startable(db, o, cache)]


def schedule_pending_assessments(db: Session, training: Training, actor_id: uuid.UUID | None, now: datetime | None = None) -> dict:
    """L&D recovery after fixing a configuration or question pool.

    1. Schedules the post-test for completions recorded while the training could not run one.
    2. Moves open obligations whose old configuration can no longer run onto the current, valid
       configuration, so nobody stays stuck. Attempts already made keep their own snapshots.
    """
    now = now or utcnow()
    readiness = assessment_readiness(db, training)
    if not readiness.ready:
        raise ApiError(422, readiness.reason or "NOT_READY", f"Nothing can be scheduled yet. {readiness.message} {readiness.action}", {**readiness.view(), "pool": readiness.pool})
    scheduled = []
    for enrolment in unscheduled_completions(db, training.id):
        outcome = schedule_post_test(db, enrolment, enrolment.completion.completed_at, actor_id, now, readiness)
        if outcome["status"] == "SCHEDULED":
            scheduled.append({"employee_code": enrolment.employee.employee_code, "employee_name": enrolment.employee.full_name, "due_at": outcome["due_at"]})

    config = readiness.config
    moved, still_blocked = [], []
    for obligation in unavailable_for_training(db, training.id):
        employee = obligation.employee
        if counted_attempts(obligation) >= config.max_attempts:
            still_blocked.append({"employee_code": employee.employee_code, "employee_name": employee.full_name, "reason": "Attempts already used reach the current maximum. Waive it or open a new cycle."})
            continue
        before = obligation.config.version
        obligation.config = config
        record_audit(db, actor_id, "ASSESSMENT_OBLIGATION_RECONFIGURED", "assessment_obligation", obligation.id, reason="Previous configuration's question pool could not run.", before={"config_version": before}, after={"config_version": config.version})
        moved.append({"employee_code": employee.employee_code, "employee_name": employee.full_name})
    db.flush()
    record_audit(db, actor_id, "PENDING_ASSESSMENTS_SCHEDULED", "training", training.id, after={"scheduled": len(scheduled), "reconfigured": len(moved), "still_blocked": len(still_blocked)})
    return {"scheduled": scheduled, "reconfigured": moved, "still_blocked": still_blocked}
