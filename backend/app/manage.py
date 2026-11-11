"""Operator commands for people and accounts.

L&D Admin and HR do not manage accounts or roles (SECURITY_PRIVACY.md §4), so this is a separate,
audited tool for an authorised operator until an approved HRMS feed or SSO replaces it.

    python -m app.manage import-employees employees.csv
    python -m app.manage reset-password someone@company.example
    python -m app.manage set-role someone@company.example LD_ADMIN

CSV columns: employee_code, full_name, work_email, department, function, location, grade, manager_code, roles
Department, function and location are existing codes. Roles are separated by | and default to EMPLOYEE.
Passwords are generated once and printed once. They are never stored in plain text or logged.
"""
import argparse
import csv
import secrets
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import session_factory
from app.core.enums import RoleCode
from app.core.security import hash_password
from app.models import Department, Employee, Function, Location, ManagerAssignment, Role, UserAccount, UserRole, UserSession

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
    labels = {"EMPLOYEE": "Employee", "MANAGER": "Manager", "LD_ADMIN": "L&D Admin", "HR_READ_ONLY": "HR / Leadership"}
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


def main() -> None:
    parser = argparse.ArgumentParser(description="TrainCheck operator commands")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("import-employees").add_argument("file", type=Path)
    commands.add_parser("reset-password").add_argument("email")
    grant = commands.add_parser("set-role")
    grant.add_argument("email")
    grant.add_argument("role")
    args = parser.parse_args()

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
                print("These passwords are shown only once. Ask each person to change theirs in My profile.")
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
