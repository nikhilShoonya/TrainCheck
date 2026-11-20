"""Starting real use: the designated L&D Admin from .env (sync-admin), the one-time erase (clear-data), the working
calendar (set-calendar), and the guarantee that demo data is never loaded on its own."""
import sys
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, inspect, select, text

from app import seed as seed_module
from app.core.db import Base, get_engine
from app.core.security import verify_password
from app.main import app
from app.manage import ADMIN_MARKER, clear_data, parse_weekdays, reset_password, set_calendar, sync_admin
from app.models import AuditLog, Employee, Role, UserAccount, UserRole, UserSession, WorkingCalendar
from app.modules.organisation.people import RESERVED_ADMIN_CODE
from tests.conftest import PASSWORD, ApiClient

ADMIN_EMAIL = "ld.admin@company.example"
ADMIN_PASSWORD = "Strong-Admin-Pass-2026"


def _designated(db) -> list[Employee]:
    db.expire_all()
    return list(db.scalars(select(Employee).where(Employee.employee_code == RESERVED_ADMIN_CODE)))


def _account(db, employee: Employee) -> UserAccount:
    return db.scalar(select(UserAccount).where(UserAccount.employee_id == employee.id))


def _signed_in(email: str, password: str) -> ApiClient:
    client = ApiClient()
    assert client.login(email, password).status_code == 200
    return client


def _audit_text(db) -> str:
    return str([(a.action, a.before_summary, a.after_summary, a.reason) for a in db.scalars(select(AuditLog))])


# ---------- sync-admin ----------

def test_sync_creates_the_designated_admin_with_a_hashed_password(world, db):
    assert sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD) == "created"
    db.commit()
    [employee] = _designated(db)
    account = _account(db, employee)
    assert employee.full_name == "L&D Admin" and employee.department_id is None and employee.work_email == ADMIN_EMAIL
    assert account.password_hash.startswith("$argon2id") and verify_password(account.password_hash, ADMIN_PASSWORD)
    assert {link.role.code for link in account.role_links} == {"LD_ADMIN"}
    me = _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD).get("/auth/me").json()["data"]["user"]
    assert me["roles"] == ["LD_ADMIN"] and me["features"]["password_change"] is True
    # Audited without the email or password.
    text_ = _audit_text(db)
    assert ADMIN_MARKER in text_ and ADMIN_PASSWORD not in text_ and ADMIN_EMAIL not in text_


def test_repeating_sync_with_unchanged_credentials_changes_nothing(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    client = _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    audits = db.scalar(select(func.count()).select_from(AuditLog))
    hash_before = _account(db, _designated(db)[0]).password_hash
    for _ in range(2):
        assert sync_admin(db, ADMIN_EMAIL.upper(), ADMIN_PASSWORD) == "unchanged"
        db.commit()
    assert len(_designated(db)) == 1 and _account(db, _designated(db)[0]).password_hash == hash_before
    assert db.scalar(select(func.count()).select_from(AuditLog)) == audits
    assert client.get("/auth/me").status_code == 200  # Still signed in.


def test_a_new_admin_email_updates_the_same_record_and_signs_out(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    [before] = _designated(db)
    client = _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert sync_admin(db, "new.admin@company.example", ADMIN_PASSWORD) == "updated"
    db.commit()
    [after] = _designated(db)
    assert after.id == before.id and after.work_email == "new.admin@company.example"
    assert db.scalar(select(func.count()).select_from(UserAccount).where(UserAccount.employee_id == after.id)) == 1
    assert client.get("/auth/me").status_code == 401
    assert ApiClient().login(ADMIN_EMAIL, ADMIN_PASSWORD).status_code == 401
    _signed_in("new.admin@company.example", ADMIN_PASSWORD)
    assert ADMIN_EMAIL not in _audit_text(db) and "new.admin" not in _audit_text(db)


def test_a_new_admin_password_signs_out_every_session(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    first, second = _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD), _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert sync_admin(db, ADMIN_EMAIL, "Another-Strong-Pass-1") == "updated"
    db.commit()
    assert first.get("/auth/me").status_code == 401 and second.get("/auth/me").status_code == 401
    assert ApiClient().login(ADMIN_EMAIL, ADMIN_PASSWORD).status_code == 401
    _signed_in(ADMIN_EMAIL, "Another-Strong-Pass-1")
    account = _account(db, _designated(db)[0])
    assert db.scalar(select(func.count()).select_from(UserSession).where(UserSession.user_account_id == account.id, UserSession.revoked_at.is_(None))) == 1
    assert "Another-Strong-Pass-1" not in _audit_text(db)


@pytest.mark.parametrize("email", ["employee@test.example", "EMPLOYEE@test.example", "admin@test.example"])
def test_an_email_belonging_to_someone_else_is_refused(world, db, email):
    with pytest.raises(ValueError, match="another employee or account"):
        sync_admin(db, email, ADMIN_PASSWORD)
    db.rollback()
    assert _designated(db) == []


def test_an_email_used_only_as_another_sign_in_address_is_refused(world, db):
    account = _account(db, world.teammate)
    account.login_email = "taken.login@company.example"
    db.commit()
    with pytest.raises(ValueError, match="another employee or account"):
        sync_admin(db, "taken.login@company.example", ADMIN_PASSWORD)
    db.rollback()
    # And renaming the existing designated admin onto it is refused too, leaving the admin as it was.
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    with pytest.raises(ValueError):
        sync_admin(db, "taken.login@company.example", ADMIN_PASSWORD)
    db.rollback()
    assert _designated(db)[0].work_email == ADMIN_EMAIL


def test_an_unrelated_record_with_the_reserved_id_is_never_taken_over_or_promoted(world, db):
    impostor = world.person(RESERVED_ADMIN_CODE, "someone@test.example", ["EMPLOYEE"])
    db.commit()
    hash_before = _account(db, impostor).password_hash
    with pytest.raises(ValueError, match="did not create"):
        sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.rollback()
    db.expire_all()
    account = _account(db, impostor)
    assert account.password_hash == hash_before and account.login_email == "someone@test.example"
    assert {link.role.code for link in account.role_links} == {"EMPLOYEE"}
    # The same holds when the email given is that person's own.
    with pytest.raises(ValueError):
        sync_admin(db, "someone@test.example", ADMIN_PASSWORD)
    db.rollback()


@pytest.mark.parametrize(("email", "password", "message"), [("", ADMIN_PASSWORD, "ADMIN_EMAIL"), ("not-an-email", ADMIN_PASSWORD, "ADMIN_EMAIL"), (ADMIN_EMAIL, "", "empty"), (ADMIN_EMAIL, "short1A", "too weak"), (ADMIN_EMAIL, "alllowercase123", "too weak")])
def test_missing_or_weak_credentials_are_refused(world, db, email, password, message):
    with pytest.raises(ValueError, match=message):
        sync_admin(db, email, password)
    db.rollback()
    assert _designated(db) == []


def test_other_administrators_are_left_alone(world, db):
    other = _account(db, world.admin)
    hash_before, roles_before = other.password_hash, {link.role.code for link in other.role_links}
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    sync_admin(db, "changed@company.example", "Changed-Strong-Pass-9")
    db.commit()
    db.expire_all()
    other = _account(db, world.admin)
    assert other.password_hash == hash_before and {link.role.code for link in other.role_links} == roles_before
    assert ApiClient().login("admin@test.example", PASSWORD).status_code == 200


def test_operator_reset_works_for_the_designated_admin_and_sync_reapplies_env(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    temporary = reset_password(db, ADMIN_EMAIL)
    db.commit()
    _signed_in(ADMIN_EMAIL, temporary)
    # Running sync-admin again makes the .env password the current one (documented).
    assert sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD) == "updated"
    db.commit()
    _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)


def test_the_designated_admin_can_still_change_their_own_password(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    client = _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert client.post("/auth/change-password", json={"current_password": ADMIN_PASSWORD, "new_password": "Self-Chosen-Pass-7"}).status_code == 200
    _signed_in(ADMIN_EMAIL, "Self-Chosen-Pass-7")


def test_sync_restores_a_disabled_designated_admin(world, db):
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    account = _account(db, _designated(db)[0])
    account.account_status = "DISABLED"
    db.execute(UserRole.__table__.delete().where(UserRole.user_account_id == account.id))
    db.commit()
    assert sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD) == "updated"
    db.commit()
    assert _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD).get("/auth/me").json()["data"]["user"]["roles"] == ["LD_ADMIN"]


def test_add_employee_refuses_the_reserved_id(world, client_for):
    admin = client_for(world.admin)
    body = {"full_name": "Someone", "employee_code": RESERVED_ADMIN_CODE.lower(), "work_email": "someone.new@example.com", "joining_date": "2026-11-19", "department_id": str(world.departments["OPS"].id)}
    response = admin.post("/admin/employees", json=body)
    assert response.status_code == 400 and "reserved" in response.text
    csv = f"name,employee id,email,joiningdate,department\nSomeone,{RESERVED_ADMIN_CODE},someone.new@example.com,19/11/2026,OPS\n".encode()
    preview = admin.post("/admin/employees/import/preview", files={"file": ("p.csv", csv, "text/csv")}).json()["data"]
    assert preview["ready"] is False and "reserved" in str(preview["rows"][0]["errors"])


# ---------- clear-data ----------

def _schema(db) -> tuple[list[str], list[str]]:
    connection = db.connection()
    tables = sorted(inspect(connection).get_table_names())
    versions = list(connection.execute(text("SELECT version_num FROM alembic_version")).scalars())
    return tables, versions


def test_clear_data_needs_the_database_name(world, db):
    with pytest.raises(ValueError, match="does not match"):
        clear_data(db, "some-other-database")
    db.rollback()
    assert db.scalar(select(func.count()).select_from(Employee)) > 0


def test_clear_data_erases_records_but_keeps_schema_history_and_roles(world, db):
    world.complete(world.employee, world.training())
    db.commit()
    tables_before, versions_before = _schema(db)
    assert versions_before  # Migrated by the real Alembic scripts.
    roles_before = sorted(db.scalars(select(Role.code)))
    name = db.scalar(text("SELECT current_database()"))
    removed = clear_data(db, name)
    db.commit()
    assert removed["employees"] == 7 and removed["user_accounts"] == 7 and "roles" not in removed
    tables_after, versions_after = _schema(db)
    assert tables_after == tables_before and versions_after == versions_before
    assert sorted(db.scalars(select(Role.code))) == roles_before
    for table in Base.metadata.sorted_tables:
        if table.name != "roles":
            assert db.scalar(text(f'SELECT count(*) FROM "{table.name}"')) == 0, table.name
    # Then the fresh start: calendar and admin only, and the admin can sign in.
    set_calendar(db, "Asia/Kolkata", parse_weekdays("Mon-Fri"), [])
    sync_admin(db, ADMIN_EMAIL, ADMIN_PASSWORD)
    db.commit()
    assert db.scalar(select(func.count()).select_from(Employee)) == 1
    _signed_in(ADMIN_EMAIL, ADMIN_PASSWORD)


def test_clear_data_refuses_when_unknown_tables_exist(world, db):
    db.execute(text("CREATE TABLE stray_table (id int)"))
    with pytest.raises(ValueError, match="stray_table"):
        clear_data(db, db.scalar(text("SELECT current_database()")))
    db.rollback()
    assert db.scalar(select(func.count()).select_from(Employee)) > 0


# ---------- set-calendar ----------

def test_weekday_parsing():
    assert parse_weekdays("Mon-Fri") == [0, 1, 2, 3, 4]
    assert parse_weekdays("mon - sat") == [0, 1, 2, 3, 4, 5]
    assert parse_weekdays("Mon,Wed, Friday") == [0, 2, 4]
    for bad in ("", "Fri-Mon", "Funday", "Mon-Tue-Wed"):
        with pytest.raises(ValueError):
            parse_weekdays(bad)


def test_set_calendar_creates_then_updates_the_default(db):
    calendar = set_calendar(db, "Asia/Kolkata", [0, 1, 2, 3, 4], [date(2027, 1, 26)])
    db.commit()
    assert calendar.is_default and calendar.timezone == "Asia/Kolkata" and calendar.working_weekdays == [0, 1, 2, 3, 4]
    set_calendar(db, "Asia/Kolkata", [0, 1, 2, 3, 4, 5], [date(2027, 1, 26)])
    db.commit()
    db.expire_all()
    [only] = db.scalars(select(WorkingCalendar)).all()
    assert only.working_weekdays == [0, 1, 2, 3, 4, 5] and [h.holiday_date for h in only.holidays] == [date(2027, 1, 26)]
    with pytest.raises(ValueError, match="timezone"):
        set_calendar(db, "Mars/Olympus", [0], [])


# ---------- Demo data is never loaded on its own ----------

def test_starting_the_application_loads_no_data(db):
    with TestClient(app) as client:  # Runs the startup (lifespan) code.
        assert client.get("/api/v1/demo/status").json()["data"]["reset_enabled"] is False
    assert db.scalar(select(func.count()).select_from(Employee)) == 0
    for table in Base.metadata.sorted_tables:
        with get_engine().connect() as connection:
            assert connection.execute(text(f'SELECT count(*) FROM "{table.name}"')).scalar() == 0, table.name


def test_the_seed_command_refuses_without_the_database_name(db, monkeypatch):
    for argv in (["seed"], ["seed", "--reset"], ["seed", "--reset", "--confirm-database", "wrong"], ["seed", "--confirm-database"]):
        monkeypatch.setattr(sys, "argv", argv)
        with pytest.raises(SystemExit) as exited:
            seed_module.main()
        assert "--confirm-database" in str(exited.value.code)
    assert db.scalar(select(func.count()).select_from(Employee)) == 0
