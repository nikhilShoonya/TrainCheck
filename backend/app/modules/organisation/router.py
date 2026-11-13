"""Organisation master data: departments, functions, locations, trainers, competencies, calendar, employees."""
import uuid
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin
from app.core.errors import conflict, not_found
from app.core.responses import ok
from app.models import CalendarHoliday, Competency, Department, Employee, Function, Location, Trainer, WorkingCalendar

router = APIRouter(prefix="/admin", tags=["Organisation"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class OrgUnitIn(Strict):
    code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=120)
    is_active: bool = True


class TrainerIn(Strict):
    name: str = Field(min_length=1, max_length=160)
    email: str | None = Field(default=None, max_length=254)
    is_active: bool = True


class CompetencyIn(Strict):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    is_active: bool = True


class CalendarIn(Strict):
    name: str = Field(min_length=1, max_length=120)
    timezone: str = Field(min_length=1, max_length=60)
    working_weekdays: list[int] = Field(min_length=1, max_length=7)


class HolidayIn(Strict):
    holiday_date: date
    name: str = Field(default="Holiday", max_length=120)


def unit_view(unit: Department | Function) -> dict:
    return {"id": str(unit.id), "code": unit.code, "name": unit.name, "is_active": unit.is_active}


def _crud_units(path: str, model: type, label: str) -> None:
    @router.get(f"/{path}", name=f"list_{path}")
    def list_units(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
        return ok([unit_view(u) for u in db.scalars(select(model).order_by(model.name))])

    @router.post(f"/{path}", name=f"create_{path}")
    def create_unit(body: OrgUnitIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
        unit = model(code=body.code.upper(), name=body.name, is_active=body.is_active)
        db.add(unit)
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            raise conflict("DUPLICATE_CODE", f"A {label} with this code already exists.") from exc
        record_audit(db, user.id, f"{label.upper()}_CREATED", label, unit.id, after={"code": unit.code, "name": unit.name})
        db.commit()
        return ok(unit_view(unit))

    @router.patch(f"/{path}/{{unit_id}}", name=f"update_{path}")
    def update_unit(unit_id: uuid.UUID, body: OrgUnitIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
        unit = db.get(model, unit_id)
        if unit is None:
            raise not_found()
        before = unit_view(unit)
        unit.code, unit.name, unit.is_active = body.code.upper(), body.name, body.is_active
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            raise conflict("DUPLICATE_CODE", f"A {label} with this code already exists.") from exc
        record_audit(db, user.id, f"{label.upper()}_UPDATED", label, unit.id, before=before, after=unit_view(unit))
        db.commit()
        return ok(unit_view(unit))


_crud_units("departments", Department, "department")
_crud_units("functions", Function, "function")


@router.get("/locations")
def list_locations(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok([{"id": str(x.id), "code": x.code, "name": x.name, "timezone": x.timezone} for x in db.scalars(select(Location).order_by(Location.name))])


@router.get("/trainers")
def list_trainers(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok([{"id": str(t.id), "name": t.name, "email": t.email, "is_active": t.is_active} for t in db.scalars(select(Trainer).order_by(Trainer.name))])


@router.post("/trainers")
def create_trainer(body: TrainerIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    trainer = Trainer(name=body.name, email=body.email, is_active=body.is_active)
    db.add(trainer)
    db.flush()
    record_audit(db, user.id, "TRAINER_CREATED", "trainer", trainer.id, after={"name": trainer.name})
    db.commit()
    return ok({"id": str(trainer.id), "name": trainer.name, "email": trainer.email, "is_active": trainer.is_active})


@router.patch("/trainers/{trainer_id}")
def update_trainer(trainer_id: uuid.UUID, body: TrainerIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    trainer = db.get(Trainer, trainer_id)
    if trainer is None:
        raise not_found()
    trainer.name, trainer.email, trainer.is_active = body.name, body.email, body.is_active
    record_audit(db, user.id, "TRAINER_UPDATED", "trainer", trainer.id, after={"name": trainer.name, "is_active": trainer.is_active})
    db.commit()
    return ok({"id": str(trainer.id), "name": trainer.name, "email": trainer.email, "is_active": trainer.is_active})


def competency_view(c: Competency) -> dict:
    return {"id": str(c.id), "code": c.code, "name": c.name, "description": c.description, "is_active": c.is_active}


@router.get("/competencies")
def list_competencies(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok([competency_view(c) for c in db.scalars(select(Competency).order_by(Competency.name))])


@router.post("/competencies")
def create_competency(body: CompetencyIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    competency = Competency(code=uuid.uuid4().hex[:12].upper(), name=body.name, description=body.description, is_active=body.is_active)
    db.add(competency)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("DUPLICATE_NAME", "A competency with this name already exists.") from exc
    record_audit(db, user.id, "COMPETENCY_CREATED", "competency", competency.id, after={"name": competency.name})
    db.commit()
    return ok(competency_view(competency))


@router.get("/employees")
def list_employees(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    rows = db.scalars(
        select(Employee)
        .options(selectinload(Employee.department), selectinload(Employee.function), selectinload(Employee.location))
        .order_by(Employee.full_name)
    ).all()
    return ok(
        [
            {
                "id": str(e.id),
                "employee_code": e.employee_code,
                "full_name": e.full_name,
                "department": e.department.name if e.department else None,
                "department_id": str(e.department_id) if e.department_id else None,
                "function": e.function.name if e.function else None,
                "function_id": str(e.function_id) if e.function_id else None,
                "location": e.location.name if e.location else None,
                "grade": e.grade,
                "employment_status": e.employment_status,
            }
            for e in rows
        ]
    )


def _default_calendar(db: Session) -> WorkingCalendar:
    calendar = db.scalar(select(WorkingCalendar).options(selectinload(WorkingCalendar.holidays)).where(WorkingCalendar.is_default))
    if calendar is None:
        raise not_found("No working calendar is configured.")
    return calendar


def calendar_view(calendar: WorkingCalendar) -> dict:
    return {
        "id": str(calendar.id),
        "name": calendar.name,
        "timezone": calendar.timezone,
        "working_weekdays": calendar.working_weekdays,
        "holidays": sorted(({"id": str(h.id), "date": h.holiday_date.isoformat(), "name": h.name} for h in calendar.holidays), key=lambda h: h["date"]),
        "policy_note": "Provisional. Finvasia has not yet approved a working calendar (OD-BRD-004).",
    }


@router.get("/calendar")
def get_calendar(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    return ok(calendar_view(_default_calendar(db)))


@router.patch("/calendar")
def update_calendar(body: CalendarIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    from zoneinfo import ZoneInfo

    try:
        ZoneInfo(body.timezone)
    except Exception as exc:
        raise conflict("INVALID_TIMEZONE", "Use a valid timezone name such as Asia/Kolkata.") from exc
    if any(day < 0 or day > 6 for day in body.working_weekdays):
        raise conflict("INVALID_WEEKDAY", "Weekdays must be numbers from 0 (Monday) to 6 (Sunday).")
    calendar = _default_calendar(db)
    before = {"timezone": calendar.timezone, "working_weekdays": calendar.working_weekdays}
    calendar.name, calendar.timezone, calendar.working_weekdays = body.name, body.timezone, sorted(set(body.working_weekdays))
    record_audit(db, user.id, "CALENDAR_UPDATED", "working_calendar", calendar.id, before=before, after={"timezone": calendar.timezone, "working_weekdays": calendar.working_weekdays})
    db.commit()
    return ok(calendar_view(calendar))


@router.post("/calendar/holidays")
def add_holiday(body: HolidayIn, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    calendar = _default_calendar(db)
    db.add(CalendarHoliday(calendar_id=calendar.id, holiday_date=body.holiday_date, name=body.name))
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("DUPLICATE_HOLIDAY", "This date is already a holiday.") from exc
    record_audit(db, user.id, "HOLIDAY_ADDED", "working_calendar", calendar.id, after={"date": body.holiday_date.isoformat()})
    db.commit()
    db.refresh(calendar)
    return ok(calendar_view(calendar))


@router.delete("/calendar/holidays/{holiday_id}")
def remove_holiday(holiday_id: uuid.UUID, user: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    holiday = db.get(CalendarHoliday, holiday_id)
    if holiday is None:
        raise not_found()
    record_audit(db, user.id, "HOLIDAY_REMOVED", "working_calendar", holiday.calendar_id, before={"date": holiday.holiday_date.isoformat()})
    db.delete(holiday)
    db.commit()
    return ok({"removed": True})
