"""Mandatory assessment gate. TC-GATE-*, MVP-010 to MVP-014, BR-GATE-*."""
from datetime import timedelta

from fastapi.routing import APIRoute

from app.core.deps import require_gate_clear, require_session
from app.main import app
from tests.conftest import NOW, take

# The explicit allowlist from Business Rules §5.4 and Security §6.2. Adding to it is a security decision.
GATE_EXEMPT = {
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/me",
    "/api/v1/auth/change-password",
    "/api/v1/auth/sso/providers",
    "/api/v1/auth/sso/{provider}/start",
    "/api/v1/me/access-state",
    "/api/v1/me/assessment-queue",
    "/api/v1/system/ping",
    "/api/v1/me/assessment-obligations/{obligation_id}",
    "/api/v1/assessment-obligations/{obligation_id}/attempts",
    "/api/v1/attempts/{attempt_id}",
    "/api/v1/attempts/{attempt_id}/questions/{attempt_question_id}/answer",
    "/api/v1/attempts/{attempt_id}/questions/{attempt_question_id}/mark",
    "/api/v1/attempts/{attempt_id}/security-events",
    "/api/v1/attempts/{attempt_id}/submit",
    "/api/v1/attempts/{attempt_id}/result",
    "/api/v1/assessment-obligations/{obligation_id}/refresher-acknowledgement",
}


def dependency_calls(route: APIRoute) -> set:
    seen, stack = set(), [route.dependant]
    while stack:
        current = stack.pop()
        for dep in current.dependencies:
            seen.add(dep.call)
            stack.append(dep)
    return seen


def test_every_route_outside_the_allowlist_enforces_the_gate():
    """A new route cannot quietly skip the gate: this fails unless it uses require_gate_clear."""
    missing = []
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/v1") and route.path not in GATE_EXEMPT:
            if require_gate_clear not in dependency_calls(route):
                missing.append(route.path)
    assert missing == []


def test_exempt_routes_other_than_public_ones_still_need_a_session():
    public = {"/api/v1/auth/login", "/api/v1/auth/sso/providers", "/api/v1/auth/sso/{provider}/start", "/api/v1/system/ping"}
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path in GATE_EXEMPT - public:
            assert require_session in dependency_calls(route), route.path


def test_no_pending_assessment_opens_dashboard(world, client_for):  # TC-AUTH-001
    client = client_for(world.employee)
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get("/me/dashboard").status_code == 200


def test_login_returns_gate_details(world, client_for):  # TC-GATE-001
    training = world.training()
    world.complete(world.employee, training)
    response = world and client_for(world.employee).get("/me/access-state").json()["data"]
    assert response["access_status"] == "ASSESSMENT_REQUIRED"
    item = response["queue"][0]
    assert item["training_title"] == training.title
    assert item["question_count"] == 10
    assert item["duration_seconds"] == 900
    assert item["pass_mark_percent"] == 70.0


def test_protected_apis_are_blocked_while_gate_active(world, client_for):  # TC-GATE-002, -003, SEC-004
    world.complete(world.employee, world.training())
    client = client_for(world.employee)
    for path in ("/me/dashboard", "/me/trainings", "/me/notifications", "/me/behaviour-reviews", "/search?q=a", "/reports/catalogue", "/reports/exports"):
        response = client.get(path)
        assert response.status_code == 403, path
        assert response.json()["error"]["code"] == "ASSESSMENT_REQUIRED"


def test_gate_blocks_managers_and_admins_with_due_training(world, client_for):  # BR §5.4
    training = world.training()
    world.complete(world.manager, training)
    world.complete(world.admin, training)
    assert client_for(world.manager).get("/manager/dashboard").json()["error"]["code"] == "ASSESSMENT_REQUIRED"
    assert client_for(world.admin).get("/admin/trainings").json()["error"]["code"] == "ASSESSMENT_REQUIRED"


def test_new_session_cannot_bypass_gate(world, client_for):  # TC-GATE-004
    world.complete(world.employee, world.training())
    client_for(world.employee)
    assert client_for(world.employee).get("/me/dashboard").status_code == 403


def test_client_supplied_values_do_not_clear_gate(world, client_for):  # TC-GATE-004
    world.complete(world.employee, world.training())
    client = client_for(world.employee)
    response = client.get("/me/dashboard?gateCleared=true", headers={"X-Gate-Cleared": "true"}, cookies={"gateCleared": "true"})
    assert response.status_code == 403


def test_queue_is_oldest_completion_first_and_recalculated(world, client_for, db):  # TC-GATE-005, -008
    newer = world.training("TNEW")
    older = world.training("TOLD")
    new_obligation = world.complete(world.employee, newer, NOW - timedelta(days=1))
    old_obligation = world.complete(world.employee, older, NOW - timedelta(days=3))
    client = client_for(world.employee)
    queue = client.get("/me/assessment-queue").json()["data"]
    assert [q["obligation_id"] for q in queue] == [str(old_obligation.id), str(new_obligation.id)]

    # The later assessment cannot be taken out of order.
    response = client.post(f"/assessment-obligations/{new_obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ASSESSMENT_NOT_NEXT"

    result = take(db, client, old_obligation.id, 10)
    assert result["access_state"]["access_status"] == "ASSESSMENT_REQUIRED"
    assert result["access_state"]["queue"][0]["obligation_id"] == str(new_obligation.id)
    assert client.get("/me/dashboard").status_code == 403

    result = take(db, client, new_obligation.id, 10)
    assert result["access_state"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get("/me/dashboard").status_code == 200


def test_not_yet_due_does_not_block(world, client_for):  # TC-GATE-006
    training = world.training(schedule_mode="DELAY_DAYS", schedule_delay_days=30)
    world.complete(world.employee, training, NOW - timedelta(days=1))
    assert client_for(world.employee).get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


def test_waiver_clears_gate_with_reason_and_audit(world, client_for, db):  # TC-GATE-007
    from sqlalchemy import select

    from app.models import AssessmentObligation, AuditLog

    obligation = world.complete(world.employee, world.training())
    employee = client_for(world.employee)
    assert employee.get("/me/dashboard").status_code == 403
    admin = client_for(world.admin)
    assert admin.post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "x"}).status_code == 400
    assert admin.post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "On approved leave"}).status_code == 200
    assert employee.get("/me/dashboard").status_code == 200
    db.expire_all()
    stored = db.get(AssessmentObligation, obligation.id)
    assert stored.status == "WAIVED" and stored.outcome is None  # A waiver is never recorded as a pass.
    assert db.scalar(select(AuditLog).where(AuditLog.action == "ASSESSMENT_WAIVED")).reason == "On approved leave"


def test_session_expiry_requires_login_and_gate_remains(world, client_for):  # TC-GATE-009
    from app.core import clock

    world.complete(world.employee, world.training())
    client = client_for(world.employee)
    clock.freeze(NOW + timedelta(hours=13))
    assert client.get("/me/access-state").status_code == 401
    assert client_for(world.employee).get("/me/dashboard").status_code == 403


def test_database_outage_fails_closed(world, client_for, monkeypatch):  # TC-GATE-010
    from sqlalchemy.exc import OperationalError

    from app.core import deps

    world.complete(world.employee, world.training())
    client = client_for(world.employee)

    def down(*_, **__):
        raise OperationalError("select", {}, Exception("connection lost"))

    import app.modules.assessment.gate as gate

    monkeypatch.setattr(gate, "blocking_obligations", down)
    client.http = type(client.http)(app, raise_server_exceptions=False, cookies=dict(client.http.cookies))
    response = client.get("/me/dashboard")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    assert deps is not None


def test_pre_test_never_blocks_login(world, client_for, db):  # SC-2L-107
    from app.core.enums import AssessmentType
    from app.models import AssessmentConfig

    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=5, duration_seconds=300, max_attempts=1))
    db.commit()
    enrolment = world.enrol(world.employee, training)
    client = client_for(world.employee)
    started = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert started.status_code == 200, started.text
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get("/me/dashboard").status_code == 200
