"""Training Completion table: the Attempts column and the Reattempt / Retraining actions (25 Nov 2026).

- Attempts counts finished attempts (submitted or timed out) in the current training cycle. Opening a test or
  authorising a re-attempt never changes it.
- After a failed attempt that leaves attempts, L&D authorises exactly one more (Reattempt); nothing else opens it.
  No refresher acknowledgement is needed first.
- After the last attempt fails, Retraining assigns the training again as the assignment's next training cycle: it
  needs a new completion, whose post-test has fresh attempts. Every earlier record is kept.
- Both actions are L&D Admin only, and a double click or two admins never authorise or assign twice.
"""
import threading
import time

from sqlalchemy import func, select

from app.models import AssessmentAttempt, AssessmentObligation, AuditLog, Enrolment, Notification, TrainingCompletion, UserAccount
from app.modules.training import router as training_router
from tests.conftest import answer_with_score, authorise_reattempt, give_feedback, start, submit, take

TODAY = "2026-11-04"  # The frozen clock's date in the organisation timezone.


def row_for(admin, enrolment: Enrolment) -> dict:
    rows = admin.get(f"/admin/enrolments?training_id={enrolment.training_id}").json()["data"]
    return next(r for r in rows if r["id"] == str(enrolment.id))


def summary(row: dict) -> tuple:
    return (row["assessment_state"], row["attempts_completed"], row["max_attempts"], row["retry_action"])


def complete(admin, enrolment: Enrolment) -> dict:
    response = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": TODAY})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def start_code(client, obligation_id) -> str | None:
    response = client.post(f"/assessment-obligations/{obligation_id}/attempts", json={"instructions_acknowledged": True})
    return None if response.status_code == 200 else response.json()["error"]["code"]


def count(db, model) -> int:
    return db.scalar(select(func.count()).select_from(model))


def test_full_flow_three_failures_then_retraining_then_a_fresh_cycle(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin, client = client_for(world.admin), client_for(world.employee)

    # Before completion and before the first attempt: 0/3, no action.
    assert summary(row_for(admin, enrolment)) == ("Awaiting completion", 0, 3, None)
    obligation_id = complete(admin, enrolment)["obligation_id"]
    assert summary(row_for(admin, enrolment))[1:] == (0, 3, None)

    # Opening the test does not count an attempt.
    attempt = start(client, obligation_id)
    assert summary(row_for(admin, enrolment)) == ("In progress", 0, 3, None)
    answer_with_score(db, client, attempt, 5)
    give_feedback(client, submit(client, attempt["attempt_id"])["attempt_id"])

    # First failure: Reattempt. The next attempt stays blocked, also through the API, until L&D clicks it.
    assert summary(row_for(admin, enrolment)) == ("Awaiting approval", 1, 3, "REATTEMPT")
    assert start_code(client, obligation_id) == "RETAKE_NOT_AUTHORISED"
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"

    authorise_reattempt(client, admin, obligation_id)
    # Authorised: no action while it is available, and the count is unchanged.
    assert summary(row_for(admin, enrolment)) == ("Due", 1, 3, None)
    again = admin.post(f"/admin/obligations/{obligation_id}/approve-retake")
    assert again.status_code == 409 and again.json()["error"]["code"] == "NO_RETAKE_PENDING"
    attempt = start(client, obligation_id)
    assert attempt["attempt_number"] == 2
    assert summary(row_for(admin, enrolment)) == ("In progress", 1, 3, None)
    during = admin.post(f"/admin/obligations/{obligation_id}/approve-retake")
    assert during.status_code == 409 and "in progress" in during.json()["error"]["message"]
    answer_with_score(db, client, attempt, 6)
    submit(client, attempt["attempt_id"])

    # Second failure: Reattempt again; one click opens exactly one more attempt.
    assert summary(row_for(admin, enrolment)) == ("Awaiting approval", 2, 3, "REATTEMPT")
    assert start_code(client, obligation_id) == "RETAKE_NOT_AUTHORISED"
    authorise_reattempt(client, admin, obligation_id)
    assert take(db, client, obligation_id, 4)["needs_retraining"] is True

    # Third failure: Retraining instead of Reattempt.
    assert summary(row_for(admin, enrolment)) == ("Submitted", 3, 3, "RETRAINING")
    refused = admin.post(f"/admin/obligations/{obligation_id}/approve-retake")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "NO_RETAKE_PENDING"
    assert start_code(client, obligation_id) == "ASSESSMENT_NOT_DUE"
    assert count(db, AssessmentAttempt) == 3

    response = admin.post(f"/admin/obligations/{obligation_id}/retraining-cycle", json={"reason": "Re-training approved"})
    assert response.status_code == 200, response.text
    row = response.json()["data"]
    assert summary(row) == ("Awaiting completion", 0, 3, None)
    assert (row["training_cycle"], row["retrainings"], row["completed_at"], row["attendance_status"], row["obligation_id"]) == (2, 1, None, "PENDING", None)
    assert summary(row_for(admin, enrolment)) == ("Awaiting completion", 0, 3, None)
    twice = admin.post(f"/admin/obligations/{obligation_id}/retraining-cycle", json={"reason": "Re-training approved"})
    assert twice.status_code == 409 and twice.json()["error"]["code"] == "NOT_FLAGGED"

    # The new cycle needs training completion again; until then nothing opens and nothing blocks the employee.
    assert start_code(client, obligation_id) == "ASSESSMENT_NOT_DUE"
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    card = client.get("/me/trainings").json()["data"][0]
    assert (card["entry_reason"], card["attempts"], card["completed_at"], card["pre_test_available"]) == ("AWAITING_COMPLETION", 0, None, False)
    assert len(db.scalars(select(AuditLog).where(AuditLog.action == "RETRAINING_ASSIGNED")).all()) == 1

    # Completion again schedules a fresh post-test: 0/3 and three new attempts.
    new_id = complete(admin, enrolment)["obligation_id"]
    assert new_id and new_id != obligation_id
    assert summary(row_for(admin, enrolment))[1:] == (0, 3, None)
    first_try = take(db, client, new_id, 9)
    assert (first_try["result_status"], first_try["attempt_number"]) == ("PASSED", 1)
    give_feedback(client, first_try["attempt_id"])  # A new cycle is a new assessment: its feedback is asked once.
    history = client.get("/me/trainings").json()["data"][0]  # Reports keep every cycle's scores.
    assert (history["first_score"], history["best_score"], history["latest_score"], history["attempts"]) == (50.0, 90.0, 90.0, 1)
    passed = row_for(admin, enrolment)
    assert summary(passed) == ("Submitted", 1, 3, None) and passed["outcome"] == "PASSED"

    # Every earlier record is kept and tagged with its cycle.
    db.expire_all()
    old, new = db.get(AssessmentObligation, obligation_id), db.get(AssessmentObligation, new_id)
    assert (old.training_cycle, old.retraining_flag, old.outcome, len(old.attempts)) == (1, "RESOLVED", "NOT_PASSED", 3)
    assert (new.training_cycle, new.cycle_number) == (2, 2)
    completions = db.scalars(select(TrainingCompletion).where(TrainingCompletion.enrolment_id == enrolment.id).order_by(TrainingCompletion.training_cycle)).all()
    assert [c.training_cycle for c in completions] == [1, 2]
    assert count(db, AssessmentAttempt) == 4


def test_pass_on_the_first_attempt_shows_the_count_and_no_action(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    admin, client = client_for(world.admin), client_for(world.employee)
    take(db, client, obligation.id, 8)
    assert summary(row_for(admin, obligation.enrolment)) == ("Submitted", 1, 3, None)
    response = admin.post(f"/admin/obligations/{obligation.id}/approve-retake")
    assert response.status_code == 409
    response = admin.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Not needed"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "NOT_FLAGGED"


def test_pass_on_a_reattempt_shows_the_used_attempts(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    admin, client = client_for(world.admin), client_for(world.employee)
    take(db, client, obligation.id, 5)
    authorise_reattempt(client, admin, obligation.id)
    assert take(db, client, obligation.id, 7)["result_status"] == "PASSED"
    assert summary(row_for(admin, obligation.enrolment)) == ("Submitted", 2, 3, None)


def test_waived_reattempt_offers_no_action(world, db, client_for):
    """The existing Waive rules are unchanged: a re-attempt waiting for L&D can still be waived, and then nothing is offered."""
    obligation = world.complete(world.employee, world.training())
    admin, client = client_for(world.admin), client_for(world.employee)
    take(db, client, obligation.id, 5)
    assert admin.post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "Approved exemption"}).status_code == 200
    assert summary(row_for(admin, obligation.enrolment)) == ("Waived", 1, 3, None)
    assert admin.post(f"/admin/obligations/{obligation.id}/approve-retake").status_code == 409


def test_only_ld_admin_can_authorise_or_assign_retraining(world, db, client_for):
    obligation = world.complete(world.employee, world.training(max_attempts=1))
    employee = client_for(world.employee)
    take(db, employee, obligation.id, 2)  # One attempt allowed: flagged Needs Re-training.
    for client in (employee, client_for(world.manager), client_for(world.hr)):
        assert client.post(f"/admin/obligations/{obligation.id}/approve-retake").status_code in (401, 403)
        assert client.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Self-service"}).status_code in (401, 403)
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).retraining_flag == "NEEDS_RETRAINING"
    assert db.get(Enrolment, obligation.enrolment_id).training_cycle == 1


def test_retraining_refuses_an_inactive_employee(world, db, client_for):
    obligation = world.complete(world.employee, world.training(max_attempts=1))
    take(db, client_for(world.employee), obligation.id, 2)
    world.employee.employment_status = "INACTIVE"
    db.commit()
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-training approved"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "INACTIVE_EMPLOYEE"


def _race(monkeypatch, loader_name: str, send) -> list[int]:
    """Sends the same request from two admin sessions at once; the first is held inside its locked transaction."""
    real = getattr(training_router, loader_name)
    calls = []

    def slow_first(*args, **kwargs):
        record = real(*args, **kwargs)
        calls.append(1)
        if len(calls) == 1:
            time.sleep(1.0)
        return record

    monkeypatch.setattr(training_router, loader_name, slow_first)
    results: list[int] = []
    barrier = threading.Barrier(2)

    def run():
        barrier.wait()
        results.append(send())

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    return sorted(results)


def test_simultaneous_reattempt_clicks_authorise_once(world, db, client_for, monkeypatch):
    obligation = world.complete(world.employee, world.training())
    take(db, client_for(world.employee), obligation.id, 5)
    first, second = client_for(world.admin), client_for(world.admin)
    clients = iter((first, second))
    lock = threading.Lock()

    def send():
        with lock:
            client = next(clients)
        return client.post(f"/admin/obligations/{obligation.id}/approve-retake").status_code

    # _locked runs after the read; holding the first request there makes the second wait on the row lock.
    assert _race(monkeypatch, "_locked", send) == [200, 409]
    approvals = db.scalars(select(AuditLog).where(AuditLog.action == "RETAKE_APPROVED")).all()
    notices = db.scalars(select(Notification).join(UserAccount, UserAccount.id == Notification.user_account_id).where(UserAccount.employee_id == world.employee.id, Notification.type == "RETAKE_APPROVED")).all()
    assert len(approvals) == 1 and len(notices) == 1


def test_simultaneous_retraining_clicks_assign_once(world, db, client_for, monkeypatch):
    obligation = world.complete(world.employee, world.training(max_attempts=1))
    take(db, client_for(world.employee), obligation.id, 2)
    first, second = client_for(world.admin), client_for(world.admin)
    clients = iter((first, second))
    lock = threading.Lock()

    def send():
        with lock:
            client = next(clients)
        return client.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-training approved"}).status_code

    assert _race(monkeypatch, "_locked", send) == [200, 409]
    db.expire_all()
    assert db.get(Enrolment, obligation.enrolment_id).training_cycle == 2
    assert len(db.scalars(select(AuditLog).where(AuditLog.action == "RETRAINING_ASSIGNED")).all()) == 1


def test_a_second_cycle_completion_is_recorded_once(world, db, client_for):
    obligation = world.complete(world.employee, world.training(max_attempts=1))
    admin = client_for(world.admin)
    take(db, client_for(world.employee), obligation.id, 2)
    assert admin.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-training approved"}).status_code == 200
    enrolment = db.get(Enrolment, obligation.enrolment_id)
    complete(admin, enrolment)
    repeat = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": TODAY})
    assert repeat.status_code == 409 and repeat.json()["error"]["code"] == "COMPLETION_EXISTS"
    assert count(db, TrainingCompletion) == 2
    post_tests = db.scalars(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == "POST_TEST")).all()
    assert sorted((o.training_cycle, o.cycle_number) for o in post_tests) == [(1, 1), (2, 2)]
