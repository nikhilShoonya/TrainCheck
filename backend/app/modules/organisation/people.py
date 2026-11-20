"""Adding employees and their sign-in accounts from L&D Admin > Employee Assignments ("Add Employee").

One employee at a time, or many from a CSV/XLSX file: Upload -> Validate -> Preview -> Confirm Import.

Rules (both ways):
- Department: an existing ACTIVE department, matched by code or exact name, ignoring case and surrounding spaces.
  Departments are never created here.
- Employee ID: kept as text exactly as entered (leading zeros included). Unique, ignoring case.
- Work email: stored in lower case (sign-in compares lower case). Unique among employees and sign-in accounts.
- Account: role EMPLOYEE only. Its password is Fin@DDMMYYYY from the joining date, generated here, only when the
  account is created, and stored only as a hash. It is never returned, logged or audited.
- Existing employees and accounts are never changed: a row naming one is an error, so a re-import cannot reset a
  password, overwrite a record or grant a role.
- Creating an employee assigns no training, records no completion and schedules no assessment.
- A file is imported whole or not at all. Confirming validates the file again inside the same transaction.
"""
import re
import uuid
from dataclasses import dataclass, field
from datetime import date

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.enums import AccountStatus, EmploymentStatus, RoleCode
from app.core.errors import ApiError, conflict
from app.core.security import hash_password
from app.models import Department, Employee, Role, UserAccount, UserRole
from app.modules.imports.parsing import clip, has_formula

# ---------- File layout ----------

# Canonical column -> heading shown in the template and in messages (Finvasia's HR export headings).
COLUMNS = {"employeeid": "Employee Number", "name": "Full Name", "email": "Email", "joiningdate": "Date of Joining", "department": "Department"}
# Other headings accepted for a column, after normalising (see _heading_key): Finvasia's headings, the first
# template's headings and a common misspelling.
HEADING_ALIASES = {"employeenumber": "employeeid", "fullname": "name", "dateofjoining": "joiningdate", "departement": "department"}
TEMPLATE_ROWS = [
    ["Employee Number", "Full Name", "Email", "Date of Joining", "Department"],
    ["00123", "Asha Verma", "asha.verma@example.com", "19 Nov 2026", "OPS"],
    ["E0457", "Rohan Iyer", "rohan.iyer@example.com", "05/01/2026", "Customer Experience"],
    ["000789", "Meera Nair", "meera.nair@example.com", "2026-11-19", "OPS"],
]
MAX_NAME = 160
MAX_CODE = 40
# The designated L&D Admin's Employee ID, managed only by `python -m app.manage sync-admin`. Never used for employees.
RESERVED_ADMIN_CODE = "TC-LD-ADMIN"
MAX_EMAIL = 254
# Serialises employee creation on PostgreSQL, so two confirmations at once cannot both pass the duplicate checks.
CREATE_LOCK_KEY = 0x7C_EE_01


def _heading_key(heading: str) -> str:
    """'  Employee Number ', 'employee_number' and 'EmployeeNumber' all become 'employeeid' (as do the Employee ID spellings)."""
    key = re.sub(r"[\s_\-]+", "", heading.replace("﻿", "").strip().lower())
    return HEADING_ALIASES.get(key, key)


def header_map(header: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    repeated: list[str] = []
    for index, heading in enumerate(header):
        key = _heading_key(heading)
        if key in COLUMNS:
            if key in found:
                repeated.append(COLUMNS[key])
            found[key] = index
    missing = [label for key, label in COLUMNS.items() if key not in found]
    if missing:
        raise ApiError(400, "INVALID_HEADERS", f"Use the TrainCheck employee template. Missing columns: {', '.join(missing)}.")
    if repeated:
        raise ApiError(400, "INVALID_HEADERS", f"Each column must appear once. Repeated: {', '.join(sorted(set(repeated)))}.")
    return found


# ---------- Values ----------

_MONTHS = {name: number for number, names in enumerate(
    [("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",), ("jun", "june"),
     ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"), ("dec", "december")],
    start=1) for name in names}
_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_DAY_FIRST = re.compile(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$")
_COMPACT = re.compile(r"^\d{7,8}$")
_NAMED_MONTH = re.compile(r"^(\d{1,2})[\s-]+([A-Za-z]+)\.?,?[\s-]+(\d{4})$")
JOINING_DATE_HELP = "Use a date such as 19 Nov 2026, 19/11/2026, 19-11-2026, 2026-11-19 or 19112026 (day first)."


def parse_joining_date(raw: str) -> date | None:
    """Day first. None when the text is not one of the accepted formats or not a real calendar date.

    A 7-digit number is an 8-digit DDMMYYYY whose leading zero Excel dropped (05012026 -> 5012026)."""
    value = " ".join(raw.split())
    try:
        if m := _ISO.match(value):
            year, month, day = int(m[1]), int(m[2]), int(m[3])
        elif m := _DAY_FIRST.match(value):
            day, month, year = int(m[1]), int(m[2]), int(m[3])
        elif _COMPACT.match(value):
            digits = value.zfill(8)
            day, month, year = int(digits[:2]), int(digits[2:4]), int(digits[4:])
        elif m := _NAMED_MONTH.match(value):
            month = _MONTHS.get(m[2].lower())
            if month is None:
                return None
            day, year = int(m[1]), int(m[3])
        else:
            return None
        if not 1900 <= year <= 2100:
            return None
        return date(year, month, day)
    except ValueError:
        return None


def employee_password(joining_date: date) -> str:
    """The employee's ongoing password: Fin@ followed by the joining date as DDMMYYYY (19 Nov 2026 -> Fin@19112026)."""
    return f"Fin@{joining_date:%d%m%Y}"


def normalise_email(raw: str) -> tuple[str, str | None]:
    """(lower-case address, problem or None)."""
    email = raw.strip().lower()
    if not email:
        return email, "Required."
    if len(email) > MAX_EMAIL:
        return email, f"Use at most {MAX_EMAIL} characters."
    try:
        validate_email(email, check_deliverability=False)
    except EmailNotValidError:
        return email, "Enter a valid email address, such as name@company.com."
    return email, None


@dataclass
class Directory:
    """What the checks need from the database, read once per validation."""

    departments: list[Department]
    taken_codes: set[str]  # Upper-case employee codes that already exist.
    taken_emails: set[str]  # Lower-case work and sign-in emails that already exist.

    def department(self, raw: str) -> tuple[Department | None, str | None]:
        value = raw.strip()
        if not value:
            return None, "Required."
        matches = [d for d in self.departments if d.code.strip().upper() == value.upper() or d.name.strip().lower() == value.lower()]
        active = [d for d in matches if d.is_active]
        if len(active) == 1:
            return active[0], None
        if len(active) > 1:
            return None, f"'{clip(value)[:80]}' matches more than one active department. Use the department code."
        if matches:
            return None, f"Department '{clip(value)[:80]}' is inactive. Use an active department."
        return None, f"Unknown department '{clip(value)[:80]}'. Use an existing department code or name."


def is_learner():
    """SQL condition: the employee record is a person who can be trained, not the designated L&D Admin sign-in record
    (Employee ID TC-LD-ADMIN, created by `manage.py sync-admin`). That record exists only to sign in: it is never listed,
    counted, searched, assigned, imported or reported. Admins who are also employees are learners and stay visible.
    Duplicate checks (load_directory) still include it, so no one can take its ID or email."""
    return func.upper(Employee.employee_code) != RESERVED_ADMIN_CODE


def load_directory(db: Session, codes: list[str], emails: list[str]) -> Directory:
    upper_codes = sorted({c.upper() for c in codes if c})
    lower_emails = sorted({e.lower() for e in emails if e})
    taken_codes: set[str] = set()
    taken_emails: set[str] = set()
    for chunk in _chunks(upper_codes):
        taken_codes |= set(db.scalars(select(func.upper(Employee.employee_code)).where(func.upper(Employee.employee_code).in_(chunk))))
    for chunk in _chunks(lower_emails):
        taken_emails |= set(db.scalars(select(func.lower(Employee.work_email)).where(func.lower(Employee.work_email).in_(chunk))))
        taken_emails |= set(db.scalars(select(func.lower(UserAccount.login_email)).where(func.lower(UserAccount.login_email).in_(chunk))))
    return Directory(list(db.scalars(select(Department))), taken_codes, taken_emails)


def _chunks(values: list[str], size: int = 500):
    for start in range(0, len(values), size):
        yield values[start : start + size]


# ---------- Checking one person ----------

@dataclass
class Candidate:
    row: int  # File row number (the header is row 1). 0 for the single form.
    name: str
    code: str
    email: str
    joining_text: str
    department_text: str
    joining: date | None = None
    department: Department | None = None
    errors: list[dict[str, str]] = field(default_factory=list)

    def problem(self, column: str, message: str) -> None:
        self.errors.append({"field": column, "message": message})


def check_values(c: Candidate, directory: Directory, labels: dict[str, str], resolve_department: bool = True) -> None:
    """Every rule that does not depend on other rows. `labels` names the fields in messages.
    `resolve_department=False`: the caller resolves c.department itself (the single form sends an ID)."""
    for key, value in (("name", c.name), ("employeeid", c.code), ("email", c.email), ("department", c.department_text)):
        if value and has_formula(value):
            c.problem(labels[key], "Use plain values, not formulas.")
    if not c.name:
        c.problem(labels["name"], "Required.")
    elif len(c.name) > MAX_NAME:
        c.problem(labels["name"], f"Use at most {MAX_NAME} characters.")
    if not c.code:
        c.problem(labels["employeeid"], "Required.")
    elif len(c.code) > MAX_CODE:
        c.problem(labels["employeeid"], f"Use at most {MAX_CODE} characters.")
    elif c.code.upper() == RESERVED_ADMIN_CODE:
        c.problem(labels["employeeid"], f"Employee ID {RESERVED_ADMIN_CODE} is reserved for the designated L&D Admin. Use another ID.")
    elif c.code.upper() in directory.taken_codes:
        c.problem(labels["employeeid"], f"{c.code} already exists. Existing employees are not changed.")
    c.email, email_problem = normalise_email(c.email)
    if email_problem:
        c.problem(labels["email"], email_problem)
    elif c.email in directory.taken_emails:
        c.problem(labels["email"], f"{c.email} is already used by an existing employee or account.")
    if c.joining is None:
        if not c.joining_text.strip():
            c.problem(labels["joiningdate"], "Required.")
        else:
            c.joining = parse_joining_date(c.joining_text)
            if c.joining is None:
                c.problem(labels["joiningdate"], JOINING_DATE_HELP)
    if resolve_department:
        c.department, department_problem = directory.department(c.department_text)
        if department_problem:
            c.problem(labels["department"], department_problem)


# ---------- Files ----------

FILE_LABELS = dict(COLUMNS)


def candidates_from_rows(rows: list[list[str]]) -> list[Candidate]:
    headers = header_map(rows[0])
    people = []
    for number, row in enumerate(rows[1:], start=2):
        cell = {key: clip(row[i].strip()) if i < len(row) else "" for key, i in headers.items()}
        people.append(Candidate(number, cell["name"], cell["employeeid"], cell["email"], cell["joiningdate"], cell["department"]))
    if not people:
        raise ApiError(400, "INVALID_FILE", "This file has a header row but no employees.")
    return people


def validate_file(db: Session, people: list[Candidate]) -> list[Candidate]:
    directory = load_directory(db, [p.code for p in people], [p.email.strip() for p in people])
    for person in people:
        check_values(person, directory, FILE_LABELS)
    _flag_repeats(people, lambda p: p.code.upper(), COLUMNS["employeeid"], "Employee Number")
    _flag_repeats(people, lambda p: p.email, COLUMNS["email"], "Email")
    return people


def _flag_repeats(people: list[Candidate], key, column: str, label: str) -> None:
    rows: dict[str, list[int]] = {}
    for person in people:
        value = key(person)
        if value:
            rows.setdefault(value, []).append(person.row)
    for person in people:
        value = key(person)
        others = [r for r in rows.get(value, []) if r != person.row] if value else []
        if others:
            person.problem(column, f"{label} repeats in this file (also row {', '.join(map(str, others))}).")


def preview(people: list[Candidate]) -> dict:
    invalid = sum(1 for p in people if p.errors)
    return {
        "total_rows": len(people),
        "valid_rows": len(people) - invalid,
        "invalid_rows": invalid,
        "ready": invalid == 0,
        "rows": [
            {
                "row": p.row,
                "name": p.name,
                "employee_code": p.code,
                "email": p.email,
                "joining_date": p.joining.isoformat() if p.joining else None,
                "joining_date_text": p.joining_text,
                "department": {"id": str(p.department.id), "code": p.department.code, "name": p.department.name} if p.department else None,
                "department_text": p.department_text,
                "status": "INVALID" if p.errors else "VALID",
                "errors": p.errors,
            }
            for p in people
        ],
    }


# ---------- Creating ----------

def lock_for_create(db: Session) -> None:
    """Held until the transaction ends. A no-op where advisory locks do not exist (tests on other databases)."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": CREATE_LOCK_KEY})


def password_hashes(people: list[Candidate]) -> dict[int, str]:
    """Hashing is deliberately slow, so it is done before the database lock is taken. Keyed by row."""
    return {p.row: hash_password(employee_password(p.joining)) for p in people if p.joining}


def _employee_role(db: Session) -> Role:
    role = db.scalar(select(Role).where(Role.code == RoleCode.EMPLOYEE.value))
    if role is None:
        role = Role(code=RoleCode.EMPLOYEE.value, name="Employee")
        db.add(role)
        db.flush()
    return role


def create(db: Session, people: list[Candidate], hashes: dict[int, str], actor_id: uuid.UUID, source: str) -> list[Employee]:
    """Adds every person, or raises with nothing added. The caller commits. `people` must have passed validation."""
    role = _employee_role(db)
    created = []
    try:
        for person in people:
            if person.department is None or person.joining is None or person.errors or person.row not in hashes:
                raise RuntimeError("create() was given a person that did not pass validation.")
            employee = Employee(
                employee_code=person.code,
                full_name=person.name,
                work_email=person.email,
                department_id=person.department.id,
                joining_date=person.joining,
                employment_status=EmploymentStatus.ACTIVE.value,
            )
            db.add(employee)
            db.flush()
            account = UserAccount(employee_id=employee.id, login_email=person.email, password_hash=hashes[person.row], account_status=AccountStatus.ACTIVE.value)
            db.add(account)
            db.flush()
            db.add(UserRole(user_account_id=account.id, role_id=role.id, assigned_by=actor_id))
            # No name, email or password: the code and department identify the record.
            record_audit(db, actor_id, "EMPLOYEE_CREATED", "employee", employee.id, after={"employee_code": person.code, "department": person.department.code, "role": RoleCode.EMPLOYEE.value, "source": source})
            created.append(employee)
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("EMPLOYEE_ALREADY_EXISTS", "Another change added one of these employees at the same time. Nothing was saved. Validate again.") from exc
    return created
