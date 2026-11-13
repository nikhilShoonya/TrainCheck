"""Operator account commands, plus the seed data they sit alongside. MVP-002, MVP-004."""
from sqlalchemy import select

from app.core.security import verify_password
from app.manage import import_employees, reset_password, set_role
from app.models import Employee, ManagerAssignment, UserAccount
from tests.conftest import ApiClient


def row(code, email, **extra):
    return {"employee_code": code, "full_name": f"New {code}", "work_email": email, "department": "OPS", "function": "SALES", "location": "L1", "grade": "G2", "manager_code": "", "roles": "", **extra}


def test_import_creates_people_accounts_and_reporting_lines(world, db, client_for):
    result = import_employees(db, [row("N1", "n1@test.example", manager_code="N2"), row("N2", "n2@test.example")])
    assert result.errors == [] and len(result.created) == 2
    db.commit()

    passwords = dict(result.created)
    for email in ("n1@test.example", "n2@test.example"):
        assert ApiClient().login(email, passwords[email]).status_code == 200
    # The reporting line is still stored as data, though no role reads it any more.
    n1, n2 = (db.scalar(select(Employee).where(Employee.employee_code == c)) for c in ("N1", "N2"))
    assert db.scalar(select(ManagerAssignment).where(ManagerAssignment.employee_id == n1.id)).manager_employee_id == n2.id


def test_import_rejects_the_removed_roles(world, db):
    for removed in ("MANAGER", "HR_READ_ONLY"):
        result = import_employees(db, [row("N9", "n9@test.example", roles=f"{removed}|EMPLOYEE")])
        assert f"unknown role '{removed}'" in result.errors[0]


def test_import_applies_nothing_when_any_row_is_wrong(world, db):
    result = import_employees(db, [row("N1", "n1@test.example"), row("N2", "", department="NOPE", roles="KING", manager_code="NOBODY")])
    assert len(result.errors) == 1
    for expected in ("work_email is required", "unknown code 'NOPE'", "unknown role 'KING'", "unknown manager_code"):
        assert expected in result.errors[0]
    assert db.scalar(select(Employee).where(Employee.employee_code == "N1")) is None


def test_import_rejects_duplicates_formulas_and_self_management(world, db):
    result = import_employees(db, [row("N1", "n1@test.example"), row("N1", "n1@test.example"), row("N3", "=cmd@test.example"), row("N4", "n4@test.example", manager_code="N4")])
    joined = " ".join(result.errors)
    assert "repeats in this file" in joined and "no formulas" in joined and "own manager" in joined


def test_reimport_updates_without_new_password_and_moves_manager(world, db):
    first = import_employees(db, [row("N1", "n1@test.example", manager_code="M1")])
    db.commit()
    hash_before = db.scalar(select(UserAccount.password_hash).where(UserAccount.login_email == "n1@test.example"))
    second = import_employees(db, [row("N1", "n1@test.example", manager_code="M2", full_name="Renamed")])
    db.commit()
    assert first.created and second.created == [] and second.updated == 1
    assert db.scalar(select(UserAccount.password_hash).where(UserAccount.login_email == "n1@test.example")) == hash_before
    employee = db.scalar(select(Employee).where(Employee.employee_code == "N1"))
    assert employee.full_name == "Renamed"
    lines = db.scalars(select(ManagerAssignment).where(ManagerAssignment.employee_id == employee.id)).all()
    assert len(lines) == 2 and sum(1 for line in lines if line.effective_to is None) == 1  # History is kept.


def test_reset_password_revokes_sessions_and_is_audited(world, db, client_for):
    from app.models import AuditLog

    client = client_for(world.employee)
    password = reset_password(db, world.employee.work_email)
    db.commit()
    assert client.get("/auth/me").status_code == 401
    db.expire_all()
    account = db.scalar(select(UserAccount).where(UserAccount.login_email == world.employee.work_email))
    assert verify_password(account.password_hash, password)
    assert password not in str(db.scalar(select(AuditLog).where(AuditLog.action == "PASSWORD_RESET_BY_OPERATOR")).after_summary)


def test_set_role_grants_access(world, db, client_for):
    client = client_for(world.employee)
    assert client.get("/admin/trainings").status_code == 403
    set_role(db, world.employee.work_email, "LD_ADMIN")
    db.commit()
    assert client.get("/admin/trainings").status_code == 200


def test_seed_loads_every_demo_scenario(db):
    """The synthetic data set required by the roadmap: three trainings, 30 questions, ten employees and known states."""
    from app.core.clock import utcnow
    from app.models import AssessmentAttempt, Question, Training
    from app.modules.assessment.gate import blocking_obligations
    from app.seed import seed

    seed(db, utcnow())
    assert len(db.scalars(select(Training)).all()) == 3
    assert len(db.scalars(select(Question)).all()) == 30
    code = lambda c: db.scalar(select(Employee).where(Employee.employee_code == c))  # noqa: E731
    assert len(blocking_obligations(db, code("E001").id)) == 2
    assert blocking_obligations(db, code("E002").id) == []
    outcomes = {a.result_status for a in db.scalars(select(AssessmentAttempt))}
    assert outcomes == {"PASSED", "NOT_PASSED"}
    flagged = db.scalars(select(AssessmentAttempt).where(AssessmentAttempt.employee_id == code("E004").id)).all()
    assert len(flagged) == 3 and flagged[0].obligation.retraining_flag == "NEEDS_RETRAINING"
