"""Training Completion > Mark Selected Completed / Waive Selected, verified against the real API and database.

The page sends one request per selected employee to the existing individual endpoints
(POST /admin/enrolments/{id}/completion and POST /admin/obligations/{id}/waive). These tests replay that
traffic: each request must be validated, committed or rolled back and audited on its own, so a selection is
never one atomic transaction and partial results must be exactly what the database holds.
"""
import threading
import time
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.config import get_settings
from app.main import app
from app.models import AssessmentAttempt, AssessmentObligation, AuditLog, Enrolment, Training, TrainingCompletion, UserSession
from app.modules.training import router as training_router
from app.modules.training import service as training_service
from tests.conftest import NOW, ApiClient, start, take

TODAY = NOW.date().isoformat()
REASON = "Approved exemption for this synthetic training"


# ---------- helpers ----------

def _people(world, count: int, prefix: str = "B"):
    people = [world.person(f"{prefix}{i}", f"{prefix.lower()}{i}@test.example", ["EMPLOYEE"], "OPS", "COMPLIANCE") for i in range(count)]
    world.db.commit()
    return people


def _complete(admin, enrolment, **body):
    return admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": TODAY, **body})


def _waive(admin, obligation_id, reason=REASON):
    return admin.post(f"/admin/obligations/{obligation_id}/waive", json={"reason": reason})


def _audits(db, action: str) -> list[AuditLog]:
    db.expire_all()
    return list(db.scalars(select(AuditLog).where(AuditLog.action == action)))


def _completions(db) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(TrainingCompletion))


def _post_tests(db, enrolment) -> list[AssessmentObligation]:
    db.expire_all()
    return list(db.scalars(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == "POST_TEST")))


def _row(admin, training, enrolment) -> dict:
    rows = admin.get(f"/admin/enrolments?training_id={training.id}").json()["data"]
    return next(r for r in rows if r["id"] == str(enrolment.id))


def _admin_without_raising(world) -> ApiClient:
    """An admin client that receives a 500 response instead of the server exception, as the browser would."""
    client = ApiClient()
    client.http = TestClient(app, raise_server_exceptions=False, client=("testclient", 50000))
    assert client.login(world.admin.work_email).status_code == 200
    return client


# ---------- Mark Selected Completed ----------

def test_selected_completions_commit_per_employee_and_report_each_refusal(world, db, client_for):
    """Recorded attendance (the dialog's default): Pending becomes Present, Present stays, Partial follows the policy
    (off here), Absent/Excused are refused. Successes are committed and audited; refusals leave nothing behind."""
    training = world.training()
    pending, present, partial, absent, excused = _people(world, 5)
    enrolments = {p.employee_code: world.enrol(p, training) for p in (pending, present, partial, absent, excused)}
    admin = client_for(world.admin)
    for code, status in (("B1", "PRESENT"), ("B2", "PARTIAL"), ("B3", "ABSENT"), ("B4", "EXCUSED")):
        assert admin.patch(f"/admin/enrolments/{enrolments[code].id}/attendance", json={"attendance_status": status}).status_code == 200

    replies = {code: _complete(admin, e) for code, e in enrolments.items()}  # No attendance_status: "use recorded".

    assert {c: r.status_code for c, r in replies.items()} == {"B0": 200, "B1": 200, "B2": 409, "B3": 409, "B4": 409}
    assert {c: replies[c].json()["error"]["code"] for c in ("B2", "B3", "B4")} == {c: "ATTENDANCE_NOT_COMPLETABLE" for c in ("B2", "B3", "B4")}
    for code in ("B0", "B1"):
        data = replies[code].json()["data"]
        assert data["attendance_status"] == "PRESENT" and data["completed_at"] and data["completion_source"] == "MANUAL"
        assert data["assessment_scheduling"]["status"] == "SCHEDULED"
        assert data["outcome"] is None and data["assessment_state"] in ("Due", "Scheduled")  # Never a pass.
    assert _completions(db) == 2
    audited = _audits(db, "COMPLETION_RECORDED")
    assert sorted(a.target_id for a in audited) == sorted(str(enrolments[c].id) for c in ("B0", "B1"))
    assert all(a.after_summary["date"] == TODAY and a.actor_user_id is not None for a in audited)
    for code, kept in (("B2", "PARTIAL"), ("B3", "ABSENT"), ("B4", "EXCUSED")):
        row = _row(admin, training, enrolments[code])
        assert (row["completed_at"], row["attendance_status"], row["obligation_id"]) == (None, kept, None)
        assert _post_tests(db, enrolments[code]) == []


def test_partial_attendance_follows_the_backend_policy(world, db, client_for, monkeypatch):
    training = world.training()
    (person,) = _people(world, 1)
    enrolment = world.enrol(person, training)
    admin = client_for(world.admin)
    admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "PARTIAL"})
    assert _complete(admin, enrolment).json()["error"]["code"] == "ATTENDANCE_NOT_COMPLETABLE"
    monkeypatch.setattr(get_settings(), "completion_allows_partial_attendance", True)
    done = _complete(admin, enrolment)
    assert done.status_code == 200, done.text
    assert done.json()["data"]["attendance_status"] == "PARTIAL"  # Recorded attendance is preserved, not upgraded.


def test_explicit_common_attendance_is_applied_and_still_validated(world, db, client_for):
    training = world.training()
    pending, partial, pending_two = _people(world, 3)
    e_pending, e_partial, e_pending_two = (world.enrol(p, training) for p in (pending, partial, pending_two))
    admin = client_for(world.admin)
    admin.patch(f"/admin/enrolments/{e_partial.id}/attendance", json={"attendance_status": "PARTIAL"})

    assert _complete(admin, e_pending, attendance_status="PRESENT").json()["data"]["attendance_status"] == "PRESENT"
    assert _complete(admin, e_partial, attendance_status="PRESENT").json()["data"]["attendance_status"] == "PRESENT"
    # "Partial for all selected employees" with the policy off: refused per employee, nothing recorded.
    refused = _complete(admin, e_pending_two, attendance_status="PARTIAL")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "ATTENDANCE_NOT_COMPLETABLE"
    assert _row(admin, training, e_pending_two)["attendance_status"] == "PENDING"
    # Values the dialog never offers are rejected by the schema.
    for value in ("ABSENT", "EXCUSED"):
        assert _complete(admin, e_pending_two, attendance_status=value).status_code == 409
    assert _complete(admin, e_pending_two, attendance_status="SOMETIMES").status_code == 400
    assert _completions(db) == 2


@pytest.mark.parametrize(
    "date_value",
    [(NOW + timedelta(days=1)).date().isoformat(), "2026-13-40", "", "not-a-date", None, "2026-11-04T10:00:00Z"],
)
def test_future_and_invalid_completion_dates_are_rejected(world, db, client_for, date_value):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    response = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": date_value})
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert _completions(db) == 0 and _audits(db, "COMPLETION_RECORDED") == []
    assert _row(admin, training, enrolment)["attendance_status"] == "PENDING"


def test_a_past_date_is_recorded_as_that_local_day(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    done = _complete(admin, enrolment, completion_date="2026-11-02")
    assert done.status_code == 200, done.text
    assert done.json()["data"]["completed_at"].startswith("2026-11-02T00:00:00")


def test_repeated_completion_request_does_not_duplicate_anything(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    assert _complete(admin, enrolment).status_code == 200
    again = _complete(admin, enrolment, attendance_status="PRESENT")
    assert again.status_code == 409 and again.json()["error"]["code"] == "COMPLETION_EXISTS"
    assert _completions(db) == 1
    assert len(_post_tests(db, enrolment)) == 1
    assert len(_audits(db, "COMPLETION_RECORDED")) == 1


def test_simultaneous_duplicate_completions_record_once(world, db, client_for, monkeypatch):
    """A double click or a retried request racing the first: the row lock makes the second wait, then refuse."""
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    first_admin, second_admin = client_for(world.admin), client_for(world.admin)
    real = training_service.schedule_post_test
    calls = []

    def slow_first(*args, **kwargs):  # Holds the first request inside its locked transaction for a moment.
        calls.append(1)
        if len(calls) == 1:
            time.sleep(1.0)
        return real(*args, **kwargs)

    monkeypatch.setattr(training_service, "schedule_post_test", slow_first)
    results: list[int] = []
    barrier = threading.Barrier(2)

    def send(client):
        barrier.wait()
        results.append(_complete(client, enrolment).status_code)

    threads = [threading.Thread(target=send, args=(c,)) for c in (first_admin, second_admin)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert sorted(results) == [200, 409]
    assert _completions(db) == 1
    assert len(_post_tests(db, enrolment)) == 1
    assert len(_audits(db, "COMPLETION_RECORDED")) == 1


@pytest.mark.parametrize("status", ["DRAFT", "ARCHIVED"])
def test_inactive_trainings_refuse_completion(world, db, client_for, status):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    training.status = status
    db.commit()
    response = _complete(client_for(world.admin), enrolment)
    assert response.status_code == 409 and response.json()["error"]["code"] == "TRAINING_NOT_ACTIVE"
    assert _completions(db) == 0


def test_employee_eligibility_audience_and_cancellation_are_still_enforced(world, db, client_for):
    training = world.training()
    inactive, outside, cancelled, fine = _people(world, 4)
    e_inactive, e_outside, e_cancelled, e_fine = (world.enrol(p, training) for p in (inactive, outside, cancelled, fine))
    admin = client_for(world.admin)
    assert admin.post(f"/admin/enrolments/{e_cancelled.id}/cancel", json={"reason": "Assigned by mistake"}).status_code == 200
    inactive.employment_status = "INACTIVE"
    outside.department_id = world.departments["CX"].id
    trained = db.get(Training, training.id)
    trained.target_scope = "DEPARTMENT"
    trained.departments = [world.departments["OPS"]]
    db.commit()

    codes = {name: _complete(admin, e).json().get("error", {}).get("code") for name, e in (("inactive", e_inactive), ("outside", e_outside), ("cancelled", e_cancelled))}
    assert codes == {"inactive": "INACTIVE_EMPLOYEE", "outside": "OUT_OF_TARGET", "cancelled": "ENROLMENT_CANCELLED"}
    assert _complete(admin, e_fine).status_code == 200
    assert _completions(db) == 1


def test_completion_is_kept_when_the_assessment_cannot_be_scheduled(world, db, client_for):
    short_pool = world.training("T9", questions=2, count=10)  # Pool smaller than one attempt.
    enrolment = world.enrol(world.employee, short_pool)
    admin = client_for(world.admin)
    done = _complete(admin, enrolment)
    assert done.status_code == 200, done.text
    scheduling = done.json()["data"]["assessment_scheduling"]
    assert scheduling["status"] == "NOT_SCHEDULED" and scheduling["message"]
    row = _row(admin, short_pool, enrolment)
    assert row["completed_at"] and row["outcome"] is None and row["obligation_id"] is None
    assert row["assessment_issue"]["code"] == "NOT_SCHEDULED"  # Drives the "Assessments needing attention" panel.
    assert _completions(db) == 1


def test_a_failure_inside_one_completion_rolls_back_only_that_employee(world, db, monkeypatch):
    training = world.training()
    first, broken, last = _people(world, 3)
    enrolments = [world.enrol(p, training) for p in (first, broken, last)]
    admin = _admin_without_raising(world)
    real = training_router.record_audit

    def fail_for_one(db_, actor, action, target_type=None, target_id=None, *args, **kwargs):
        if action == "COMPLETION_RECORDED" and str(target_id) == str(enrolments[1].id):
            raise RuntimeError("Simulated failure after the completion row was written")
        return real(db_, actor, action, target_type, target_id, *args, **kwargs)

    monkeypatch.setattr(training_router, "record_audit", fail_for_one)
    statuses = [_complete(admin, e).status_code for e in enrolments]
    assert statuses == [200, 500, 200]
    db.expire_all()
    recorded = set(db.scalars(select(TrainingCompletion.enrolment_id)))
    assert recorded == {enrolments[0].id, enrolments[2].id}
    assert _post_tests(db, enrolments[1]) == []
    assert db.get(Enrolment, enrolments[1].id).enrolment_status == "ASSIGNED"
    assert db.get(Enrolment, enrolments[1].id).attendance_status == "PENDING"
    # The operator can retry the failed employee once the fault is gone; the saved ones are not repeated.
    monkeypatch.setattr(training_router, "record_audit", real)
    assert _complete(admin, enrolments[1]).status_code == 200
    assert [_complete(admin, e).status_code for e in (enrolments[0], enrolments[2])] == [409, 409]
    assert _completions(db) == 3


# ---------- Waive Selected ----------

@pytest.mark.parametrize("reason", ["", "     ", "   abcd   ", "abcd", "x" * 1001, None])
def test_invalid_waiver_reasons_are_rejected_and_change_nothing(world, db, client_for, reason):
    obligation = world.complete(world.employee, world.training())
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/waive", json={"reason": reason})
    assert response.status_code == 400, response.text
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).status in ("DUE", "SCHEDULED")
    assert _audits(db, "ASSESSMENT_WAIVED") == []


def test_boundary_reasons_are_accepted_and_stored_trimmed(world, db, client_for):
    training = world.training()
    a, b = _people(world, 2)
    first, second = world.complete(a, training), world.complete(b, training)
    admin = client_for(world.admin)
    assert _waive(admin, first.id, "  abcde  ").status_code == 200
    assert _waive(admin, second.id, "y" * 1000).status_code == 200
    db.expire_all()
    assert db.get(AssessmentObligation, first.id).waiver_reason == "abcde"
    assert len(db.get(AssessmentObligation, second.id).waiver_reason) == 1000


def test_the_same_reason_is_recorded_and_audited_for_every_selected_assessment(world, db, client_for):
    training = world.training()
    obligations = [world.complete(p, training) for p in _people(world, 4)]
    admin = client_for(world.admin)
    assert [_waive(admin, o.id).status_code for o in obligations] == [200] * 4
    audits = _audits(db, "ASSESSMENT_WAIVED")
    assert sorted(a.target_id for a in audits) == sorted(str(o.id) for o in obligations)
    assert {a.reason for a in audits} == {REASON}
    assert all(a.actor_user_id is not None for a in audits)
    db.expire_all()
    assert {db.get(AssessmentObligation, o.id).waiver_reason for o in obligations} == {REASON}


def test_closed_running_and_missing_assessments_are_refused(world, db, client_for):
    training = world.training()
    submitted_p, waived_p, cancelled_p, running_p = _people(world, 4)
    submitted, waived, cancelled, running = (world.complete(p, training) for p in (submitted_p, waived_p, cancelled_p, running_p))
    admin = client_for(world.admin)
    take(db, client_for(submitted_p), submitted.id, 10)  # Passed and submitted.
    assert _waive(admin, waived.id).status_code == 200
    db.get(AssessmentObligation, cancelled.id).status = "CANCELLED"
    db.commit()
    # Selected while Due; the employee starts the attempt before L&D confirms the waiver.
    assert _row(admin, training, world.db.scalar(select(Enrolment).where(Enrolment.employee_id == running_p.id)))["assessment_state"] == "Due"
    start(client_for(running_p), running.id)

    before = len(_audits(db, "ASSESSMENT_WAIVED"))
    codes = {name: _waive(admin, o.id) for name, o in (("submitted", submitted), ("waived", waived), ("cancelled", cancelled), ("running", running))}
    assert {n: (r.status_code, r.json()["error"]["code"]) for n, r in codes.items()} == {
        "submitted": (409, "OBLIGATION_CLOSED"),
        "waived": (409, "OBLIGATION_CLOSED"),
        "cancelled": (409, "OBLIGATION_CLOSED"),
        "running": (409, "ATTEMPT_IN_PROGRESS"),
    }
    import uuid

    assert _waive(admin, uuid.uuid4()).status_code == 404
    assert _waive(admin, "not-an-id").status_code == 400
    assert len(_audits(db, "ASSESSMENT_WAIVED")) == before
    db.expire_all()
    assert db.get(AssessmentObligation, running.id).status == "IN_PROGRESS"
    assert db.get(AssessmentObligation, submitted.id).status == "COMPLETED"


def test_a_waiver_never_changes_completion_attendance_marks_or_result(world, db, client_for):
    training = world.training()
    obligation = world.complete(world.employee, training)
    admin = client_for(world.admin)
    take(db, client_for(world.employee), obligation.id, 0)  # A failed attempt with marks, attempts left.
    enrolment = db.get(Enrolment, obligation.enrolment_id)
    before_row = _row(admin, training, enrolment)
    db.expire_all()
    attempt = db.scalar(select(AssessmentAttempt).where(AssessmentAttempt.obligation_id == obligation.id))
    before_attempt = (attempt.status, attempt.obtained_marks, attempt.total_marks, attempt.score_percent, attempt.result_status)
    before_completion = db.scalar(select(TrainingCompletion).where(TrainingCompletion.enrolment_id == enrolment.id)).completed_at
    assert before_row["assessment_state"] in ("Awaiting refresher", "Awaiting approval")

    assert _waive(admin, obligation.id).status_code == 200

    after_row = _row(admin, training, enrolment)
    assert after_row["assessment_state"] == "Waived"
    for field in ("completed_at", "completion_source", "attendance_status", "outcome", "attempts_used", "due_at"):
        assert after_row[field] == before_row[field], field
    assert after_row["outcome"] != "PASSED"
    db.expire_all()
    attempt = db.get(AssessmentAttempt, attempt.id)
    assert (attempt.status, attempt.obtained_marks, attempt.total_marks, attempt.score_percent, attempt.result_status) == before_attempt
    assert db.scalar(select(TrainingCompletion).where(TrainingCompletion.enrolment_id == enrolment.id)).completed_at == before_completion
    assert _completions(db) == 1


def test_repeated_and_simultaneous_waivers_take_effect_once(world, db, client_for, monkeypatch):
    training = world.training()
    a, b = _people(world, 2)
    repeated, raced = world.complete(a, training), world.complete(b, training)
    admin = client_for(world.admin)
    assert _waive(admin, repeated.id).status_code == 200
    again = _waive(admin, repeated.id)
    assert (again.status_code, again.json()["error"]["code"]) == (409, "OBLIGATION_CLOSED")

    real = training_router.record_audit
    calls = []

    def slow_first(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            time.sleep(1.0)
        return real(*args, **kwargs)

    monkeypatch.setattr(training_router, "record_audit", slow_first)
    clients = (client_for(world.admin), client_for(world.admin))
    results: list[int] = []
    barrier = threading.Barrier(2)

    def send(client):
        barrier.wait()
        results.append(_waive(client, raced.id).status_code)

    threads = [threading.Thread(target=send, args=(c,)) for c in clients]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert sorted(results) == [200, 409]
    audits = _audits(db, "ASSESSMENT_WAIVED")
    assert sorted(a.target_id for a in audits) == sorted([str(repeated.id), str(raced.id)])


def test_a_failure_inside_one_waiver_rolls_back_only_that_assessment(world, db, monkeypatch):
    training = world.training()
    obligations = [world.complete(p, training) for p in _people(world, 3)]
    admin = _admin_without_raising(world)
    real = training_router.record_audit

    def fail_for_one(db_, actor, action, target_type=None, target_id=None, *args, **kwargs):
        if action == "ASSESSMENT_WAIVED" and str(target_id) == str(obligations[1].id):
            raise RuntimeError("Simulated failure after the obligation was changed")
        return real(db_, actor, action, target_type, target_id, *args, **kwargs)

    monkeypatch.setattr(training_router, "record_audit", fail_for_one)
    assert [_waive(admin, o.id).status_code for o in obligations] == [200, 500, 200]
    db.expire_all()
    assert [db.get(AssessmentObligation, o.id).status for o in obligations] == ["WAIVED", obligations[1].status, "WAIVED"]
    assert db.get(AssessmentObligation, obligations[1].id).waiver_reason is None


# ---------- Access, CSRF and session ----------

def test_signed_out_non_admin_and_missing_csrf_requests_are_rejected(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    obligation = world.complete(world.teammate, training)
    paths = [(f"/admin/enrolments/{enrolment.id}/completion", {"completion_date": TODAY}), (f"/admin/obligations/{obligation.id}/waive", {"reason": REASON})]

    signed_out = ApiClient()
    employee = client_for(world.employee)
    admin = client_for(world.admin)
    for path, body in paths:
        assert signed_out.post(path, json=body).json()["error"]["code"] == "UNAUTHENTICATED"
        assert signed_out.post(path, json=body).status_code == 401
        refused = employee.post(path, json=body)
        assert (refused.status_code, refused.json()["error"]["code"]) == (403, "FORBIDDEN")
        no_csrf = admin.http.post(f"/api/v1{path}", json=body)
        assert (no_csrf.status_code, no_csrf.json()["error"]["code"]) == (403, "CSRF_FAILED")
        wrong_csrf = admin.post(path, json=body, headers={"X-CSRF-Token": "forged"})
        assert (wrong_csrf.status_code, wrong_csrf.json()["error"]["code"]) == (403, "CSRF_FAILED")
    assert signed_out.get(f"/admin/enrolments?training_id={training.id}").status_code == 401
    assert employee.get(f"/admin/enrolments?training_id={training.id}").status_code == 403
    assert _completions(db) == 1  # Only the teammate's, made by the test setup.
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).status in ("DUE", "SCHEDULED")
    assert _audits(db, "COMPLETION_RECORDED") == [] and _audits(db, "ASSESSMENT_WAIVED") == []


def test_an_expired_session_stops_the_selection_with_nothing_recorded(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    obligation = world.complete(world.teammate, training)
    admin = client_for(world.admin)
    for session in db.scalars(select(UserSession)):
        session.expires_at = NOW - timedelta(minutes=1)
    db.commit()
    for response in (_complete(admin, enrolment), _waive(admin, obligation.id)):
        assert (response.status_code, response.json()["error"]["code"]) == (401, "UNAUTHENTICATED")
    assert _completions(db) == 1 and _audits(db, "ASSESSMENT_WAIVED") == []
