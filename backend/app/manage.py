"""Operator commands for people and accounts.

L&D Admin and HR do not manage accounts or roles (SECURITY_PRIVACY.md §4), so this is a separate,
audited tool for an authorised operator until an approved HRMS feed or SSO replaces it.

    python -m app.manage import-employees employees.csv
    python -m app.manage reset-password someone@company.example
    python -m app.manage set-role someone@company.example LD_ADMIN
    python -m app.manage sync-admin
    python -m app.manage set-calendar --timezone Asia/Kolkata --weekdays Mon-Fri [--holiday 26/01/2027 ...]
    python -m app.manage clear-data --confirm-database <database name>

CSV columns: employee_code, full_name, work_email, department, function, location, grade, manager_code, roles
Department, function and location are existing codes. Roles are separated by | and default to EMPLOYEE.
Passwords are generated once and printed once. They are never stored in plain text or logged.

sync-admin creates or updates the designated L&D Admin account from ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env.
It runs only when called (never at startup) and prints neither value. See sync_admin() for the rules.
"""
import argparse
import csv
import re
import secrets
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.db import Base, session_factory
from app.core.enums import AccountStatus, EmploymentStatus, RoleCode
from app.core.security import hash_password, validate_password_strength, verify_password
from app.models import AuditLog, CalendarHoliday, Department, Employee, Function, Location, ManagerAssignment, Role, UserAccount, UserRole, UserSession, WorkingCalendar
from app.modules.organisation.people import RESERVED_ADMIN_CODE

REQUIRED = ["employee_code", "full_name", "work_email"]
VALID_ROLES = {r.value for r in RoleCode}


@dataclass
class ImportResult:
    created: list[tuple[str, str]] = field(default_factory=list)  # (email, one-time password)
    updated: int = 0
    errors: list[str] = field(default_factory=list)


def one_time_password() -> str:
    # The fixed suffix guarantees the mixed case and digit that the password rules require.
    return secrets.token_urlsafe(12) + "aA1"


def _lookup(db: Session, model: type, code: str | None):
    if not code:
        return None, None
    item = db.scalar(select(model).where(func.upper(model.code) == code.strip().upper()))
    return item, None if item else f"unknown code '{code}'"


def _ensure_roles(db: Session) -> dict[str, Role]:
    roles = {r.code: r for r in db.scalars(select(Role))}
    labels = {"EMPLOYEE": "Employee", "LD_ADMIN": "L&D Admin"}
    for code, name in labels.items():
        if code not in roles:
            roles[code] = Role(code=code, name=name)
            db.add(roles[code])
    db.flush()
    return roles


def set_manager(db: Session, employee: Employee, manager: Employee | None, today: date) -> None:
    """Closes the old reporting line so history stays intact and access moves today."""
    current = db.scalar(select(ManagerAssignment).where(ManagerAssignment.employee_id == employee.id, ManagerAssignment.effective_to.is_(None)))
    if current and manager and current.manager_employee_id == manager.id:
        return
    if current:
        current.effective_to = today
    db.flush()
    if manager:
        db.add(ManagerAssignment(employee_id=employee.id, manager_employee_id=manager.id, effective_from=today))


def import_employees(db: Session, rows: list[dict[str, str]]) -> ImportResult:
    """Validates every row first and applies nothing if any row is wrong, so a file cannot half-apply."""
    result = ImportResult()
    roles = _ensure_roles(db)
    seen_codes: set[str] = set()
    seen_emails: set[str] = set()
    parsed = []
    file_codes = {r.get("employee_code", "").strip().upper() for r in rows}

    for number, row in enumerate(rows, start=2):
        problems = [f"{c} is required" for c in REQUIRED if not row.get(c, "").strip()]
        code = row.get("employee_code", "").strip().upper()
        email = row.get("work_email", "").strip().lower()
        if any(value.strip().startswith(("=", "+", "@")) for value in row.values() if value):
            problems.append("plain values only, no formulas")
        if email and "@" not in email:
            problems.append("work_email is not valid")
        if code == RESERVED_ADMIN_CODE:
            problems.append(f"employee_code {RESERVED_ADMIN_CODE} is reserved for the designated L&D Admin (use sync-admin)")
        if code in seen_codes:
            problems.append("employee_code repeats in this file")
        if email in seen_emails:
            problems.append("work_email repeats in this file")
        seen_codes.add(code)
        seen_emails.add(email)
        department, e1 = _lookup(db, Department, row.get("department"))
        function, e2 = _lookup(db, Function, row.get("function"))
        location, e3 = _lookup(db, Location, row.get("location"))
        problems += [f"{name}: {e}" for name, e in (("department", e1), ("function", e2), ("location", e3)) if e]
        wanted = [r.strip().upper() for r in (row.get("roles") or "EMPLOYEE").split("|") if r.strip()]
        problems += [f"unknown role '{r}'" for r in wanted if r not in VALID_ROLES]
        manager_code = row.get("manager_code", "").strip().upper()
        if manager_code and manager_code not in file_codes and not db.scalar(select(Employee.id).where(func.upper(Employee.employee_code) == manager_code)):
            problems.append(f"unknown manager_code '{manager_code}'")
        if manager_code and manager_code == code:
            problems.append("an employee cannot be their own manager")
        other = db.scalar(select(Employee).where(func.lower(Employee.work_email) == email))
        if other and other.employee_code.upper() != code:
            problems.append("work_email belongs to another employee")
        if problems:
            result.errors.append(f"Row {number}: {'; '.join(problems)}")
        parsed.append((code, email, row, department, function, location, wanted, manager_code))
    if result.errors:
        return result

    today = utcnow().date()
    people: dict[str, Employee] = {}
    for code, email, row, department, function, location, wanted, _ in parsed:
        employee = db.scalar(select(Employee).where(func.upper(Employee.employee_code) == code))
        if employee is None:
            employee = Employee(employee_code=code, full_name=row["full_name"].strip(), work_email=email)
            db.add(employee)
        else:
            result.updated += 1
        employee.full_name, employee.work_email = row["full_name"].strip(), email
        employee.department_id = department.id if department else None
        employee.function_id = function.id if function else None
        employee.location_id = location.id if location else None
        employee.grade = row.get("grade", "").strip() or None
        db.flush()
        people[code] = employee

        account = db.scalar(select(UserAccount).where(UserAccount.employee_id == employee.id))
        if account is None:
            password = one_time_password()
            account = UserAccount(employee_id=employee.id, login_email=email, password_hash=hash_password(password))
            db.add(account)
            db.flush()
            result.created.append((email, password))
        else:
            account.login_email = email
        current = {link.role.code for link in account.role_links}
        for role in set(wanted) - current:
            db.add(UserRole(user_account_id=account.id, role_id=roles[role].id))
        record_audit(db, None, "EMPLOYEE_IMPORTED", "employee", employee.id, after={"code": code, "roles": wanted})

    for code, _, _, _, _, _, _, manager_code in parsed:
        manager = people.get(manager_code) or db.scalar(select(Employee).where(func.upper(Employee.employee_code) == manager_code)) if manager_code else None
        set_manager(db, people[code], manager, today)
    db.flush()
    return result


def reset_password(db: Session, email: str) -> str:
    account = db.scalar(select(UserAccount).where(UserAccount.login_email == email.strip().lower()))
    if account is None:
        raise ValueError("No account has that email address.")
    password = one_time_password()
    account.password_hash = hash_password(password)
    now = utcnow()
    for session in db.scalars(select(UserSession).where(UserSession.user_account_id == account.id, UserSession.revoked_at.is_(None))):
        session.revoked_at = now
    record_audit(db, None, "PASSWORD_RESET_BY_OPERATOR", "user_account", account.id)
    db.flush()
    return password


def set_role(db: Session, email: str, role: str) -> None:
    code = role.strip().upper()
    if code not in VALID_ROLES:
        raise ValueError(f"Role must be one of: {', '.join(sorted(VALID_ROLES))}.")
    account = db.scalar(select(UserAccount).where(UserAccount.login_email == email.strip().lower()))
    if account is None:
        raise ValueError("No account has that email address.")
    roles = _ensure_roles(db)
    if code not in {link.role.code for link in account.role_links}:
        db.add(UserRole(user_account_id=account.id, role_id=roles[code].id))
    record_audit(db, None, "ROLE_GRANTED_BY_OPERATOR", "user_account", account.id, after={"role": code})
    db.flush()


# ---------- The designated L&D Admin (ADMIN_EMAIL / ADMIN_PASSWORD) ----------

ADMIN_NAME = "L&D Admin"
# Written once, when sync-admin creates the designated record. It is what ties the record to this command, so a
# person who merely has the reserved Employee ID is never taken over. Audit rows are never deleted.
ADMIN_MARKER = "DESIGNATED_ADMIN_CREATED"


def _designated_admin(db: Session) -> Employee | None:
    """The record sync-admin created, or None. Refuses a reserved-ID record that sync-admin did not create."""
    employee = db.scalar(select(Employee).where(func.upper(Employee.employee_code) == RESERVED_ADMIN_CODE))
    if employee is None:
        return None
    marker = db.scalar(select(AuditLog.id).where(AuditLog.action == ADMIN_MARKER, AuditLog.target_type == "employee", AuditLog.target_id == str(employee.id)).limit(1))
    if marker is None:
        raise ValueError(f"Employee ID {RESERVED_ADMIN_CODE} belongs to a record that sync-admin did not create. Nothing was changed; rename or remove that record first.")
    return employee


def sync_admin(db: Session, email: str, password: str) -> str:
    """Creates or updates the designated L&D Admin. Returns "created", "updated" or "unchanged". The caller commits.

    - The record is found by its reserved Employee ID (and creation marker), so a new ADMIN_EMAIL updates the same
      record instead of adding a second admin.
    - Refused, with nothing changed, if ADMIN_EMAIL belongs to any other employee or account, if the reserved ID belongs
      to a record this command did not create, or if the password fails the usual strength rules.
    - Changes only this one record. Never touches, promotes or demotes anyone else.
    - Unchanged email and password: nothing is written and sessions stay signed in. A change signs out every session
      of this account. The password is stored only as a hash; neither value is logged, audited or printed.
    """
    try:
        email = validate_email(email.strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise ValueError("ADMIN_EMAIL is missing or not a valid email address.") from exc
    if not password:
        raise ValueError("ADMIN_PASSWORD is empty.")
    weak = validate_password_strength(password)
    if weak:
        raise ValueError(f"ADMIN_PASSWORD is too weak: {weak}")

    employee = _designated_admin(db)
    own_id = employee.id if employee else None
    same_employee = select(Employee.id).where(func.lower(Employee.work_email) == email)
    same_account = select(UserAccount.id).where(func.lower(UserAccount.login_email) == email)
    if own_id:
        same_employee = same_employee.where(Employee.id != own_id)
        same_account = same_account.where(UserAccount.employee_id != own_id)
    if db.scalar(same_employee.limit(1)) or db.scalar(same_account.limit(1)):
        raise ValueError("ADMIN_EMAIL already belongs to another employee or account. Nothing was changed; use a different address.")

    roles = _ensure_roles(db)
    if employee is None:
        employee = Employee(employee_code=RESERVED_ADMIN_CODE, full_name=ADMIN_NAME, work_email=email, employment_status=EmploymentStatus.ACTIVE.value)
        db.add(employee)
        db.flush()
        account = UserAccount(employee_id=employee.id, login_email=email, password_hash=hash_password(password), account_status=AccountStatus.ACTIVE.value)
        db.add(account)
        db.flush()
        db.add(UserRole(user_account_id=account.id, role_id=roles[RoleCode.LD_ADMIN.value].id))
        record_audit(db, None, ADMIN_MARKER, "employee", employee.id, after={"employee_code": RESERVED_ADMIN_CODE, "role": RoleCode.LD_ADMIN.value})
        db.flush()
        return "created"

    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == employee.id))
    email_changed = employee.work_email != email or account is None or account.login_email != email
    password_changed = account is None or not verify_password(account.password_hash, password)
    restored = []
    if account is None:
        account = UserAccount(employee_id=employee.id, login_email=email, password_hash=hash_password(password))
        db.add(account)
        db.flush()
    else:
        if email_changed:
            account.login_email = email
        if password_changed:
            account.password_hash = hash_password(password)
    employee.work_email = email
    if account.account_status != AccountStatus.ACTIVE.value:
        account.account_status = AccountStatus.ACTIVE.value
        restored.append("account_status")
    if employee.employment_status != EmploymentStatus.ACTIVE.value:
        employee.employment_status = EmploymentStatus.ACTIVE.value
        restored.append("employment_status")
    if RoleCode.LD_ADMIN.value not in {link.role.code for link in account.role_links}:
        db.add(UserRole(user_account_id=account.id, role_id=roles[RoleCode.LD_ADMIN.value].id))
        restored.append("role")
    if not (email_changed or password_changed or restored):
        return "unchanged"
    revoked = 0
    if email_changed or password_changed:
        now = utcnow()
        for session in db.scalars(select(UserSession).where(UserSession.user_account_id == account.id, UserSession.revoked_at.is_(None))):
            session.revoked_at = now
            revoked += 1
    record_audit(db, None, "DESIGNATED_ADMIN_SYNCED", "employee", employee.id, after={"email_changed": email_changed, "password_changed": password_changed, "restored": restored, "sessions_revoked": revoked})
    db.flush()
    return "updated"


# ---------- Starting with an empty database ----------

KEPT_TABLES = {"roles"}  # Reference data the application needs. alembic_version is not an application table.


def clear_data(db: Session, confirm_database: str) -> dict[str, int]:
    """Empties every application table except roles, in the caller's transaction. Schema and migration history stay.

    Refused unless `confirm_database` is the name of the database actually connected to, and refused if the database
    holds tables this version of TrainCheck does not know (they might reference these rows). Returns rows removed."""
    actual = db.scalar(text("SELECT current_database()"))
    if confirm_database != actual:
        raise ValueError("--confirm-database does not match the connected database's name. Nothing was erased.")
    known = {t.name for t in Base.metadata.sorted_tables}
    unknown = sorted(set(inspect(db.connection()).get_table_names()) - known - {"alembic_version"})
    if unknown:
        raise ValueError(f"The database has tables TrainCheck does not know ({', '.join(unknown)}). Nothing was erased.")
    tables = [t.name for t in Base.metadata.sorted_tables if t.name not in KEPT_TABLES]
    counts = {name: db.scalar(text(f'SELECT count(*) FROM "{name}"')) for name in tables}  # noqa: S608 - names come from the app's own metadata
    # No CASCADE: if anything outside this list referenced these rows, PostgreSQL refuses instead of widening the erase.
    db.execute(text("TRUNCATE " + ", ".join(f'"{name}"' for name in tables) + " RESTART IDENTITY"))
    return {name: count for name, count in counts.items() if count}


_WEEKDAYS = {name: number for number, names in enumerate([("mon", "monday"), ("tue", "tues", "tuesday"), ("wed", "wednesday"), ("thu", "thur", "thurs", "thursday"), ("fri", "friday"), ("sat", "saturday"), ("sun", "sunday")]) for name in names}


def parse_weekdays(text_value: str) -> list[int]:
    """'Mon-Fri' or 'Mon,Tue,Wed,Thu,Fri' -> [0, 1, 2, 3, 4] (Python weekday numbers, Monday is 0)."""
    days: set[int] = set()
    for part in [p.strip().lower() for p in text_value.split(",") if p.strip()]:
        ends = [e.strip() for e in re.split(r"\s*-\s*", part)]
        if len(ends) > 2 or any(e not in _WEEKDAYS for e in ends):
            raise ValueError(f"Unknown weekday '{part}'. Use names such as Mon-Fri or Mon,Tue,Wed.")
        first, last = _WEEKDAYS[ends[0]], _WEEKDAYS[ends[-1]]
        if last < first:
            raise ValueError(f"'{part}' runs backwards. Write the range from Monday towards Sunday.")
        days |= set(range(first, last + 1))
    if not days:
        raise ValueError("Give at least one working weekday.")
    return sorted(days)


def set_calendar(db: Session, timezone: str, weekdays: list[int], holidays: list[date]) -> WorkingCalendar:
    """Creates the default working calendar, or updates its timezone and weekdays. Holidays given are added."""
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown timezone '{timezone}'. Use an IANA name such as Asia/Kolkata.") from exc
    calendar = db.scalar(select(WorkingCalendar).where(WorkingCalendar.is_default))
    before = {"timezone": calendar.timezone, "working_weekdays": calendar.working_weekdays} if calendar else None
    if calendar is None:
        calendar = WorkingCalendar(code="DEFAULT", name="Working calendar", timezone=timezone, working_weekdays=weekdays, is_default=True)
        db.add(calendar)
    calendar.timezone, calendar.working_weekdays = timezone, weekdays
    db.flush()
    existing = set(db.scalars(select(CalendarHoliday.holiday_date).where(CalendarHoliday.calendar_id == calendar.id)))
    for day in sorted(set(holidays) - existing):
        db.add(CalendarHoliday(calendar_id=calendar.id, holiday_date=day))
    record_audit(db, None, "CALENDAR_SET_BY_OPERATOR", "working_calendar", calendar.id, before=before, after={"timezone": timezone, "working_weekdays": weekdays, "holidays_added": len(set(holidays) - existing)})
    db.flush()
    return calendar


def _holiday(value: str) -> date:
    try:
        return datetime.strptime(value.strip(), "%d/%m/%Y").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"'{value}' is not a date in dd/mm/yyyy form.") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="TrainCheck operator commands")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("import-employees").add_argument("file", type=Path)
    commands.add_parser("reset-password").add_argument("email")
    grant = commands.add_parser("set-role")
    grant.add_argument("email")
    grant.add_argument("role")
    commands.add_parser("sync-admin", help="Create or update the designated L&D Admin from ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env.")
    calendar = commands.add_parser("set-calendar", help="Create or update the default working calendar.")
    calendar.add_argument("--timezone", required=True)
    calendar.add_argument("--weekdays", required=True, help="For example Mon-Fri")
    calendar.add_argument("--holiday", action="append", default=[], type=_holiday, help="dd/mm/yyyy; repeat for more")
    clear = commands.add_parser("clear-data", help="Erase every application record (keeps schema, migration history and roles).")
    clear.add_argument("--confirm-database", required=True, help="The name of the database to erase, typed out as a confirmation.")
    args = parser.parse_args()

    if args.command == "sync-admin":
        settings = get_settings()
        with session_factory()() as db:
            try:
                outcome = sync_admin(db, settings.admin_email, settings.admin_password.get_secret_value())
            except ValueError as exc:
                sys.exit(f"sync-admin refused: {exc}")
            db.commit()
        print({"created": "The designated L&D Admin account was created.", "updated": "The designated L&D Admin account was updated; its earlier sessions were signed out if the email or password changed.", "unchanged": "The designated L&D Admin account already matches backend/.env. Nothing was changed."}[outcome])
        return
    if args.command == "set-calendar":
        with session_factory()() as db:
            try:
                set_calendar(db, args.timezone, parse_weekdays(args.weekdays), args.holiday)
            except ValueError as exc:
                sys.exit(str(exc))
            db.commit()
        print("Working calendar saved.")
        return
    if args.command == "clear-data":
        with session_factory()() as db:
            try:
                removed = clear_data(db, args.confirm_database)
            except ValueError as exc:
                sys.exit(str(exc))
            db.commit()
        print(f"Erased {sum(removed.values())} rows from {len(removed)} tables. Schema, migration history and roles were kept.")
        return

    with session_factory()() as db:
        try:
            if args.command == "import-employees":
                with args.file.open(encoding="utf-8-sig", newline="") as handle:
                    result = import_employees(db, list(csv.DictReader(handle)))
                if result.errors:
                    sys.exit("Nothing was imported.\n" + "\n".join(result.errors))
                db.commit()
                print(f"Created {len(result.created)} and updated {result.updated} employees.")
                for email, password in result.created:
                    print(f"{email}\t{password}")
                print("These passwords are shown only once. L&D Admin accounts can change theirs in My profile; employees only when EMPLOYEE_PASSWORD_CHANGE_ENABLED=true.")
            elif args.command == "reset-password":
                password = reset_password(db, args.email)
                db.commit()
                print(f"One-time password (shown only once): {password}")
            else:
                set_role(db, args.email, args.role)
                db.commit()
                print("Role granted.")
        except ValueError as exc:
            sys.exit(str(exc))


if __name__ == "__main__":
    main()
