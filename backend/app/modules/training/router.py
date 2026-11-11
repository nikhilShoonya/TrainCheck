"""L&D administration of trainings, batches, sessions, enrolments, completion and assessment configuration."""
import uuid
from datetime import UTC, date, datetime, time
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_reader
from app.core.enums import (
    AssessmentType,
    AttendanceStatus,
    Difficulty,
    EnrolmentStatus,
    MaterialKind,
    ObligationStatus,
    RetrainingFlag,
    ScheduleMode,
    TargetScope,
    TrainingStatus,
)
from app.core.errors import ApiError, conflict, not_found, validation
from app.core.responses import iso, ok
from app.models import (
    AssessmentConfig,
    AssessmentObligation,
    Competency,
    Department,
    Employee,
    Enrolment,
    Function,
    Training,
    TrainingBatch,
    TrainingMaterial,
    TrainingSession,
)
from app.modules.assessment.scheduling import load_calendar
from app.modules.assessment.service import active_config, next_config_version, pool_problem
from app.modules.notifications.service import notify_employee
from app.modules.training import service

router = APIRouter(prefix="/admin", tags=["L&D Administration"])

MIN_ATTEMPTS, MAX_ATTEMPTS = 1, 10
MIN_MINUTES, MAX_MINUTES = 1, 240


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def https_only(value: str | None) -> str | None:
    if value and not value.startswith("https://"):
        raise ValueError("Use an HTTPS link.")
    return value or None


class TrainingIn(Strict):
    training_code: str | None = Field(default=None, max_length=40)
    title: str = Field(min_length=2, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=120)
    trainer_id: uuid.UUID | None = None
    owner_employee_id: uuid.UUID | None = None
    target_scope: TargetScope = TargetScope.COMMON
    department_ids: list[uuid.UUID] = Field(default_factory=list)
    function_ids: list[uuid.UUID] = Field(default_factory=list)
    competency_ids: list[uuid.UUID] = Field(default_factory=list)
    refresher_text: str | None = Field(default=None, max_length=4000)
    refresher_url: str | None = Field(default=None, max_length=500)
    pretest_enabled: bool = False
    behaviour_enabled: bool = True
    followup_days: list[int] = Field(default_factory=lambda: [30, 60, 90], max_length=10)
    item_minimum_sample: int = Field(default=10, ge=1, le=1000)

    _url = field_validator("refresher_url")(https_only)

    @field_validator("followup_days")
    @classmethod
    def valid_days(cls, days: list[int]) -> list[int]:
        if any(d < 1 or d > 365 for d in days) or len(set(days)) != len(days):
            raise ValueError("Use distinct follow-up intervals from 1 to 365 days.")
        return sorted(days)


class StatusIn(Strict):
    status: TrainingStatus


class MaterialIn(Strict):
    kind: MaterialKind = MaterialKind.LINK
    title: str = Field(min_length=1, max_length=200)
    url: str = Field(max_length=500)
    _url = field_validator("url")(https_only)


class BatchIn(Strict):
    training_id: uuid.UUID
    batch_code: str | None = Field(default=None, max_length=60)
    name: str = Field(min_length=1, max_length=160)
    trainer_id: uuid.UUID | None = None
    start_date: date | None = None
    end_date: date | None = None


class SessionIn(Strict):
    title: str = Field(min_length=1, max_length=160)
    session_date: date
    delivery_mode: str | None = Field(default=None, max_length=40)
    venue: str | None = Field(default=None, max_length=160)


class AssignIn(Strict):
    training_id: uuid.UUID
    batch_id: uuid.UUID | None = None
    employee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5000)
    use_training_target: bool = False


class AttendanceIn(Strict):
    attendance_status: AttendanceStatus


class CompletionIn(Strict):
    completion_date: date


class ReasonIn(Strict):
    reason: str = Field(min_length=5, max_length=1000)


class ConfigIn(Strict):
    question_count: int = Field(ge=1, le=200)
    duration_minutes: int = Field(ge=MIN_MINUTES, le=MAX_MINUTES)
    pass_mark_percent: Decimal = Field(default=Decimal("70"), ge=0, le=100, decimal_places=2)
    max_attempts: int = Field(default=3, ge=MIN_ATTEMPTS, le=MAX_ATTEMPTS)
    schedule_mode: ScheduleMode = ScheduleMode.NEXT_WORKING_DAY
    schedule_delay_days: int = Field(default=0, ge=0, le=365)
    schedule_uses_working_days: bool = False
    difficulty_mix: dict[Difficulty, int] | None = None
    show_explanations: bool = False
    shuffle_questions: bool = True
    shuffle_options: bool = True
    violation_limit: int = Field(default=3, ge=1, le=10)
    require_fullscreen: bool = True
    assessment_type: AssessmentType = AssessmentType.POST_TEST


def config_view(config: AssessmentConfig | None) -> dict | None:
    if config is None:
        return None
    return {
        "id": str(config.id),
        "assessment_type": config.assessment_type,
        "version": config.version,
        "question_count": config.question_count,
        "duration_seconds": config.duration_seconds,
        "duration_minutes": config.duration_seconds // 60,
        "pass_mark_percent": float(config.pass_mark_percent),
        "max_attempts": config.max_attempts,
        "schedule_mode": config.schedule_mode,
        "schedule_delay_days": config.schedule_delay_days,
        "schedule_uses_working_days": config.schedule_uses_working_days,
        "difficulty_mix": config.difficulty_mix,
        "show_explanations": config.show_explanations,
        "shuffle_questions": config.shuffle_questions,
        "shuffle_options": config.shuffle_options,
        "violation_limit": config.violation_limit,
        "require_fullscreen": config.require_fullscreen,
    }


def training_view(db: Session, t: Training, detail: bool = False) -> dict:
    enrolments = db.scalars(select(Enrolment).options(selectinload(Enrolment.completion)).where(Enrolment.training_id == t.id, Enrolment.enrolment_status != EnrolmentStatus.CANCELLED)).all()
    post = active_config(db, t.id, AssessmentType.POST_TEST)
    data = {
        "id": str(t.id),
        "training_code": t.training_code,
        "title": t.title,
        "description": t.description,
        "category": t.category,
        "status": t.status,
        "owner_name": t.owner.full_name if t.owner else None,
        "owner_employee_id": str(t.owner_employee_id) if t.owner_employee_id else None,
        "trainer_name": t.trainer.name if t.trainer else None,
        "trainer_id": str(t.trainer_id) if t.trainer_id else None,
        "target_scope": t.target_scope,
        "departments": [{"id": str(d.id), "name": d.name} for d in t.departments],
        "functions": [{"id": str(f.id), "name": f.name} for f in t.functions],
        "competencies": [{"id": str(c.id), "name": c.name} for c in t.competencies],
        "pretest_enabled": t.pretest_enabled,
        "behaviour_enabled": t.behaviour_enabled,
        "followup_days": t.followup_days,
        "item_minimum_sample": t.item_minimum_sample,
        "refresher_text": t.refresher_text,
        "refresher_url": t.refresher_url,
        "assigned_count": len(enrolments),
        "completed_count": sum(1 for e in enrolments if e.completion),
        "config": config_view(post),
    }
    if detail:
        data["materials"] = [{"id": str(m.id), "kind": m.kind, "title": m.title, "url": m.url} for m in t.materials]
        data["pre_test_config"] = config_view(active_config(db, t.id, AssessmentType.PRE_TEST))
        data["pool_problem"] = pool_problem(db, post) if post else {"reason": "NOT_CONFIGURED"}
    return data


def _apply_training(db: Session, t: Training, body: TrainingIn) -> None:
    t.title, t.description, t.category = body.title, body.description, body.category
    t.trainer_id, t.owner_employee_id = body.trainer_id, body.owner_employee_id
    t.target_scope = body.target_scope
    t.refresher_text, t.refresher_url = body.refresher_text, body.refresher_url
    t.pretest_enabled, t.behaviour_enabled = body.pretest_enabled, body.behaviour_enabled
    t.followup_days, t.item_minimum_sample = body.followup_days, body.item_minimum_sample
    needs_department = body.target_scope in (TargetScope.DEPARTMENT, TargetScope.COMBINED)
    needs_function = body.target_scope in (TargetScope.FUNCTION, TargetScope.COMBINED)
    if needs_department and not body.department_ids:
        raise validation("Choose at least one department for this targeting.")
    if needs_function and not body.function_ids:
        raise validation("Choose at least one function for this targeting.")
    t.departments = list(db.scalars(select(Department).where(Department.id.in_(body.department_ids)))) if needs_department else []
    t.functions = list(db.scalars(select(Function).where(Function.id.in_(body.function_ids)))) if needs_function else []
    t.competencies = list(db.scalars(select(Competency).where(Competency.id.in_(body.competency_ids))))


# ---------- Trainings ----------

@router.get("/trainings")
def list_trainings(_: CurrentUser = Depends(require_reader), db: Session = Depends(get_db), search: str = "", status: str = "") -> dict:
    query = select(Training).options(selectinload(Training.owner), selectinload(Training.trainer), selectinload(Training.departments), selectinload(Training.functions), selectinload(Training.competencies)).order_by(Training.title)
    if status:
        query = query.where(Training.status == status)
    if search:
        like = f"%{search}%"
        query = query.where(Training.title.ilike(like) | Training.category.ilike(like) | Training.training_code.ilike(like))
    return ok([training_view(db, t) for t in db.scalars(query)])


@router.post("/trainings")
def create_training(body: TrainingIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    code = (body.training_code or f"TRN-{uuid.uuid4().hex[:6]}").upper()
    training = Training(training_code=code, title=body.title, status=TrainingStatus.DRAFT)
    db.add(training)
    _apply_training(db, training, body)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("DUPLICATE_CODE", "A training with this code already exists.") from exc
    record_audit(db, user.id, "TRAINING_CREATED", "training", training.id, after={"code": code, "title": training.title})
    db.commit()
    return ok(training_view(db, training, detail=True))


def _training(db: Session, training_id: uuid.UUID) -> Training:
    training = db.get(Training, training_id)
    if training is None:
        raise not_found()
    return training


@router.get("/trainings/{training_id}")
def get_training(training_id: uuid.UUID, _: CurrentUser = Depends(require_reader), db: Session = Depends(get_db)) -> dict:
    return ok(training_view(db, _training(db, training_id), detail=True))


@router.patch("/trainings/{training_id}")
def update_training(training_id: uuid.UUID, body: TrainingIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training(db, training_id)
    before = {"title": training.title, "target_scope": training.target_scope, "followup_days": training.followup_days}
    _apply_training(db, training, body)
    record_audit(db, user.id, "TRAINING_UPDATED", "training", training.id, before=before, after={"title": training.title, "target_scope": training.target_scope, "followup_days": training.followup_days})
    db.commit()
    return ok(training_view(db, training, detail=True))


@router.post("/trainings/{training_id}/status")
def set_training_status(training_id: uuid.UUID, body: StatusIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training(db, training_id)
    if body.status == TrainingStatus.ACTIVE:
        config = active_config(db, training.id, AssessmentType.POST_TEST)
        problem = pool_problem(db, config) if config else {"reason": "NOT_CONFIGURED"}
        if problem:
            raise ApiError(422, "QUESTION_POOL_INSUFFICIENT", "Configure the assessment and add enough active questions before activating.", problem)
    before = training.status
    training.status = body.status
    record_audit(db, user.id, "TRAINING_STATUS_CHANGED", "training", training.id, before={"status": before}, after={"status": body.status})
    db.commit()
    return ok(training_view(db, training, detail=True))


@router.post("/trainings/{training_id}/materials")
def add_material(training_id: uuid.UUID, body: MaterialIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training(db, training_id)
    material = TrainingMaterial(training_id=training.id, kind=body.kind, title=body.title, url=body.url)
    db.add(material)
    db.flush()
    record_audit(db, user.id, "TRAINING_MATERIAL_ADDED", "training", training.id, after={"title": body.title})
    db.commit()
    return ok({"id": str(material.id), "kind": material.kind, "title": material.title, "url": material.url})


@router.delete("/trainings/{training_id}/materials/{material_id}")
def remove_material(training_id: uuid.UUID, material_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    material = db.get(TrainingMaterial, material_id)
    if material is None or material.training_id != training_id:
        raise not_found()
    record_audit(db, user.id, "TRAINING_MATERIAL_REMOVED", "training", training_id, before={"title": material.title})
    db.delete(material)
    db.commit()
    return ok({"removed": True})


# ---------- Assessment configuration ----------

@router.post("/trainings/{training_id}/assessment-configs")
def create_config(training_id: uuid.UUID, body: ConfigIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Every change is a new version: past attempts keep their snapshot and obligations keep their config."""
    training = _training(db, training_id)
    if body.schedule_mode == ScheduleMode.DELAY_DAYS and body.schedule_delay_days < 1:
        raise validation("Enter a delay of at least 1 day.")
    mix = {k.value: v for k, v in body.difficulty_mix.items()} if body.difficulty_mix else None
    if mix and (any(v < 0 for v in mix.values()) or sum(mix.values()) != body.question_count):
        raise validation("Difficulty counts must total the questions per attempt.")
    current = active_config(db, training.id, body.assessment_type)
    candidate = AssessmentConfig(
        training_id=training.id,
        assessment_type=body.assessment_type,
        version=next_config_version(db, training.id, body.assessment_type),
        question_count=body.question_count,
        duration_seconds=body.duration_minutes * 60,
        pass_mark_percent=body.pass_mark_percent,
        max_attempts=1 if body.assessment_type == AssessmentType.PRE_TEST else body.max_attempts,
        schedule_mode=body.schedule_mode,
        schedule_delay_days=body.schedule_delay_days,
        schedule_uses_working_days=body.schedule_uses_working_days,
        difficulty_mix=mix,
        show_explanations=body.show_explanations,
        shuffle_questions=body.shuffle_questions,
        shuffle_options=body.shuffle_options,
        violation_limit=body.violation_limit,
        require_fullscreen=body.require_fullscreen,
        created_by=user.id,
        is_active=False,
    )
    problem = pool_problem(db, candidate)
    if problem:
        raise ApiError(422, "QUESTION_POOL_INSUFFICIENT", "The active question pool cannot satisfy this configuration.", problem)
    if current is not None:
        current.is_active = False
        db.flush()
    candidate.is_active = True
    db.add(candidate)
    db.flush()
    record_audit(db, user.id, "ASSESSMENT_CONFIG_CHANGED", "training", training.id, before=config_view(current), after=config_view(candidate))
    db.commit()
    return ok(config_view(candidate))


# ---------- Batches and sessions ----------

def batch_view(db: Session, batch: TrainingBatch) -> dict:
    assigned = db.scalars(select(Enrolment.id).where(Enrolment.batch_id == batch.id, Enrolment.enrolment_status != EnrolmentStatus.CANCELLED)).all()
    return {
        "id": str(batch.id),
        "batch_code": batch.batch_code,
        "name": batch.name,
        "training_id": str(batch.training_id),
        "training_title": batch.training.title,
        "trainer_id": str(batch.trainer_id) if batch.trainer_id else None,
        "trainer_name": batch.trainer.name if batch.trainer else (batch.training.trainer.name if batch.training.trainer else None),
        "start_date": batch.start_date.isoformat() if batch.start_date else None,
        "end_date": batch.end_date.isoformat() if batch.end_date else None,
        "status": batch.status,
        "assigned_count": len(assigned),
        "sessions": [{"id": str(s.id), "title": s.title, "session_date": s.session_date.isoformat(), "delivery_mode": s.delivery_mode, "venue": s.venue} for s in batch.sessions],
    }


@router.get("/batches")
def list_batches(_: CurrentUser = Depends(require_reader), db: Session = Depends(get_db), training_id: uuid.UUID | None = None) -> dict:
    query = select(TrainingBatch).options(selectinload(TrainingBatch.training), selectinload(TrainingBatch.trainer), selectinload(TrainingBatch.sessions)).order_by(TrainingBatch.start_date.desc().nulls_last())
    if training_id:
        query = query.where(TrainingBatch.training_id == training_id)
    return ok([batch_view(db, b) for b in db.scalars(query)])


@router.post("/batches")
def create_batch(body: BatchIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training(db, body.training_id)
    if body.start_date and body.end_date and body.end_date < body.start_date:
        raise validation("The end date cannot be before the start date.")
    batch = TrainingBatch(training_id=training.id, batch_code=(body.batch_code or f"B-{uuid.uuid4().hex[:6]}").upper(), name=body.name, trainer_id=body.trainer_id, start_date=body.start_date, end_date=body.end_date)
    db.add(batch)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("DUPLICATE_CODE", "This training already has a batch with that code.") from exc
    record_audit(db, user.id, "BATCH_CREATED", "training_batch", batch.id, after={"name": batch.name})
    db.commit()
    return ok(batch_view(db, batch))


@router.post("/batches/{batch_id}/sessions")
def add_session(batch_id: uuid.UUID, body: SessionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    batch = db.get(TrainingBatch, batch_id)
    if batch is None:
        raise not_found()
    db.add(TrainingSession(batch_id=batch.id, title=body.title, session_date=body.session_date, delivery_mode=body.delivery_mode, venue=body.venue))
    record_audit(db, user.id, "SESSION_CREATED", "training_batch", batch.id, after={"title": body.title})
    db.commit()
    db.refresh(batch)
    return ok(batch_view(db, batch))


# ---------- Enrolment and completion ----------

def assessment_state(obligations: list[AssessmentObligation], now: datetime) -> str:
    post = sorted((o for o in obligations if o.assessment_type == AssessmentType.POST_TEST), key=lambda o: o.cycle_number)
    if not post:
        return "Not scheduled"
    current = post[-1]
    if current.status == ObligationStatus.WAIVED:
        return "Waived"
    if current.status == ObligationStatus.COMPLETED:
        return "Submitted"
    if current.status == ObligationStatus.RETAKE_PENDING:
        return "Retake pending"
    if current.status == ObligationStatus.IN_PROGRESS:
        return "In progress"
    if current.due_at and current.due_at > now:
        return "Scheduled"
    return "Due"


def enrolment_view(e: Enrolment, now: datetime) -> dict:
    post = sorted((o for o in e.obligations if o.assessment_type == AssessmentType.POST_TEST), key=lambda o: o.cycle_number)
    current = post[-1] if post else None
    return {
        "id": str(e.id),
        "employee_id": str(e.employee_id),
        "employee_name": e.employee.full_name,
        "employee_code": e.employee.employee_code,
        "department": e.employee.department.name if e.employee.department else None,
        "training_id": str(e.training_id),
        "training_title": e.training.title,
        "batch_name": e.batch.name if e.batch else None,
        "assigned_at": iso(e.assigned_at),
        "attendance_status": e.attendance_status,
        "enrolment_status": e.enrolment_status,
        "completed_at": iso(e.completion.completed_at) if e.completion else None,
        "completion_source": e.completion.completion_source if e.completion else None,
        "due_at": iso(current.due_at) if current else None,
        "assessment_state": assessment_state(e.obligations, now),
        "outcome": current.outcome if current else None,
        "retraining_flag": current.retraining_flag if current else "NOT_REQUIRED",
        "obligation_id": str(current.id) if current else None,
    }


@router.get("/enrolments")
def list_enrolments(
    _: CurrentUser = Depends(require_reader),
    db: Session = Depends(get_db),
    training_id: uuid.UUID | None = None,
    batch_id: uuid.UUID | None = None,
    search: str = Query(default="", max_length=120),
    completed: bool | None = None,
) -> dict:
    query = (
        select(Enrolment)
        .join(Enrolment.employee)
        .options(
            selectinload(Enrolment.employee).selectinload(Employee.department),
            selectinload(Enrolment.training),
            selectinload(Enrolment.batch),
            selectinload(Enrolment.completion),
            selectinload(Enrolment.obligations),
        )
        .where(Enrolment.enrolment_status != EnrolmentStatus.CANCELLED)
        .order_by(Employee.full_name)
    )
    if training_id:
        query = query.where(Enrolment.training_id == training_id)
    if batch_id:
        query = query.where(Enrolment.batch_id == batch_id)
    if search:
        query = query.where(Employee.full_name.ilike(f"%{search}%") | Employee.employee_code.ilike(f"%{search}%"))
    rows = db.scalars(query).all()
    if completed is not None:
        rows = [e for e in rows if bool(e.completion) == completed]
    now = utcnow()
    return ok([enrolment_view(e, now) for e in rows])


@router.post("/enrolments")
def assign(body: AssignIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training(db, body.training_id)
    batch = None
    if body.batch_id:
        batch = db.get(TrainingBatch, body.batch_id)
        if batch is None or batch.training_id != training.id:
            raise validation("Choose a batch belonging to the selected training.")
    if body.use_training_target:
        employees = service.targeted_employees(db, training)
    else:
        if not body.employee_ids:
            raise validation("Select at least one employee.")
        employees = list(db.scalars(select(Employee).where(Employee.id.in_(body.employee_ids))))
    result = service.assign_employees(db, training, batch, employees)
    record_audit(db, user.id, "EMPLOYEES_ASSIGNED", "training", training.id, after=result)
    db.commit()
    return ok(result)


def _enrolment(db: Session, enrolment_id: uuid.UUID) -> Enrolment:
    enrolment = db.get(Enrolment, enrolment_id)
    if enrolment is None:
        raise not_found()
    return enrolment


@router.patch("/enrolments/{enrolment_id}/attendance")
def set_attendance(enrolment_id: uuid.UUID, body: AttendanceIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    enrolment = _enrolment(db, enrolment_id)
    before = enrolment.attendance_status
    enrolment.attendance_status = body.attendance_status
    record_audit(db, user.id, "ATTENDANCE_RECORDED", "enrolment", enrolment.id, before={"status": before}, after={"status": body.attendance_status})
    db.commit()
    return ok(enrolment_view(enrolment, utcnow()))


@router.post("/enrolments/{enrolment_id}/completion")
def mark_completed(enrolment_id: uuid.UUID, body: CompletionIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    enrolment = _enrolment(db, enrolment_id)
    calendar = load_calendar(db)
    moment = datetime.combine(body.completion_date, time.min, calendar.tz)
    if body.completion_date == calendar.local_date(utcnow()):
        moment = utcnow()
    service.record_completion(db, enrolment, moment.astimezone(UTC), "MANUAL", user.id)
    record_audit(db, user.id, "COMPLETION_RECORDED", "enrolment", enrolment.id, after={"date": body.completion_date.isoformat()})
    db.commit()
    db.refresh(enrolment)
    return ok(enrolment_view(enrolment, utcnow()))


@router.post("/enrolments/{enrolment_id}/cancel")
def cancel_enrolment(enrolment_id: uuid.UUID, body: ReasonIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    enrolment = _enrolment(db, enrolment_id)
    if enrolment.completion is not None:
        raise conflict("ENROLMENT_COMPLETED", "A completed assignment cannot be cancelled. Its evidence is kept.")
    enrolment.enrolment_status = EnrolmentStatus.CANCELLED
    enrolment.cancel_reason = body.reason
    record_audit(db, user.id, "ENROLMENT_CANCELLED", "enrolment", enrolment.id, reason=body.reason)
    db.commit()
    return ok({"cancelled": True})


# ---------- Exceptions ----------

def _obligation(db: Session, obligation_id: uuid.UUID) -> AssessmentObligation:
    obligation = db.get(AssessmentObligation, obligation_id)
    if obligation is None:
        raise not_found()
    return obligation


@router.post("/obligations/{obligation_id}/waive")
def waive(obligation_id: uuid.UUID, body: ReasonIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """An authorised exemption with a reason. It never marks the assessment as passed (BR §5.9)."""
    obligation = _obligation(db, obligation_id)
    if obligation.status in (ObligationStatus.COMPLETED, ObligationStatus.WAIVED, ObligationStatus.CANCELLED):
        raise conflict("OBLIGATION_CLOSED", "This assessment is already closed.")
    if obligation.status == ObligationStatus.IN_PROGRESS:
        raise conflict("ATTEMPT_IN_PROGRESS", "An attempt is in progress. Wait for it to finish.")
    obligation.status = ObligationStatus.WAIVED
    obligation.waived_at = utcnow()
    obligation.waiver_reason = body.reason
    record_audit(db, user.id, "ASSESSMENT_WAIVED", "assessment_obligation", obligation.id, reason=body.reason)
    db.commit()
    return ok({"status": obligation.status})


@router.post("/obligations/{obligation_id}/retraining-cycle")
def start_retraining_cycle(obligation_id: uuid.UUID, body: ReasonIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """After re-training, opens a new assessment cycle. The original failure record is kept (BR §9.6)."""
    obligation = _obligation(db, obligation_id)
    if obligation.retraining_flag != RetrainingFlag.NEEDS_RETRAINING:
        raise conflict("NOT_FLAGGED", "This record is not flagged Needs Re-training.")
    config = active_config(db, obligation.training_id, AssessmentType.POST_TEST)
    if config is None:
        raise conflict("NOT_CONFIGURED", "This training has no active assessment configuration.")
    now = utcnow()
    obligation.retraining_flag = RetrainingFlag.RESOLVED
    new_cycle = AssessmentObligation(
        enrolment_id=obligation.enrolment_id,
        employee_id=obligation.employee_id,
        training_id=obligation.training_id,
        config_id=config.id,
        assessment_type=AssessmentType.POST_TEST,
        cycle_number=obligation.cycle_number + 1,
        status=ObligationStatus.DUE,
        completed_training_at=now,
        due_at=now,
    )
    db.add(new_cycle)
    db.flush()
    notify_employee(db, obligation.employee_id, "RETAKE_ASSIGNED", f"New assessment cycle: {obligation.training.title}", "L&D has opened a new assessment after your re-training.", "/employee/assessments", f"retraining:{new_cycle.id}", now)
    record_audit(db, user.id, "RETRAINING_CYCLE_STARTED", "assessment_obligation", new_cycle.id, reason=body.reason, before={"cycle": obligation.cycle_number}, after={"cycle": new_cycle.cycle_number})
    db.commit()
    return ok({"obligation_id": str(new_cycle.id), "cycle_number": new_cycle.cycle_number})

