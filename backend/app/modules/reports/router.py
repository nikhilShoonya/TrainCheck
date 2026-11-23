"""Reports, scorecards, exports and scheduled delivery. Permission and scope are re-applied every time."""
import logging
import uuid
from calendar import monthrange
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta, tzinfo

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.orm import Session, joinedload, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_gate_clear
from app.core.display import filename_stamp
from app.core.enums import AccountStatus, Cadence, DeliveryStatus, EmploymentStatus, EnrolmentStatus, ExportFormat, ExportStatus, ReportCode, RoleCode
from app.core.errors import forbidden, not_found, validation
from app.core.ratelimit import expensive
from app.core.responses import iso, ok
from app.core.routing import ReleasingRoute
from app.models import Department, Employee, Enrolment, Function, Location, ReportDelivery, ReportExport, ReportSchedule, Trainer, Training, TrainingBatch, UserAccount
from app.modules.assessment.scheduling import load_calendar
from app.modules.notifications.service import notify_account
from app.modules.reports import exports
from app.modules.reports.catalogue import BUILDERS, Report
from app.modules.reports.data import ReportFilters, behaviour_reviews, departments_summary, employee_scope, load_rows, mean, monthly_trend, summary
from app.modules.reports.scorecard import build_scorecard, question_performance

router = APIRouter(route_class=ReleasingRoute, tags=["Reports"])
logger = logging.getLogger("traincheck.reports")


def filters_dep(
    date_from: date | None = None,
    date_to: date | None = None,
    department_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    training_id: uuid.UUID | None = None,
    trainer_id: uuid.UUID | None = None,
    batch_id: uuid.UUID | None = None,
    grade: str | None = None,
    function_id: uuid.UUID | None = None,
) -> ReportFilters:
    return checked(ReportFilters(date_from, date_to, department_id, location_id, training_id, trainer_id, batch_id, grade or None, function_id))


def checked(filters: ReportFilters) -> ReportFilters:
    if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
        raise validation("The start date is after the end date. Choose a start date on or before the end date.")
    return filters


def parse_stored_filters(data: dict) -> ReportFilters:
    """Filters sent in a request body (exports, schedules): a bad value is a validation error, never a 500."""
    try:
        filters = ReportFilters.from_stored(data)
    except (ValueError, TypeError) as exc:
        raise validation("A report filter is not valid.") from exc
    return checked(filters)


def resolve_scope(db: Session, user: CurrentUser, code: ReportCode) -> list[uuid.UUID] | None:
    """L&D Admin gets the organisation. Employees have no report access (Assessment History was removed)."""
    if user.has_role(RoleCode.LD_ADMIN):
        return employee_scope(db, user)
    raise forbidden()


def build_report(db: Session, user: CurrentUser, code: ReportCode, filters: ReportFilters) -> Report:
    return BUILDERS[code](db, load_rows(db, resolve_scope(db, user, code), filters))


def scope_label(user: CurrentUser) -> str:
    if user.has_role(RoleCode.LD_ADMIN):
        return "Organisation"
    return f"Own record: {user.employee.full_name}"


def report_view(report: Report, filters: ReportFilters) -> dict:
    return {
        "code": report.code,
        "title": report.title,
        "description": report.description,
        "columns": report.columns,
        "rows": report.rows,
        "definitions": report.definitions,
        "filters": filters.stored(),
        "generated_at": iso(utcnow()),
    }


# ---------- Read ----------

@router.get("/reports/catalogue")
def catalogue(user: CurrentUser = Depends(require_gate_clear)) -> dict:
    from app.modules.reports.catalogue import TITLES

    codes = list(ReportCode) if user.has_role(RoleCode.LD_ADMIN) else []
    return ok([{"code": c.value, "title": TITLES[c][0], "description": TITLES[c][1]} for c in codes])


def _live_enrolment(*join_on):
    """Live (not cancelled) assignments, the population every report covers."""
    return (Enrolment.enrolment_status != EnrolmentStatus.CANCELLED, *join_on)


@router.get("/reports/filter-options")
def filter_options(user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Dropdown values drawn only from data the caller may see: names only, never every record (audit F-12)."""
    employee_scope(db, user)  # Organisation-wide for L&D Admin; refuses anyone else.

    def named(model, link) -> list[dict]:
        rows = db.execute(select(model.id, model.name).join(Employee, link).join(Enrolment, Enrolment.employee_id == Employee.id).where(*_live_enrolment()).distinct()).all()
        return [{"id": str(i), "name": name} for i, name in sorted(rows, key=lambda r: (r[1], str(r[0])))]

    trainings = db.execute(select(Training.id, Training.title).join(Enrolment, Enrolment.training_id == Training.id).where(*_live_enrolment()).distinct()).all()
    trainers = db.execute(
        select(Trainer.id, Trainer.name).join(Training, Training.trainer_id == Trainer.id).join(Enrolment, Enrolment.training_id == Training.id).where(*_live_enrolment()).distinct()
    ).all()
    batches = db.execute(select(TrainingBatch.id, TrainingBatch.name).join(Enrolment, Enrolment.batch_id == TrainingBatch.id).where(*_live_enrolment()).distinct()).all()
    grades = db.scalars(select(Employee.grade).join(Enrolment, Enrolment.employee_id == Employee.id).where(*_live_enrolment(), Employee.grade.is_not(None)).distinct()).all()
    return ok(
        {
            "departments": named(Department, Department.id == Employee.department_id),
            "locations": named(Location, Location.id == Employee.location_id),
            "trainings": [{"id": str(i), "name": t} for i, t in sorted(trainings, key=lambda r: (r[1], str(r[0])))],
            "trainers": [{"id": str(i), "name": n} for i, n in sorted(trainers, key=lambda r: (r[1], str(r[0])))],
            "batches": [{"id": str(i), "name": n} for i, n in sorted(batches, key=lambda r: (r[1], str(r[0])))],
            "grades": sorted(g for g in grades if g),
        }
    )


@router.get("/reports/organisation-summary")
def organisation_summary(user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    rows = load_rows(db, employee_scope(db, user))
    return ok({"summary": summary(rows), "departments": departments_summary(rows), "trend": monthly_trend(rows, utcnow(), load_calendar(db).tz)})


def _training_in_scope(db: Session, training_id: uuid.UUID) -> Training:
    training = db.get(Training, training_id)
    if training is None:
        raise not_found()
    return training


@router.get("/scorecards")
def list_scorecards(user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    employee_scope(db, user)
    rows = db.execute(
        select(Training.id, Training.title, Training.training_code).join(Enrolment, Enrolment.training_id == Training.id).where(*_live_enrolment()).distinct()
    ).all()
    return ok([{"id": str(i), "title": title, "code": code} for i, title, code in sorted(rows, key=lambda r: (r[1], str(r[0])))])


@router.get("/scorecards/{training_id}", dependencies=[expensive("report")])
def scorecard(training_id: uuid.UUID, filters: ReportFilters = Depends(filters_dep), user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    training = _training_in_scope(db, training_id)
    filters.training_id = training_id
    return ok(build_scorecard(db, training, load_rows(db, employee_scope(db, user), filters)))


# ---------- Analytics pages ----------

@router.get("/reports/analytics", dependencies=[expensive("report")])
def analytics(filters: ReportFilters = Depends(filters_dep), user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """Department and function comparison, topic gaps and behaviour trend (Phase 3)."""
    rows = load_rows(db, employee_scope(db, user), filters)
    groups: dict[str, list] = defaultdict(list)
    # Functions for every employee in one query (reading employee.function per row ran one query per function).
    function_ids = {r.enrolment.employee.function_id for r in rows if r.enrolment.employee.function_id}
    function_names = dict(db.execute(select(Function.id, Function.name).where(Function.id.in_(function_ids))).all()) if function_ids else {}
    for r in rows:
        groups[function_names.get(r.enrolment.employee.function_id, "Unassigned")].append(r)
    topics, weakest = question_performance(db, rows)
    reviews = behaviour_reviews(db, [r.enrolment.id for r in rows])
    periods: dict[int, dict[str, list[int]]] = defaultdict(lambda: {"SELF": [], "MANAGER": []})
    for review in reviews:
        periods[review.cycle.period_days][review.reviewer_type] += [x.rating for x in review.responses]
    return ok(
        {
            "summary": summary(rows),
            "departments": departments_summary(rows),
            "functions": [{"function": name, **summary(group)} for name, group in sorted(groups.items())],
            "topics": sorted(topics, key=lambda t: t["score"] if t["score"] is not None else 0),
            "weakest_questions": weakest,
            "behaviour_trend": [{"period_days": days, "self_mean": mean(v["SELF"]), "manager_mean": mean(v["MANAGER"]), "self_count": len(v["SELF"]), "manager_count": len(v["MANAGER"])} for days, v in sorted(periods.items())],
            "trend": monthly_trend(rows, utcnow(), load_calendar(db).tz),
        }
    )


# ---------- Exports ----------

class ExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_code: ReportCode
    export_format: ExportFormat
    filters: dict[str, str] = {}
    own_record: bool = False  # Retired with Assessment History: True is refused (403).


def run_export(db: Session, user: CurrentUser, code: ReportCode, fmt: ExportFormat, filters: ReportFilters, own_record: bool = False) -> ReportExport:
    report = BUILDERS[code](db, load_rows(db, [user.employee_id], filters)) if own_record else build_report(db, user, code, filters)
    now = utcnow()
    content = exports.RENDERERS[fmt](report, filters.stored(), now, scope_label(user))
    file_name = f"traincheck-{code.value}-{filename_stamp(now)}.{fmt.value.lower()}"
    artifact = exports.store_file(db, user.id, file_name, content, exports.CONTENT_TYPES[fmt], "REPORT_EXPORT")
    record = ReportExport(owner_user_id=user.id, report_code=code, export_format=fmt, filters=filters.stored(), status=ExportStatus.READY, row_count=len(report.rows), artifact_id=artifact.id, created_at=now)
    db.add(record)
    db.flush()
    record_audit(db, user.id, "REPORT_EXPORTED", "report_export", record.id, after={"report": code.value, "format": fmt.value, "rows": len(report.rows), "filters": filters.stored()})
    return record


def export_view(record: ReportExport) -> dict:
    return {
        "id": str(record.id),
        "report_code": record.report_code,
        "export_format": record.export_format,
        "filters": record.filters,
        "status": record.status,
        "row_count": record.row_count,
        "file_name": record.artifact.file_name if record.artifact else None,
        "created_at": iso(record.created_at),
    }


@router.post("/reports/exports", dependencies=[expensive("export")])
def create_export(body: ExportIn, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    filters = parse_stored_filters(body.filters)
    if body.own_record:  # The personal history export belonged to the removed Assessment History page.
        raise forbidden("Personal history exports are no longer available.")
    record = run_export(db, user, body.report_code, body.export_format, filters, body.own_record)
    db.commit()
    return ok(export_view(record))


@router.get("/reports/exports")
def list_exports(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    # The file names come with the list in one query; loading each export's file separately cost a round trip each.
    records = db.scalars(select(ReportExport).options(joinedload(ReportExport.artifact)).where(ReportExport.owner_user_id == user.id).order_by(ReportExport.created_at.desc()).limit(100)).all()
    return ok([export_view(r) for r in records])


@router.get("/reports/exports/{export_id}/download")
def download_export(export_id: uuid.UUID, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> Response:
    """Owner only. Current role is checked again, so a removed role cannot fetch an old file."""
    record = db.get(ReportExport, export_id)
    if record is None or record.owner_user_id != user.id or record.artifact is None:
        raise not_found()
    resolve_scope(db, user, ReportCode(record.report_code))  # Old files follow today's permissions; records are kept.
    artifact = record.artifact
    try:
        content = exports.read_file(artifact)
    except FileNotFoundError as exc:  # The stored file is gone (storage moved or cleaned): a clear 404, not a 500.
        logger.warning("Export file missing from storage for export %s", record.id)
        raise not_found("This export file is no longer available. Export the report again.") from exc
    return Response(content, media_type=artifact.content_type, headers={"Content-Disposition": f'attachment; filename="{artifact.file_name}"', "Cache-Control": "no-store"})


# ---------- Scheduled delivery ----------

class ScheduleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_code: ReportCode
    export_format: ExportFormat = ExportFormat.XLSX
    cadence: Cadence
    filters: dict[str, str] = {}


def next_run(cadence: str, after: datetime, anchor_day: int | None = None, tz: tzinfo = UTC) -> datetime:
    """The run after `after`. Weekly: seven days later. Monthly: the next month on the schedule's anchor day (the day
    of the month it was created, in the organisation timezone `tz`), or that month's last day when it is shorter, at
    the same local time. A schedule anchored on the 31st runs on 28/29 Feb and on 31 Mar again: it never drifts."""
    if cadence == Cadence.WEEKLY:
        return after + timedelta(days=7)
    local = after.astimezone(tz)
    year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
    day = min(anchor_day or local.day, monthrange(year, month)[1])
    return local.replace(year=year, month=month, day=day).astimezone(UTC)


def anchor_day(schedule: ReportSchedule, tz: tzinfo) -> int:
    """The day of the month a schedule was created on, in the organisation timezone: its monthly anchor."""
    return schedule.created_at.astimezone(tz).day


def upcoming_run(cadence: str, run_at: datetime, now: datetime, anchor: int, tz: tzinfo) -> datetime:
    """The first scheduled run after `now`. Runs missed while the scheduler was down are skipped, not delivered one
    by one: the run being delivered now stands for them, and the schedule continues on its usual days."""
    following = next_run(cadence, run_at, anchor, tz)
    while following <= now:
        following = next_run(cadence, following, anchor, tz)
    return following


def schedule_view(schedule: ReportSchedule) -> dict:
    return {
        "id": str(schedule.id),
        "report_code": schedule.report_code,
        "export_format": schedule.export_format,
        "cadence": schedule.cadence,
        "filters": schedule.filters,
        "next_run_at": iso(schedule.next_run_at),
        "is_active": schedule.is_active,
        "deliveries": [{"run_at": iso(d.run_at), "status": d.status, "export_id": str(d.export_id) if d.export_id else None, "error": d.error} for d in schedule.deliveries[:10]],
    }


@router.get("/reports/schedules")
def list_schedules(user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    schedules = db.scalars(select(ReportSchedule).options(selectinload(ReportSchedule.deliveries)).where(ReportSchedule.owner_user_id == user.id).order_by(ReportSchedule.created_at.desc())).all()
    return ok([schedule_view(s) for s in schedules])


@router.post("/reports/schedules")
def create_schedule(body: ScheduleIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    """The owner is the only recipient, so a schedule can never send a report beyond the owner's scope."""
    filters = parse_stored_filters(body.filters)
    now, tz = utcnow(), load_calendar(db).tz
    # created_at is the monthly anchor (see anchor_day), so it is set from the application clock here.
    schedule = ReportSchedule(owner_user_id=user.id, report_code=body.report_code, export_format=body.export_format, filters=filters.stored(), cadence=body.cadence, next_run_at=next_run(body.cadence, now, now.astimezone(tz).day, tz), created_at=now)
    db.add(schedule)
    db.flush()
    record_audit(db, user.id, "REPORT_SCHEDULE_CREATED", "report_schedule", schedule.id, after={"report": body.report_code.value, "cadence": body.cadence.value})
    db.commit()
    db.refresh(schedule)
    return ok(schedule_view(schedule))


@router.delete("/reports/schedules/{schedule_id}")
def stop_schedule(schedule_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    schedule = db.get(ReportSchedule, schedule_id)
    if schedule is None or schedule.owner_user_id != user.id:
        raise not_found()
    schedule.is_active = False
    record_audit(db, user.id, "REPORT_SCHEDULE_STOPPED", "report_schedule", schedule.id)
    db.commit()
    return ok({"stopped": True})


def schedule_owner_problem(account: UserAccount | None) -> str | None:
    """Why a schedule's owner may no longer receive its report, or None (audit B18). The same rules as signing in
    (an active account, an employee who is not inactive) and as reading reports (the L&D Admin role), checked again
    at every run: a schedule never outlives its owner's access."""
    if account is None or account.employee is None:
        return "OWNER_NOT_FOUND"
    if account.account_status != AccountStatus.ACTIVE:
        return "OWNER_ACCOUNT_DISABLED"
    if account.employee.employment_status == EmploymentStatus.INACTIVE:
        return "OWNER_EMPLOYEE_INACTIVE"
    if RoleCode.LD_ADMIN.value not in {link.role.code for link in account.role_links}:
        return "OWNER_NOT_AUTHORISED"
    return None


def run_due_schedules(db: Session, now: datetime | None = None) -> int:
    """Called by the scheduler. Delivers in-app with a private download; no email provider is approved."""
    from app.core.deps import CurrentUser as Actor

    now = now or utcnow()
    tz = load_calendar(db).tz
    delivered = 0
    for schedule in db.scalars(select(ReportSchedule).where(ReportSchedule.is_active, ReportSchedule.next_run_at <= now)).all():
        run_at = schedule.next_run_at
        following = upcoming_run(schedule.cadence, run_at, now, anchor_day(schedule, tz), tz)
        # Claim this run: only the process whose update still finds the run time it read gets it, so two backend
        # processes (each with its own scheduler) never deliver the same report twice. Committed before the work.
        claimed = db.execute(
            update(ReportSchedule).where(ReportSchedule.id == schedule.id, ReportSchedule.next_run_at == run_at).values(next_run_at=following).execution_options(synchronize_session=False)
        ).rowcount
        db.commit()
        if claimed != 1:
            continue
        db.refresh(schedule)
        account = db.get(UserAccount, schedule.owner_user_id)
        problem = schedule_owner_problem(account)
        if problem:  # No export, no file and no notification for an owner who has lost access.
            logger.warning("Scheduled report %s not generated: %s", schedule.id, problem)
            db.add(ReportDelivery(schedule_id=schedule.id, run_at=run_at, status=DeliveryStatus.FAILED, error=problem))
            db.commit()
            continue
        roles = {link.role.code for link in account.role_links}
        actor = Actor(account, account.employee, None, roles)  # type: ignore[arg-type]
        try:
            with db.begin_nested():
                record = run_export(db, actor, ReportCode(schedule.report_code), ExportFormat(schedule.export_format), ReportFilters.from_stored(schedule.filters))
                db.add(ReportDelivery(schedule_id=schedule.id, run_at=run_at, status=DeliveryStatus.DELIVERED, export_id=record.id))
                notify_account(db, account.id, "REPORT_READY", "Your scheduled report is ready", f"{schedule.report_code} ({schedule.cadence.lower()}) is in your Reports & Exports download list.", "/lnd/reports", f"schedule:{schedule.id}:{run_at.isoformat()}", now)
            delivered += 1
        except Exception as exc:  # A failed delivery is recorded and must not stop the other schedules.
            logger.exception("Scheduled report delivery failed for %s", schedule.id)
            db.add(ReportDelivery(schedule_id=schedule.id, run_at=run_at, status=DeliveryStatus.FAILED, error=type(exc).__name__))
    db.commit()
    return delivered


# Declared last so the fixed paths above take priority.
@router.get("/reports/{report_code}", dependencies=[expensive("report")])
def get_report(report_code: str, filters: ReportFilters = Depends(filters_dep), user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """Withdrawn reports such as reaction and kpi-impact simply do not exist (SC-2L)."""
    try:
        code = ReportCode(report_code)
    except ValueError as exc:
        raise not_found("This report does not exist.") from exc
    return ok(report_view(build_report(db, user, code, filters), filters))
