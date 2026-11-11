"""All TrainCheck tables. Physical schema lives in migrations/; this file is the reference.

Scope change SC-2L: there are deliberately no Level 1 Reaction or Level 4 KPI/ROI tables.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ---------- Organisation ----------

class Department(Base, Timestamped):
    __tablename__ = "departments"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Function(Base, Timestamped):
    """A business function such as Sales or Compliance. Independent of department (SC-2L-103)."""

    __tablename__ = "functions"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Location(Base):
    __tablename__ = "locations"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    timezone: Mapped[str] = mapped_column(String(60), default="Asia/Kolkata")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class WorkingCalendar(Base, Timestamped):
    """Configurable working week and timezone. Not a Finvasia policy until approved (OD-BRD-004)."""

    __tablename__ = "working_calendars"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    timezone: Mapped[str] = mapped_column(String(60))
    working_weekdays: Mapped[list[int]] = mapped_column(JSON)  # Python weekday numbers: Monday is 0.
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    holidays: Mapped[list["CalendarHoliday"]] = relationship(cascade="all, delete-orphan")
    __table_args__ = (Index("uq_one_default_calendar", "is_default", unique=True, postgresql_where=text("is_default")),)


class CalendarHoliday(Base):
    __tablename__ = "calendar_holidays"
    id: Mapped[uuid.UUID] = uuid_pk()
    calendar_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("working_calendars.id", ondelete="CASCADE"))
    holiday_date: Mapped[date] = mapped_column(Date)
    name: Mapped[str] = mapped_column(String(120), default="Holiday")
    __table_args__ = (UniqueConstraint("calendar_id", "holiday_date"),)


class Employee(Base, Timestamped):
    __tablename__ = "employees"
    id: Mapped[uuid.UUID] = uuid_pk()
    employee_code: Mapped[str] = mapped_column(String(40), unique=True)
    full_name: Mapped[str] = mapped_column(String(160))
    work_email: Mapped[str] = mapped_column(String(254), unique=True)
    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id"), index=True)
    function_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("functions.id"), index=True)
    location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("locations.id"), index=True)
    grade: Mapped[str | None] = mapped_column(String(40), index=True)
    employment_status: Mapped[str] = mapped_column(String(20), default="ACTIVE", index=True)
    department: Mapped[Department | None] = relationship()
    function: Mapped[Function | None] = relationship()
    location: Mapped[Location | None] = relationship()


class ManagerAssignment(Base):
    """Effective-dated reporting line. A manager's team always comes from this table."""

    __tablename__ = "manager_assignments"
    id: Mapped[uuid.UUID] = uuid_pk()
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"))
    manager_employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"))
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = created_at()
    __table_args__ = (
        CheckConstraint("employee_id <> manager_employee_id", name="ck_manager_not_self"),
        Index("uq_one_open_manager", "employee_id", unique=True, postgresql_where=text("effective_to IS NULL")),
        Index("ix_manager_scope", "manager_employee_id", "effective_from", "effective_to"),
    )


# ---------- Identity ----------

class UserAccount(Base, Timestamped):
    __tablename__ = "user_accounts"
    id: Mapped[uuid.UUID] = uuid_pk()
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), unique=True)
    login_email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    account_status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    employee: Mapped[Employee] = relationship()
    role_links: Mapped[list["UserRole"]] = relationship(cascade="all, delete-orphan", foreign_keys="UserRole.user_account_id")


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(30), unique=True)
    name: Mapped[str] = mapped_column(String(80))


class UserRole(Base):
    __tablename__ = "user_roles"
    user_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"), primary_key=True)
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    assigned_at: Mapped[datetime] = created_at()
    role: Mapped[Role] = relationship()


class UserSession(Base):
    """Server-managed sessions. Only hashes of the session token are stored."""

    __tablename__ = "user_sessions"
    id: Mapped[uuid.UUID] = uuid_pk()
    user_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    session_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserIdentity(Base):
    """SSO integration point. Stays empty until Finvasia approves a provider."""

    __tablename__ = "user_identities"
    id: Mapped[uuid.UUID] = uuid_pk()
    user_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    provider: Mapped[str] = mapped_column(String(40))
    subject: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = created_at()
    __table_args__ = (UniqueConstraint("provider", "subject"),)


class AuthAttempt(Base):
    """Failed sign-ins, used for database-backed rate limiting. No raw email address is stored."""

    __tablename__ = "auth_attempts"
    id: Mapped[uuid.UUID] = uuid_pk()
    key_hash: Mapped[str] = mapped_column(String(64))
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (Index("ix_auth_attempts_key_time", "key_hash", "attempted_at"),)


# ---------- Training ----------

class Trainer(Base, Timestamped):
    __tablename__ = "trainers"
    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(160))
    email: Mapped[str | None] = mapped_column(String(254))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Competency(Base):
    __tablename__ = "competencies"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(60), unique=True)
    name: Mapped[str] = mapped_column(String(160), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Training(Base, Timestamped):
    __tablename__ = "trainings"
    id: Mapped[uuid.UUID] = uuid_pk()
    training_code: Mapped[str] = mapped_column(String(40), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(120))
    owner_employee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("employees.id"))
    trainer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trainers.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT", index=True)
    target_scope: Mapped[str] = mapped_column(String(20), default="COMMON")
    refresher_text: Mapped[str | None] = mapped_column(Text)
    refresher_url: Mapped[str | None] = mapped_column(String(500))
    pretest_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    behaviour_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    followup_days: Mapped[list[int]] = mapped_column(JSON, default=lambda: [30, 60, 90])
    item_minimum_sample: Mapped[int] = mapped_column(Integer, default=10)
    owner: Mapped[Employee | None] = relationship()
    trainer: Mapped[Trainer | None] = relationship()
    departments: Mapped[list[Department]] = relationship(secondary="training_departments")
    functions: Mapped[list[Function]] = relationship(secondary="training_functions")
    competencies: Mapped[list[Competency]] = relationship(secondary="training_competencies")
    materials: Mapped[list["TrainingMaterial"]] = relationship(cascade="all, delete-orphan")
    batches: Mapped[list["TrainingBatch"]] = relationship(back_populates="training")


class TrainingDepartment(Base):
    __tablename__ = "training_departments"
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id", ondelete="CASCADE"), primary_key=True)
    department_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("departments.id"), primary_key=True)


class TrainingFunction(Base):
    __tablename__ = "training_functions"
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id", ondelete="CASCADE"), primary_key=True)
    function_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("functions.id"), primary_key=True)


class TrainingCompetency(Base):
    __tablename__ = "training_competencies"
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id", ondelete="CASCADE"), primary_key=True)
    competency_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("competencies.id"), primary_key=True)


class TrainingMaterial(Base):
    __tablename__ = "training_materials"
    id: Mapped[uuid.UUID] = uuid_pk()
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="LINK")
    title: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = created_at()


class TrainingBatch(Base):
    __tablename__ = "training_batches"
    id: Mapped[uuid.UUID] = uuid_pk()
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    batch_code: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(160))
    trainer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trainers.id"))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    created_at: Mapped[datetime] = created_at()
    training: Mapped[Training] = relationship(back_populates="batches")
    trainer: Mapped[Trainer | None] = relationship()
    sessions: Mapped[list["TrainingSession"]] = relationship(cascade="all, delete-orphan")
    __table_args__ = (UniqueConstraint("training_id", "batch_code"),)


class TrainingSession(Base):
    __tablename__ = "training_sessions"
    id: Mapped[uuid.UUID] = uuid_pk()
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("training_batches.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    session_date: Mapped[date] = mapped_column(Date)
    delivery_mode: Mapped[str | None] = mapped_column(String(40))
    venue: Mapped[str | None] = mapped_column(String(160))


class Enrolment(Base, Timestamped):
    __tablename__ = "enrolments"
    id: Mapped[uuid.UUID] = uuid_pk()
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("training_batches.id"), index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), index=True)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attendance_status: Mapped[str] = mapped_column(String(20), default="PENDING")
    enrolment_status: Mapped[str] = mapped_column(String(20), default="ASSIGNED")
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    training: Mapped[Training] = relationship()
    batch: Mapped[TrainingBatch | None] = relationship()
    employee: Mapped[Employee] = relationship()
    completion: Mapped["TrainingCompletion | None"] = relationship(back_populates="enrolment", uselist=False)
    obligations: Mapped[list["AssessmentObligation"]] = relationship(back_populates="enrolment")
    __table_args__ = (
        Index("uq_active_enrolment", "employee_id", "training_id", unique=True, postgresql_where=text("enrolment_status <> 'CANCELLED'")),
    )


class TrainingCompletion(Base):
    __tablename__ = "training_completions"
    id: Mapped[uuid.UUID] = uuid_pk()
    enrolment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("enrolments.id"), unique=True)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completion_source: Mapped[str] = mapped_column(String(20))  # MANUAL or IMPORT
    source_event_id: Mapped[str | None] = mapped_column(String(160), unique=True)
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    import_job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("import_jobs.id"))
    correction_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()
    enrolment: Mapped[Enrolment] = relationship(back_populates="completion")


# ---------- Question bank ----------

class Question(Base, Timestamped):
    __tablename__ = "questions"
    id: Mapped[uuid.UUID] = uuid_pk()
    question_code: Mapped[str] = mapped_column(String(60), unique=True)
    topic: Mapped[str] = mapped_column(String(160), index=True)
    competency_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("competencies.id"), index=True)
    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id"), index=True)  # Null means common.
    function_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("functions.id"), index=True)  # Null means common.
    question_type: Mapped[str] = mapped_column(String(20))
    question_text: Mapped[str] = mapped_column(Text)
    explanation: Mapped[str | None] = mapped_column(Text)
    difficulty: Mapped[str] = mapped_column(String(10), index=True)
    language: Mapped[str] = mapped_column(String(20), default="English")
    marks: Mapped[Decimal] = mapped_column(Numeric(6, 2))
    status: Mapped[str] = mapped_column(String(10), default="ACTIVE", index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    randomise_options: Mapped[bool] = mapped_column(Boolean, default=True)  # False for "All of the above" and similar.
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    competency: Mapped[Competency | None] = relationship()
    department: Mapped[Department | None] = relationship()
    function: Mapped[Function | None] = relationship()
    options: Mapped[list["QuestionOption"]] = relationship(cascade="all, delete-orphan", order_by="QuestionOption.display_order")
    trainings: Mapped[list[Training]] = relationship(secondary="question_training_tags")
    __table_args__ = (CheckConstraint("marks > 0", name="ck_question_marks_positive"),)


class QuestionOption(Base):
    __tablename__ = "question_options"
    id: Mapped[uuid.UUID] = uuid_pk()
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), index=True)
    option_text: Mapped[str] = mapped_column(Text)
    display_order: Mapped[int] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class QuestionAnswerKey(Base):
    """Correct answers. Read only by scoring and authorised question-bank administration."""

    __tablename__ = "question_answer_keys"
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), primary_key=True)
    option_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("question_options.id", ondelete="CASCADE"), primary_key=True)


class QuestionTrainingTag(Base):
    __tablename__ = "question_training_tags"
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), primary_key=True)
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id", ondelete="CASCADE"), primary_key=True, index=True)


class QuestionRevision(Base):
    __tablename__ = "question_revisions"
    id: Mapped[uuid.UUID] = uuid_pk()
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    content_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    changed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    created_at: Mapped[datetime] = created_at()
    __table_args__ = (UniqueConstraint("question_id", "version"),)


# ---------- Assessment ----------

class AssessmentConfig(Base):
    __tablename__ = "assessment_configs"
    id: Mapped[uuid.UUID] = uuid_pk()
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    assessment_type: Mapped[str] = mapped_column(String(10))
    version: Mapped[int] = mapped_column(Integer)
    question_count: Mapped[int] = mapped_column(Integer)
    duration_seconds: Mapped[int] = mapped_column(Integer)
    pass_mark_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("70"))
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    schedule_mode: Mapped[str] = mapped_column(String(20), default="NEXT_WORKING_DAY")
    schedule_delay_days: Mapped[int] = mapped_column(Integer, default=0)
    schedule_uses_working_days: Mapped[bool] = mapped_column(Boolean, default=False)
    difficulty_mix: Mapped[dict[str, int] | None] = mapped_column(JSON)  # {"EASY": 4, "MEDIUM": 4, "HARD": 2}
    show_explanations: Mapped[bool] = mapped_column(Boolean, default=False)
    shuffle_questions: Mapped[bool] = mapped_column(Boolean, default=True)
    shuffle_options: Mapped[bool] = mapped_column(Boolean, default=True)
    violation_limit: Mapped[int] = mapped_column(Integer, default=3)
    require_fullscreen: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    created_at: Mapped[datetime] = created_at()
    training: Mapped[Training] = relationship()
    __table_args__ = (
        UniqueConstraint("training_id", "assessment_type", "version"),
        Index("uq_active_config", "training_id", "assessment_type", unique=True, postgresql_where=text("is_active")),
        CheckConstraint("question_count > 0", name="ck_config_question_count"),
        CheckConstraint("duration_seconds > 0", name="ck_config_duration"),
        CheckConstraint("pass_mark_percent >= 0 AND pass_mark_percent <= 100", name="ck_config_pass_mark"),
        CheckConstraint("max_attempts > 0", name="ck_config_attempts"),
        CheckConstraint("violation_limit > 0", name="ck_config_violations"),
    )


class AssessmentObligation(Base, Timestamped):
    __tablename__ = "assessment_obligations"
    id: Mapped[uuid.UUID] = uuid_pk()
    enrolment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("enrolments.id"), index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), index=True)
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    config_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_configs.id"))
    assessment_type: Mapped[str] = mapped_column(String(10))
    cycle_number: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(20), index=True)
    completed_training_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # Queue ordering.
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    schedule_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    retake_eligible_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refresher_acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(20))
    retraining_flag: Mapped[str] = mapped_column(String(20), default="NOT_REQUIRED", index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    waived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    waiver_reason: Mapped[str | None] = mapped_column(Text)
    enrolment: Mapped[Enrolment] = relationship(back_populates="obligations")
    employee: Mapped[Employee] = relationship()
    training: Mapped[Training] = relationship()
    config: Mapped[AssessmentConfig] = relationship()
    attempts: Mapped[list["AssessmentAttempt"]] = relationship(back_populates="obligation", order_by="AssessmentAttempt.attempt_number")
    __table_args__ = (UniqueConstraint("enrolment_id", "assessment_type", "cycle_number", name="uq_obligation_cycle"),)


class AssessmentAttempt(Base):
    __tablename__ = "assessment_attempts"
    id: Mapped[uuid.UUID] = uuid_pk()
    obligation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_obligations.id"), index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), index=True)
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    assessment_type: Mapped[str] = mapped_column(String(10))
    attempt_number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submission_reason: Mapped[str | None] = mapped_column(String(20))
    obtained_marks: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    total_marks: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    score_percent: Mapped[Decimal | None] = mapped_column(Numeric(10, 6))  # Truncated, never rounded up.
    result_status: Mapped[str | None] = mapped_column(String(20), index=True)
    config_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    violation_count: Mapped[int] = mapped_column(Integer, default=0)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()
    obligation: Mapped[AssessmentObligation] = relationship(back_populates="attempts")
    employee: Mapped[Employee] = relationship()
    training: Mapped[Training] = relationship()
    questions: Mapped[list["AttemptQuestion"]] = relationship(back_populates="attempt", order_by="AttemptQuestion.display_order")
    security_events: Mapped[list["AttemptSecurityEvent"]] = relationship(order_by="AttemptSecurityEvent.occurred_at")
    __table_args__ = (
        UniqueConstraint("obligation_id", "attempt_number", name="uq_attempt_number"),
        Index("uq_one_active_attempt_per_employee_training", "employee_id", "training_id", unique=True, postgresql_where=text("status = 'IN_PROGRESS'")),
    )


class AttemptQuestion(Base):
    """The exact question shown. The two *_snapshot key fields are server-only: no schema may expose them before submission."""

    __tablename__ = "attempt_questions"
    id: Mapped[uuid.UUID] = uuid_pk()
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_attempts.id"), index=True)
    question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("questions.id"), index=True)
    question_version: Mapped[int] = mapped_column(Integer)
    display_order: Mapped[int] = mapped_column(Integer)
    question_text_snapshot: Mapped[str] = mapped_column(Text)
    question_type_snapshot: Mapped[str] = mapped_column(String(20))
    topic_snapshot: Mapped[str] = mapped_column(String(160))
    competency_snapshot: Mapped[str | None] = mapped_column(String(160))
    difficulty_snapshot: Mapped[str] = mapped_column(String(10))
    language_snapshot: Mapped[str] = mapped_column(String(20))
    options_snapshot: Mapped[list[dict[str, str]]] = mapped_column(JSON)  # [{"option_id", "label", "text"}] with no correct flag.
    marks_snapshot: Mapped[Decimal] = mapped_column(Numeric(6, 2))
    answer_key_snapshot: Mapped[list[str]] = mapped_column(JSON)
    explanation_snapshot: Mapped[str | None] = mapped_column(Text)
    attempt: Mapped[AssessmentAttempt] = relationship(back_populates="questions")
    answer: Mapped["AttemptAnswer | None"] = relationship(uselist=False)
    __table_args__ = (UniqueConstraint("attempt_id", "display_order"),)


class AttemptAnswer(Base):
    __tablename__ = "attempt_answers"
    id: Mapped[uuid.UUID] = uuid_pk()
    attempt_question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("attempt_questions.id"), unique=True)
    selected_option_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    marked_for_review: Mapped[bool] = mapped_column(Boolean, default=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_correct: Mapped[bool | None] = mapped_column(Boolean)  # Set only at finalisation.
    marks_awarded: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))


class AttemptSecurityEvent(Base):
    __tablename__ = "attempt_security_events"
    id: Mapped[uuid.UUID] = uuid_pk()
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_attempts.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(30))
    signals: Mapped[list[str]] = mapped_column(JSON, default=list)
    violation_number: Mapped[int | None] = mapped_column(Integer)  # Null for interruptions.
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefresherAcknowledgement(Base):
    __tablename__ = "refresher_acknowledgements"
    id: Mapped[uuid.UUID] = uuid_pk()
    obligation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assessment_obligations.id"), index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"))
    attempts_at_time: Mapped[int] = mapped_column(Integer)
    acknowledged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("obligation_id", "attempts_at_time"),)


# ---------- Level 3 Behaviour ----------

class BehaviourTemplate(Base, Timestamped):
    __tablename__ = "behaviour_templates"
    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(String(60))
    version: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(200))
    training_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trainings.id"), index=True)
    function_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("functions.id"), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"))
    training: Mapped[Training | None] = relationship()
    function: Mapped[Function | None] = relationship()
    questions: Mapped[list["BehaviourTemplateQuestion"]] = relationship(cascade="all, delete-orphan", order_by="BehaviourTemplateQuestion.display_order")
    __table_args__ = (
        UniqueConstraint("code", "version"),
        Index("uq_active_template_version", "code", unique=True, postgresql_where=text("is_active")),
    )


class BehaviourTemplateQuestion(Base):
    __tablename__ = "behaviour_template_questions"
    id: Mapped[uuid.UUID] = uuid_pk()
    template_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("behaviour_templates.id", ondelete="CASCADE"), index=True)
    competency_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("competencies.id"))
    prompt: Mapped[str] = mapped_column(Text)
    example_required: Mapped[bool] = mapped_column(Boolean, default=True)
    display_order: Mapped[int] = mapped_column(Integer)
    competency: Mapped[Competency] = relationship()


class BehaviourReviewCycle(Base):
    __tablename__ = "behaviour_review_cycles"
    id: Mapped[uuid.UUID] = uuid_pk()
    enrolment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("enrolments.id"), index=True)
    employee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("employees.id"), index=True)
    training_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trainings.id"), index=True)
    template_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("behaviour_templates.id"))
    period_days: Mapped[int] = mapped_column(Integer)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = created_at()
    employee: Mapped[Employee] = relationship()
    training: Mapped[Training] = relationship()
    template: Mapped[BehaviourTemplate] = relationship()
    reviews: Mapped[list["BehaviourReview"]] = relationship(back_populates="cycle")
    __table_args__ = (UniqueConstraint("enrolment_id", "period_days"),)


class BehaviourReview(Base):
    """BehaviourReviewL3: one self-assessment or one manager observation in a cycle."""

    __tablename__ = "behaviour_reviews"
    id: Mapped[uuid.UUID] = uuid_pk()
    cycle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("behaviour_review_cycles.id"), index=True)
    reviewer_type: Mapped[str] = mapped_column(String(10))
    assigned_reviewer_employee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("employees.id"), index=True)
    submitted_by_employee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("employees.id"))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled: Mapped[bool] = mapped_column(Boolean, default=False)
    cycle: Mapped[BehaviourReviewCycle] = relationship(back_populates="reviews")
    assigned_reviewer: Mapped[Employee | None] = relationship(foreign_keys=[assigned_reviewer_employee_id])
    submitted_by: Mapped[Employee | None] = relationship(foreign_keys=[submitted_by_employee_id])
    responses: Mapped[list["BehaviourReviewResponse"]] = relationship(cascade="all, delete-orphan")
    __table_args__ = (UniqueConstraint("cycle_id", "reviewer_type"),)


class BehaviourReviewResponse(Base):
    __tablename__ = "behaviour_review_responses"
    id: Mapped[uuid.UUID] = uuid_pk()
    review_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("behaviour_reviews.id", ondelete="CASCADE"), index=True)
    template_question_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("behaviour_template_questions.id"))
    competency_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("competencies.id"), index=True)
    rating: Mapped[int] = mapped_column(Integer)
    example_text: Mapped[str | None] = mapped_column(Text)
    comment_text: Mapped[str | None] = mapped_column(Text)
    competency: Mapped[Competency] = relationship()
    template_question: Mapped[BehaviourTemplateQuestion] = relationship()
    __table_args__ = (
        UniqueConstraint("review_id", "template_question_id"),
        CheckConstraint("rating BETWEEN 1 AND 5", name="ck_behaviour_rating_range"),
    )


# ---------- Notifications, audit, imports, reports ----------

class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = uuid_pk()
    user_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    message: Mapped[str] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(300))
    dedupe_key: Mapped[str | None] = mapped_column(String(200))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("user_account_id", "dedupe_key", name="uq_notification_once"),)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[uuid.UUID] = uuid_pk()
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    action: Mapped[str] = mapped_column(String(80), index=True)
    target_type: Mapped[str | None] = mapped_column(String(60))
    target_id: Mapped[str | None] = mapped_column(String(80))
    reason: Mapped[str | None] = mapped_column(Text)
    before_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    after_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    request_id: Mapped[str | None] = mapped_column(String(40))
    ip_address: Mapped[str | None] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    actor: Mapped[UserAccount | None] = relationship()


class ImportJob(Base):
    __tablename__ = "import_jobs"
    id: Mapped[uuid.UUID] = uuid_pk()
    import_type: Mapped[str] = mapped_column(String(20))
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"))
    file_name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(30), index=True)
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    accepted_rows: Mapped[int] = mapped_column(Integer, default=0)
    rejected_rows: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rows: Mapped[list["ImportJobRow"]] = relationship(cascade="all, delete-orphan", order_by="ImportJobRow.row_number")


class ImportJobRow(Base):
    __tablename__ = "import_job_rows"
    id: Mapped[uuid.UUID] = uuid_pk()
    import_job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_jobs.id", ondelete="CASCADE"), index=True)
    row_number: Mapped[int] = mapped_column(Integer)
    row_status: Mapped[str] = mapped_column(String(20))  # VALID, INVALID, DUPLICATE, IMPORTED
    record_label: Mapped[str | None] = mapped_column(String(200))
    errors: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class FileArtifact(Base):
    """A private file on disk. Downloaded only through permission-checked endpoints."""

    __tablename__ = "file_artifacts"
    id: Mapped[uuid.UUID] = uuid_pk()
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    storage_key: Mapped[str] = mapped_column(String(120), unique=True)
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    purpose: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = created_at()


class ReportExport(Base):
    __tablename__ = "report_exports"
    id: Mapped[uuid.UUID] = uuid_pk()
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    report_code: Mapped[str] = mapped_column(String(30))
    export_format: Mapped[str] = mapped_column(String(10))
    filters: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20))
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("file_artifacts.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    artifact: Mapped[FileArtifact | None] = relationship()


class ReportSchedule(Base, Timestamped):
    __tablename__ = "report_schedules"
    id: Mapped[uuid.UUID] = uuid_pk()
    owner_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    report_code: Mapped[str] = mapped_column(String(30))
    export_format: Mapped[str] = mapped_column(String(10))
    filters: Mapped[dict[str, Any]] = mapped_column(JSON)
    cadence: Mapped[str] = mapped_column(String(10))
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    deliveries: Mapped[list["ReportDelivery"]] = relationship(order_by="ReportDelivery.run_at.desc()")


class RateLimitCounter(Base):
    """Shared request counters, used only when RATE_LIMIT_STORE=database. Keys are SHA-256 hashes."""

    __tablename__ = "rate_limit_counters"
    key_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True, index=True)
    count: Mapped[int] = mapped_column(Integer, default=0)


class ReportDelivery(Base):
    __tablename__ = "report_deliveries"
    id: Mapped[uuid.UUID] = uuid_pk()
    schedule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("report_schedules.id"), index=True)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20))
    export_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("report_exports.id"))
    error: Mapped[str | None] = mapped_column(String(300))
    __table_args__ = (UniqueConstraint("schedule_id", "run_at"),)
