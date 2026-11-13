"""Reports, scorecards, exports and scheduled delivery. Permission and scope are re-applied every time."""
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear, require_reader, require_report_user, team_employee_ids
from app.core.enums import Cadence, DeliveryStatus, ExportFormat, ExportStatus, ReportCode, ReviewerType, RoleCode
from app.core.errors import forbidden, not_found
from app.core.ratelimit import expensive
from app.core.responses import iso, ok
from app.models import Employee, ManagerAssignment, ReportDelivery, ReportExport, ReportSchedule, Training, UserAccount
from app.modules.notifications.service import notify_account
from app.modules.reports import exports
from app.modules.reports.catalogue import BUILDERS, Report
from app.modules.reports.data import ReportFilters, behaviour_reviews, departments_summary, employee_scope, load_rows, mean, monthly_trend, rate, summary
from app.modules.reports.scorecard import build_scorecard, question_performance

router = APIRouter(tags=["Reports"])
logger = logging.getLogger("traincheck.reports")


def filters_dep(
    date_from: date | None = None,
    date_to: date | None = None,
    department_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    manager_id: uuid.UUID | None = None,
    training_id: uuid.UUID | None = None,
    trainer_id: uuid.UUID | None = None,
    batch_id: uuid.UUID | None = None,
    grade: str | None = None,
    function_id: uuid.UUID | None = None,
) -> ReportFilters:
    return ReportFilters(date_from, date_to, department_id, location_id, manager_id, training_id, trainer_id, batch_id, grade or None, function_id)


def resolve_scope(db: Session, user: CurrentUser, code: ReportCode) -> list[uuid.UUID] | None:
    """L&D and HR get the organisation. Managers keep only the Team Scorecard export, scoped to their team
    (the Team Reports page was removed). Employees have no report access (Assessment History was removed)."""
    if user.has_role(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY):
        return employee_scope(db, user)
    if user.has_role(RoleCode.MANAGER) and code == ReportCode.SCORECARD:
        return employee_scope(db, user)
    raise forbidden()


def build_report(db: Session, user: CurrentUser, code: ReportCode, filters: ReportFilters) -> Report:
    return BUILDERS[code](db, load_rows(db, resolve_scope(db, user, code), filters))


def scope_label(user: CurrentUser) -> str:
    if user.has_role(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY):
        return "Organisation"
    if user.has_role(RoleCode.MANAGER):
        return f"Team of {user.employee.full_name}"
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

    if user.has_role(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY):
        codes = list(ReportCode)
    else:
        codes = [ReportCode.SCORECARD] if user.has_role(RoleCode.MANAGER) else []
    return ok([{"code": c.value, "title": TITLES[c][0], "description": TITLES[c][1]} for c in codes])


@router.get("/reports/filter-options")
def filter_options(user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    """Dropdown values drawn only from data the caller may see."""
    rows = load_rows(db, employee_scope(db, user))
    people = {r.enrolment.employee_id: r.enrolment.employee for r in rows}
    trainings = {r.enrolment.training_id: r.enrolment.training for r in rows}
    batches = {r.enrolment.batch_id: r.enrolment.batch for r in rows if r.enrolment.batch_id}

    def unique(items) -> list[dict]:
        seen = {str(i.id): i.name for i in items if i}
        return [{"id": k, "name": v} for k, v in sorted(seen.items(), key=lambda kv: kv[1])]

    managers: list[dict] = []
    if employee_scope(db, user) is None:
        today = utcnow().date()
        result = db.execute(
            select(Employee.id, Employee.full_name)
            .join(ManagerAssignment, ManagerAssignment.manager_employee_id == Employee.id)
            .where((ManagerAssignment.effective_to.is_(None)) | (ManagerAssignment.effective_to >= today))
            .distinct()
        )
        managers = [{"id": str(i), "name": n} for i, n in sorted(result, key=lambda r: r[1])]
    return ok(
        {
            "departments": unique(p.department for p in people.values()),
            "locations": unique(p.location for p in people.values()),
            "managers": managers,
            "trainings": [{"id": str(k), "name": v.title} for k, v in sorted(trainings.items(), key=lambda kv: kv[1].title)],
            "trainers": unique(t.trainer for t in trainings.values()),
            "batches": [{"id": str(k), "name": v.name} for k, v in sorted(batches.items(), key=lambda kv: kv[1].name)],
            "grades": sorted({p.grade for p in people.values() if p.grade}),
        }
    )


@router.get("/reports/organisation-summary")
def organisation_summary(user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    rows = load_rows(db, employee_scope(db, user))
    return ok({"summary": summary(rows), "departments": departments_summary(rows), "trend": monthly_trend(rows, utcnow())})


def _training_in_scope(db: Session, training_id: uuid.UUID) -> Training:
    training = db.get(Training, training_id)
    if training is None:
        raise not_found()
    return training


@router.get("/scorecards")
def list_scorecards(user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    rows = load_rows(db, employee_scope(db, user))
    seen = {r.enrolment.training_id: r.enrolment.training for r in rows}
    return ok([{"id": str(k), "title": v.title, "code": v.training_code} for k, v in sorted(seen.items(), key=lambda kv: kv[1].title)])


@router.get("/scorecards/{training_id}", dependencies=[expensive("report")])
def scorecard(training_id: uuid.UUID, filters: ReportFilters = Depends(filters_dep), user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    training = _training_in_scope(db, training_id)
    filters.training_id = training_id
    return ok(build_scorecard(db, training, load_rows(db, employee_scope(db, user), filters)))


# ---------- Analytics pages ----------

@router.get("/reports/analytics", dependencies=[expensive("report")])
def analytics(filters: ReportFilters = Depends(filters_dep), user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    """Department and function comparison, topic gaps and behaviour trend (Phase 3)."""
    rows = load_rows(db, employee_scope(db, user), filters)
    groups: dict[str, list] = defaultdict(list)
    for r in rows:
        function = r.enrolment.employee.function
        groups[function.name if function else "Unassigned"].append(r)
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
            "trend": monthly_trend(rows, utcnow()),
        }
    )


@router.get("/reports/manager-evaluation", dependencies=[expensive("report")])
def manager_evaluation(_: CurrentUser = Depends(require_reader), db: Session = Depends(get_db)) -> dict:
    """How far each manager has completed assigned observations. Describes task completion only."""
    now = utcnow()
    today = now.date()
    managers = db.execute(
        select(Employee).join(ManagerAssignment, ManagerAssignment.manager_employee_id == Employee.id).where((ManagerAssignment.effective_to.is_(None)) | (ManagerAssignment.effective_to >= today)).distinct()
    ).scalars().all()
    out = []
    for manager in sorted(managers, key=lambda m: m.full_name):
        team = team_employee_ids(db, manager.id)
        reviews = [r for r in behaviour_reviews(db, [x.enrolment.id for x in load_rows(db, team)]) if r.reviewer_type == ReviewerType.MANAGER]
        due = [r for r in reviews if r.cycle.due_at <= now]
        submitted = [r for r in due if r.submitted_at]
        overdue = [r for r in due if not r.submitted_at and (now - r.cycle.due_at).days >= 1]
        ratings = [x.rating for r in submitted for x in r.responses]
        out.append({"manager": manager.full_name, "employee_code": manager.employee_code, "team_size": len(team), "observations_due": len(due), "observations_submitted": len(submitted), "observations_overdue": len(overdue), "completion_rate": rate(len(submitted), len(due)), "mean_rating_given": mean(ratings)})
    return ok(out)


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
    file_name = f"traincheck-{code.value}-{now.strftime('%Y%m%d-%H%M')}.{fmt.value.lower()}"
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
    try:
        filters = ReportFilters.from_stored(body.filters)
    except (ValueError, TypeError) as exc:
        from app.core.errors import validation

        raise validation("A report filter is not valid.") from exc
    if body.own_record:  # The personal history export belonged to the removed Assessment History page.
        raise forbidden("Personal history exports are no longer available.")
    record = run_export(db, user, body.report_code, body.export_format, filters, body.own_record)
    db.commit()
    return ok(export_view(record))


@router.get("/reports/exports")
def list_exports(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    records = db.scalars(select(ReportExport).where(ReportExport.owner_user_id == user.id).order_by(ReportExport.created_at.desc()).limit(100)).all()
    return ok([export_view(r) for r in records])


@router.get("/reports/exports/{export_id}/download")
def download_export(export_id: uuid.UUID, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> Response:
    """Owner only. Current role is checked again, so a removed role cannot fetch an old file."""
    record = db.get(ReportExport, export_id)
    if record is None or record.owner_user_id != user.id or record.artifact is None:
        raise not_found()
    resolve_scope(db, user, ReportCode(record.report_code))  # Old files follow today's permissions; records are kept.
    artifact = record.artifact
    return Response(exports.read_file(artifact), media_type=artifact.content_type, headers={"Content-Disposition": f'attachment; filename="{artifact.file_name}"', "Cache-Control": "no-store"})


# ---------- Scheduled delivery ----------

class ScheduleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_code: ReportCode
    export_format: ExportFormat = ExportFormat.XLSX
    cadence: Cadence
    filters: dict[str, str] = {}


def next_run(cadence: str, after: datetime) -> datetime:
    if cadence == Cadence.WEEKLY:
        return after + timedelta(days=7)
    year, month = (after.year + 1, 1) if after.month == 12 else (after.year, after.month + 1)
    return after.replace(year=year, month=month, day=min(after.day, 28))


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
def list_schedules(user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    schedules = db.scalars(select(ReportSchedule).where(ReportSchedule.owner_user_id == user.id).order_by(ReportSchedule.created_at.desc())).all()
    return ok([schedule_view(s) for s in schedules])


@router.post("/reports/schedules")
def create_schedule(body: ScheduleIn, user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    """The owner is the only recipient, so a schedule can never send a report beyond the owner's scope."""
    if not user.has_role(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY):
        raise forbidden()  # Scheduled delivery belonged to the removed manager Team Reports page.
    filters = ReportFilters.from_stored(body.filters)
    schedule = ReportSchedule(owner_user_id=user.id, report_code=body.report_code, export_format=body.export_format, filters=filters.stored(), cadence=body.cadence, next_run_at=next_run(body.cadence, utcnow()))
    db.add(schedule)
    db.flush()
    record_audit(db, user.id, "REPORT_SCHEDULE_CREATED", "report_schedule", schedule.id, after={"report": body.report_code.value, "cadence": body.cadence.value})
    db.commit()
    db.refresh(schedule)
    return ok(schedule_view(schedule))


@router.delete("/reports/schedules/{schedule_id}")
def stop_schedule(schedule_id: uuid.UUID, user: CurrentUser = Depends(require_report_user), db: Session = Depends(get_db)) -> dict:
    schedule = db.get(ReportSchedule, schedule_id)
    if schedule is None or schedule.owner_user_id != user.id:
        raise not_found()
    schedule.is_active = False
    record_audit(db, user.id, "REPORT_SCHEDULE_STOPPED", "report_schedule", schedule.id)
    db.commit()
    return ok({"stopped": True})


def run_due_schedules(db: Session, now: datetime | None = None) -> int:
    """Called by the scheduler. Delivers in-app with a private download; no email provider is approved."""
    from app.core.deps import CurrentUser as Actor

    now = now or utcnow()
    delivered = 0
    for schedule in db.scalars(select(ReportSchedule).where(ReportSchedule.is_active, ReportSchedule.next_run_at <= now)).all():
        run_at = schedule.next_run_at
        schedule.next_run_at = next_run(schedule.cadence, run_at)
        account = db.get(UserAccount, schedule.owner_user_id)
        roles = {link.role.code for link in account.role_links}
        actor = Actor(account, account.employee, None, roles)  # type: ignore[arg-type]
        try:
            with db.begin_nested():
                record = run_export(db, actor, ReportCode(schedule.report_code), ExportFormat(schedule.export_format), ReportFilters.from_stored(schedule.filters))
                db.add(ReportDelivery(schedule_id=schedule.id, run_at=run_at, status=DeliveryStatus.DELIVERED, export_id=record.id))
                notify_account(db, account.id, "REPORT_READY", "Your scheduled report is ready", f"{schedule.report_code} ({schedule.cadence.lower()}) is in your Reports & Exports download list.", "/reports/downloads", f"schedule:{schedule.id}:{run_at.isoformat()}", now)
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
