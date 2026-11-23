"""Role and data boundaries. TC-RBAC-*, SEC-001, -002, -003, -009, -011, -014."""

from sqlalchemy import func, select

from app.core import clock
from app.core.deps import require_admin
from app.models import AuditLog, TrainingBatch, TrainingSession
from tests.conftest import NOW, start, take

ADMIN_READ = [
    "/admin/trainings",
    "/admin/departments",
    "/admin/functions",
    "/admin/enrolments",
    "/admin/behaviour-templates",
]


def test_employee_reads_own_result_but_not_another(world, client_for, db):  # TC-RBAC-001, -002, SEC-001
    training = world.training()
    mine = world.complete(world.employee, training)
    theirs = world.complete(world.teammate, training)
    result = take(db, client_for(world.employee), mine.id, 10)
    other = client_for(world.teammate)
    assert other.get(f"/attempts/{result['attempt_id']}/result").status_code == 404
    assert other.get(f"/attempts/{result['attempt_id']}").status_code == 404
    assert other.post(f"/attempts/{result['attempt_id']}/submit").status_code == 404
    assert other.get(f"/me/assessment-obligations/{mine.id}").status_code == 404
    assert other.post(f"/assessment-obligations/{mine.id}/attempts", json={"instructions_acknowledged": True}).status_code == 404
    assert other.get(f"/me/assessment-obligations/{theirs.id}").status_code == 200


def test_other_person_cannot_change_a_running_attempt(world, client_for):
    training = world.training()
    mine = world.complete(world.employee, training)
    attempt = start(client_for(world.employee), mine.id)
    other = client_for(world.outsider)
    question = attempt["questions"][0]
    assert other.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": []}).status_code == 404
    assert other.post(f"/attempts/{attempt['attempt_id']}/security-events", json={"event_type": "TAB_HIDDEN"}).status_code == 404


def test_manager_and_hr_roles_are_gone(world, client_for):
    """The Manager and HR / Leadership roles were removed: their routes no longer exist, and the people who
    held them are ordinary employees with no organisation-wide or team read access."""
    from app.core.enums import RoleCode

    assert {r.value for r in RoleCode} == {"EMPLOYEE", "LD_ADMIN"}
    world.complete(world.employee, world.training())
    for person in (world.manager, world.hr):
        client = client_for(person)
        for path in ("/manager/dashboard", "/manager/team-employees", f"/manager/team/{world.employee.id}", "/manager/behaviour-reviews", "/reports/manager-evaluation"):
            assert client.get(path).status_code == 404, path
        for path in ADMIN_READ:
            assert client.get(path).status_code == 403, path
        for path in ("/reports/filter-options", "/reports/organisation-summary", "/scorecards", "/reports/analytics"):
            assert client.get(path).status_code == 403, path
        assert client.get("/me/trainings").status_code == 200  # Still an employee.


def test_admin_can_manage_training(world, client_for, db):  # TC-RBAC-005
    from app.models import AuditLog

    response = client_for(world.admin).post("/admin/trainings", json={"title": "New programme", "training_code": "NEW1"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "DRAFT"
    assert db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_CREATED")) is not None


def test_employee_cannot_use_admin_routes(world, client_for):  # TC-RBAC-006
    client = client_for(world.employee)
    assert client.post("/admin/trainings", json={"title": "Nope"}).status_code == 403
    for path in ("/admin/questions", "/admin/trainings", "/reports/filter-options", "/scorecards"):
        assert client.get(path).status_code == 403, path


def test_mass_assignment_is_rejected(world, client_for):  # Security §8
    response = client_for(world.admin).post("/admin/trainings", json={"title": "Sneaky", "status": "ACTIVE"})
    assert response.status_code == 400


def test_every_mutating_admin_route_is_ld_only():
    """Every non-GET /admin route requires the L&D role."""
    from tests.test_gate import api_routes, dependency_calls

    missing, checked = [], 0
    for route in api_routes("/api/v1/admin"):
        if route.methods - {"GET", "HEAD"}:
            checked += 1
            if require_admin not in dependency_calls(route):
                missing.append((route.path, sorted(route.methods)))
    assert checked >= 20, f"only {checked} mutating admin routes inspected"
    assert missing == []


def test_batches_sessions_and_audit_logs_apis_are_removed(world, client_for, db):
    """The withdrawn Batches & Sessions and Audit Logs features are removed (audit P5): their APIs no longer exist
    for any role. Historical batch records, batches in assignment lists and in the reports that keep a Batch column,
    and background audit recording are unaffected. The Compliance report has no Batch column (approved decision)."""
    from tests.test_gate import api_routes

    training = world.training()
    batch = db.scalar(select(TrainingBatch).where(TrainingBatch.training_id == training.id))
    db.add(TrainingSession(batch_id=batch.id, title="Historical day 1", session_date=NOW.date(), delivery_mode="Virtual"))  # Historical record.
    db.commit()
    batch_before = (batch.id, batch.batch_code, batch.name, batch.training_id)
    batches_before = db.scalar(select(func.count()).select_from(TrainingBatch))
    sessions_before = db.scalar(select(func.count()).select_from(TrainingSession))

    # 5. The withdrawn APIs stay unavailable, for every role, and are not in the route table.
    removed = [
        ("GET", "/admin/batches"),
        ("POST", "/admin/batches"),
        ("POST", f"/admin/batches/{batch.id}/sessions"),
        ("GET", "/admin/audit-logs"),
    ]
    for person in (world.admin, world.hr, world.manager, world.employee):
        client = client_for(person)
        for method, path in removed:
            body = {"training_id": str(training.id), "name": "New batch", "title": "Day 1", "session_date": "2026-11-10"}
            response = client.post(path, json=body) if method == "POST" else client.get(path)
            assert response.status_code == 404, (person.employee_code, method, path, response.status_code)
    paths = {route.path for route in api_routes("/api/v1/admin")}
    assert not {p for p in paths if p.startswith(("/api/v1/admin/batches", "/api/v1/admin/audit-logs"))}

    # 3. Assigning into an existing batch still works, and the assignment list keeps the batch.
    admin = client_for(world.admin)
    assigned = admin.post("/admin/enrolments", json={"training_id": str(training.id), "batch_id": str(batch.id), "employee_ids": [str(world.employee.id)]})
    assert assigned.status_code == 200 and assigned.json()["data"]["created"] == 1, assigned.text
    listed = admin.get(f"/admin/enrolments?training_id={training.id}").json()["data"]
    assert [row["batch_name"] for row in listed] == [batch.name]

    # 1, 2, 4. Compliance has no Batch column; Pass/Fail and Employee History keep theirs; every row fits its columns.
    def report(code: str) -> tuple[list[str], list[dict]]:
        data = admin.get(f"/reports/{code}?training_id={training.id}").json()["data"]
        return data["columns"], [dict(zip(data["columns"], row, strict=True)) for row in data["rows"]]  # strict: a row of another length fails.

    compliance_columns, compliance_rows = report("compliance")
    assert "Batch" not in compliance_columns and len(compliance_rows) == 1
    assert compliance_rows[0]["Employee ID"] == world.employee.employee_code
    for code in ("pass-fail", "employee-history"):
        columns, rows = report(code)
        assert "Batch" in columns, code
        assert rows and {row["Batch"] for row in rows} == {batch.name}, code

    # 6. Historical batch records are untouched, and audit events are still recorded in the background.
    db.expire_all()
    assert (batch.id, batch.batch_code, batch.name, batch.training_id) == batch_before
    assert db.scalar(select(func.count()).select_from(TrainingBatch)) == batches_before
    assert db.scalar(select(func.count()).select_from(TrainingSession)) == sessions_before >= 1
    assert db.scalar(select(TrainingSession.title).where(TrainingSession.batch_id == batch.id)) == "Historical day 1"
    assert db.scalar(select(AuditLog).where(AuditLog.action == "EMPLOYEES_ASSIGNED")) is not None
    assert admin.post("/admin/trainings", json={"title": "Still audited", "training_code": "AUD1"}).status_code == 200
    assert db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_CREATED")) is not None


def test_answer_keys_are_only_for_ld(world, client_for, db):  # Security §3
    training = world.training()
    from app.models import Question

    question = db.scalar(select(Question))
    assert "is_correct" in client_for(world.admin).get(f"/admin/questions/{question.id}").text
    assert client_for(world.hr).get(f"/admin/questions/{question.id}").status_code == 403
    assert client_for(world.employee).get(f"/admin/questions/{question.id}").status_code == 403
    assert "is_correct" not in client_for(world.admin).get("/admin/questions").text
    assert training is not None


def test_notifications_are_private(world, client_for, db):
    from app.modules.notifications.service import notify_employee

    notify_employee(db, world.employee.id, "X", "Private", "Secret", None, "k1", NOW)
    db.commit()
    mine = client_for(world.employee).get("/me/notifications").json()["data"]
    assert len(mine) == 1
    other = client_for(world.teammate)
    assert other.get("/me/notifications").json()["data"] == []
    assert other.patch(f"/me/notifications/{mine[0]['id']}", json={"read": True}).status_code == 404


def test_search_is_scoped(world, client_for):
    training = world.training()
    world.complete(world.teammate, training)
    world.enrol(world.employee, world.training("OTHER"))
    client = client_for(world.employee)
    titles = [r["title"] for r in client.get("/search?q=training").json()["data"]]
    assert titles == ["Training OTHER"]
    assert client.get("/search?q=Person").json()["data"] == []
    clock.freeze(NOW)


def test_admin_search_finds_people_and_trainings_without_loading_everyone(world, client_for, db, monkeypatch):
    """Search reads only matching names (audit F-12), never the whole organisation's assessment history."""
    from app.modules.audit import router as audit_router
    from tests.conftest import take

    training = world.training("SRCH")
    for person in (world.employee, world.teammate, world.outsider):
        obligation = world.complete(person, training)
        take(db, client_for(person), obligation.id, 8)
    admin = client_for(world.admin)

    def refuse(*_args, **_kwargs):
        raise AssertionError("search loaded every enrolment and attempt")

    monkeypatch.setattr(audit_router, "load_rows", refuse)
    found = admin.get("/search?q=e2").json()["data"]
    trainings = admin.get("/search?q=training srch").json()["data"]
    wildcard = admin.get("/search?q=%25").json()["data"]
    assert [(r["type"], r["subtitle"]) for r in found] == [("employee", "E2")]
    assert [(r["type"], r["title"]) for r in trainings] == [("training", "Training SRCH")]
    assert wildcard == []  # A literal %, not a wildcard.
