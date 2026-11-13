"""Role and data boundaries. TC-RBAC-*, SEC-001, -002, -003, -009, -011, -014."""
from datetime import timedelta

from fastapi.routing import APIRoute
from sqlalchemy import func, select

from app.core import clock
from app.core.deps import require_admin
from app.main import app
from app.models import AuditLog, ManagerAssignment, TrainingBatch
from tests.conftest import NOW, start, take

ADMIN_READ_FOR_HR = [
    "/admin/trainings",
    "/admin/departments",
    "/admin/functions",
    "/admin/batches",
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


def test_manager_sees_only_own_team(world, client_for, db):  # TC-RBAC-003
    training = world.training()
    world.complete(world.employee, training)
    world.complete(world.outsider, training)
    rows = client_for(world.manager).get("/manager/team-assessments").json()["data"]
    assert {r["employee_code"] for r in rows} == {"E1"}
    people = client_for(world.manager).get("/manager/team-employees").json()["data"]
    assert {p["employee_code"] for p in people} == {"E1", "E2"}


def test_manager_cannot_open_another_team_member(world, client_for):  # TC-RBAC-004, SEC-002
    client = client_for(world.manager)
    assert client.get(f"/manager/team/{world.employee.id}").status_code == 200
    assert client.get(f"/manager/team/{world.outsider.id}").status_code == 404


def test_manager_filters_cannot_widen_scope(world, client_for):  # SEC-014
    training = world.training()
    world.complete(world.employee, training)
    world.complete(world.outsider, training)
    client = client_for(world.manager)
    url = f"/reports/analytics?manager_id={world.other_manager.id}"
    assert client.get(url).json()["data"]["summary"]["employees"] == 0
    url = f"/reports/analytics?department_id={world.departments['CX'].id}"
    assert client.get(url).json()["data"]["summary"]["employees"] == 0


def test_reassignment_ends_former_manager_access(world, client_for, db):  # TC-RBAC-009
    client = client_for(world.manager)
    assert client.get(f"/manager/team/{world.employee.id}").status_code == 200
    assignment = db.scalar(select(ManagerAssignment).where(ManagerAssignment.employee_id == world.employee.id))
    assignment.effective_to = (NOW - timedelta(days=1)).date()
    db.add(ManagerAssignment(employee_id=world.employee.id, manager_employee_id=world.other_manager.id, effective_from=NOW.date()))
    db.commit()
    assert client.get(f"/manager/team/{world.employee.id}").status_code == 404
    assert client_for(world.other_manager).get(f"/manager/team/{world.employee.id}").status_code == 200


def test_admin_can_manage_training(world, client_for, db):  # TC-RBAC-005
    from app.models import AuditLog

    response = client_for(world.admin).post("/admin/trainings", json={"title": "New programme", "training_code": "NEW1"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "DRAFT"
    assert db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_CREATED")) is not None


def test_employee_cannot_use_admin_or_manager_routes(world, client_for):  # TC-RBAC-006
    client = client_for(world.employee)
    assert client.post("/admin/trainings", json={"title": "Nope"}).status_code == 403
    for path in ("/admin/questions", "/admin/trainings", "/admin/audit-logs", "/manager/dashboard", "/reports/filter-options", "/scorecards"):
        assert client.get(path).status_code == 403, path


def test_mass_assignment_is_rejected(world, client_for):  # Security §8
    response = client_for(world.admin).post("/admin/trainings", json={"title": "Sneaky", "status": "ACTIVE"})
    assert response.status_code == 400


def test_hr_is_read_only(world, client_for):  # TC-RBAC-007, SEC-003, SEC-011
    training = world.training()
    client = client_for(world.hr)
    for path in ADMIN_READ_FOR_HR:
        assert client.get(path).status_code == 200, path
    attempts = [
        client.post("/admin/trainings", json={"title": "Nope"}),
        client.patch(f"/admin/trainings/{training.id}", json={"title": "Nope"}),
        client.post(f"/admin/trainings/{training.id}/status", json={"status": "ARCHIVED"}),
        client.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 10, "duration_minutes": 10, "pass_mark_percent": 1}),
        client.post("/admin/questions", json={}),
        client.post("/admin/departments", json={"code": "X", "name": "X"}),
        client.post("/admin/enrolments", json={"training_id": str(training.id), "employee_ids": []}),
    ]
    for response in attempts:
        assert response.status_code in (400, 403)
        assert response.status_code == 403 or response.json()["error"]["code"] == "VALIDATION_ERROR"
    # Body validation can run before the role check, so confirm the role check independently.
    assert client.post("/admin/trainings", json={"title": "Valid title"}).status_code == 403
    assert client.post("/admin/departments", json={"code": "XX", "name": "Valid"}).status_code == 403


def test_every_mutating_admin_route_is_ld_only():
    """HR/Leadership cannot write by accident: every non-GET /admin route requires the L&D role."""
    from tests.test_gate import dependency_calls

    missing = []
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/v1/admin") and route.methods - {"GET", "HEAD"}:
            if require_admin not in dependency_calls(route):
                missing.append((route.path, sorted(route.methods)))
    assert missing == []


def test_batches_sessions_and_audit_logs_are_withdrawn_from_ld_admin(world, client_for, db):
    """Batches & Sessions writes and the Audit Logs reader are refused for every role, L&D Admin included.
    Batch records stay readable for assignments, and audit events keep being recorded."""
    training = world.training()
    batch_id = client_for(world.admin).get(f"/admin/batches?training_id={training.id}").json()["data"][0]["id"]
    for person in (world.admin, world.hr, world.manager, world.employee):
        client = client_for(person)
        assert client.post("/admin/batches", json={"training_id": str(training.id), "name": "New batch"}).status_code == 403
        assert client.post(f"/admin/batches/{batch_id}/sessions", json={"title": "Day 1", "session_date": "2026-11-10"}).status_code == 403
        assert client.get("/admin/audit-logs").status_code == 403
    assert client_for(world.hr).get("/admin/batches").status_code == 200  # HR read scope unchanged.
    assert db.scalar(select(func.count()).select_from(TrainingBatch)) >= 1  # Nothing deleted.

    admin = client_for(world.admin)
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
