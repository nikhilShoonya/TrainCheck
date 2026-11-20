"""Employee Assignments: the employee list (from employee records) and one employee's assignments.

GET /admin/employees lists every employee record once, with or without assignments, and never account or password
data. GET /admin/enrolments?employee_id= returns only that employee's live (not cancelled) assignments.
"""
from sqlalchemy import select

from app.core.enums import EnrolmentStatus
from app.models import Enrolment
from tests.conftest import ApiClient

ACCOUNT_KEYS = {"password", "password_hash", "login_email", "account_status", "roles"}


def test_employee_list_has_everyone_once_with_their_email(world, client_for, db):
    t1, t2 = world.training("T1"), world.training("T2")
    world.enrol(world.employee, t1)
    world.complete(world.employee, t2)  # Two assignments: still one row.
    world.outsider.employment_status = "INACTIVE"
    db.commit()

    response = client_for(world.admin).get("/admin/employees")
    assert response.status_code == 200
    rows = response.json()["data"]
    codes = [r["employee_code"] for r in rows]
    assert sorted(codes) == sorted({"M1", "M2", "A1", "H1", "E1", "E2", "E3"})  # Each once, admins included.
    assert len(codes) == len(set(codes))
    by_code = {r["employee_code"]: r for r in rows}
    assert by_code["E2"]["work_email"] == "teammate@test.example"  # No assignments at all: still listed.
    assert by_code["E3"]["employment_status"] == "INACTIVE"  # Inactive employees are listed and marked.
    assert by_code["E1"]["department"] == "Ops"
    for row in rows:
        assert not ACCOUNT_KEYS & set(row), row
    assert "argon2" not in response.text and "TestPassword123" not in response.text


def test_one_employees_assignments_only_live_ones(world, client_for, db):
    t1, t2, t3 = world.training("T1"), world.training("T2"), world.training("T3")
    world.enrol(world.employee, t1)  # Pending.
    world.complete(world.employee, t2)  # Completed.
    cancelled = world.enrol(world.employee, t3)
    cancelled.enrolment_status = EnrolmentStatus.CANCELLED
    world.enrol(world.teammate, t1)  # Someone else's.
    db.commit()

    admin = client_for(world.admin)
    rows = admin.get(f"/admin/enrolments?employee_id={world.employee.id}").json()["data"]
    assert {r["training_id"] for r in rows} == {str(t1.id), str(t2.id)}
    assert {r["employee_id"] for r in rows} == {str(world.employee.id)}
    assert sorted(bool(r["completed_at"]) for r in rows) == [False, True]

    assert admin.get(f"/admin/enrolments?employee_id={world.hr.id}").json()["data"] == []  # No assignments.
    assert admin.get("/admin/enrolments?employee_id=00000000-0000-0000-0000-000000000009").json()["data"] == []
    assert admin.get("/admin/enrolments?employee_id=Person%20E1").status_code == 400  # IDs only, never names.
    # Without the filter the page's other users (Training Completion, search) see the same rows as before.
    assert {r["employee_id"] for r in admin.get("/admin/enrolments").json()["data"]} == {str(world.employee.id), str(world.teammate.id)}


def test_only_ld_admin_can_list_employees_or_their_assignments(world, client_for):
    employee = client_for(world.employee)
    assert employee.get("/admin/employees").status_code == 403
    assert employee.get(f"/admin/enrolments?employee_id={world.employee.id}").status_code == 403
    anonymous = ApiClient()
    assert anonymous.get("/admin/employees").status_code == 401
    assert anonymous.get(f"/admin/enrolments?employee_id={world.employee.id}").status_code == 401


# ---------- The designated L&D Admin sign-in record (TC-LD-ADMIN) is never shown as an employee ----------

def _designated_admin(world):
    """As `manage.py sync-admin` makes it: reserved Employee ID, L&D Admin role only, no department."""
    admin = world.person("TC-LD-ADMIN", "admin.traincheck@test.example", ["LD_ADMIN"])
    admin.full_name, admin.department_id = "L&D Admin", None
    world.db.commit()
    return admin


def test_the_designated_admin_is_not_listed_counted_or_searched(world, client_for, db):
    designated = _designated_admin(world)
    t1 = world.training("T1")
    # Even an assignment made before this rule (directly in the database) stays out of every view.
    world.enrol(designated, t1)
    world.enrol(world.employee, t1)
    admin = client_for(world.admin)

    listed = admin.get("/admin/employees").json()["data"]
    assert "TC-LD-ADMIN" not in {r["employee_code"] for r in listed}
    assert "A1" in {r["employee_code"] for r in listed}  # An admin who is also an employee stays a learner.
    assert admin.get(f"/admin/enrolments?employee_id={designated.id}").json()["data"] == []
    assert str(designated.id) not in {r["employee_id"] for r in admin.get("/admin/enrolments").json()["data"]}
    assert str(designated.id) not in {r["employee_id"] for r in admin.get(f"/admin/enrolments?training_id={t1.id}").json()["data"]}

    dashboard = admin.get("/admin/dashboard").json()["data"]
    assert dashboard["total_employees"] == 7  # The World's seven people; not the designated admin.
    assert admin.get("/search?q=TC-LD").json()["data"] == []
    assert admin.get("/search?q=L%26D%20Admin").json()["data"] == []
    # Signing in as the designated admin still works.
    assert ApiClient().login("admin.traincheck@test.example").status_code == 200


def test_the_designated_admin_cannot_be_assigned_or_imported(world, client_for, db):
    designated = _designated_admin(world)
    t1 = world.training("T1")
    admin = client_for(world.admin)

    everyone = admin.post("/admin/enrolments", json={"training_id": str(t1.id), "employee_ids": [], "use_training_target": True}).json()["data"]
    assert "TC-LD-ADMIN" not in {r["employee_code"] for r in everyone["results"]}
    picked = admin.post("/admin/enrolments", json={"training_id": str(t1.id), "employee_ids": [str(designated.id)]}).json()["data"]
    assert picked["created"] == 0 and picked["results"][0]["status"] == "NOT_FOUND"
    db.expire_all()
    assert not [e for e in db.scalars(select(Enrolment).where(Enrolment.employee_id == designated.id))]

    rows = [["employee", "training", "completion_date"], ["TC-LD-ADMIN", "T1", "2026-11-01"]]
    upload = admin.post("/admin/imports", data={"import_type": "COMPLETIONS"}, files={"file": ("c.csv", "\n".join(",".join(r) for r in rows).encode(), "text/csv")})
    assert upload.status_code == 200, upload.text
    assert upload.json()["data"]["accepted_rows"] == 0
    assert "Unknown employee ID." in upload.text
