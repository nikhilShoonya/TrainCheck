"""Attempt lifecycle, secure monitoring and retakes. TC-ATT-*, TC-RET-*, TC-SEC-*."""
import threading
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.core import clock
from app.models import AssessmentAttempt, AssessmentObligation, AttemptSecurityEvent, Notification, Question, UserAccount
from tests.conftest import NOW, answer_with_score, relogin, start, submit, take


def test_start_needs_acknowledgement_and_stores_snapshot(world, client_for, db):  # TC-ATT-001, SC-2L-106
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    assert client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": False}).status_code == 400
    attempt = start(client, obligation.id)
    assert attempt["status"] == "IN_PROGRESS"
    assert len(attempt["questions"]) == 10
    stored = db.get(AssessmentAttempt, attempt["attempt_id"])
    assert stored.config_snapshot["pass_mark_percent"] == "70.00"
    assert stored.expires_at - stored.started_at == timedelta(seconds=900)


def test_second_start_resumes_same_attempt(world, client_for, db):  # TC-ATT-002
    obligation = world.complete(world.employee, world.training())
    first = start(client_for(world.employee), obligation.id)
    second = start(client_for(world.employee), obligation.id)
    assert first["attempt_id"] == second["attempt_id"]
    assert db.scalar(select(func.count()).select_from(AssessmentAttempt)) == 1


def test_concurrent_start_creates_one_attempt(world, client_for, db):  # TC-ATT-002, TC-RET-005
    obligation = world.complete(world.employee, world.training())
    clients = [client_for(world.employee) for _ in range(4)]
    results: list[int] = []

    def go(c):
        results.append(c.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).status_code)

    threads = [threading.Thread(target=go, args=(c,)) for c in clients]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert db.scalar(select(func.count()).select_from(AssessmentAttempt)) == 1
    assert all(code in (200, 409) for code in results), results


def test_database_rejects_a_second_active_attempt(world, db):  # DB design §4.4
    import pytest
    from sqlalchemy.exc import IntegrityError

    obligation = world.complete(world.employee, world.training())
    for number in (1, 2):
        db.add(AssessmentAttempt(obligation_id=obligation.id, employee_id=world.employee.id, training_id=obligation.training_id, assessment_type="POST_TEST", attempt_number=number, status="IN_PROGRESS", started_at=NOW, expires_at=NOW + timedelta(minutes=5), config_snapshot={}))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_save_and_resume_keeps_answers_and_deadline(world, client_for):  # TC-ATT-003, NFR-004
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    option = question["options"][0]["option_id"]
    client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": [option]})

    clock.freeze(NOW + timedelta(minutes=5))
    resumed = client_for(world.employee).post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).json()["data"]
    assert resumed["attempt_id"] == attempt["attempt_id"]
    assert resumed["expires_at"] == attempt["expires_at"]  # The original deadline is preserved.
    assert resumed["remaining_seconds"] == 600
    assert next(q for q in resumed["questions"] if q["attempt_question_id"] == question["attempt_question_id"])["selected_option_ids"] == [option]


def test_duplicate_save_is_idempotent(world, client_for, db):  # TC-ATT-004
    from app.models import AttemptAnswer

    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    body = {"selected_option_ids": [question["options"][0]["option_id"]]}
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    assert client.put(url, json=body).status_code == 200
    assert client.put(url, json=body).status_code == 200
    assert db.scalar(select(func.count()).select_from(AttemptAnswer)) == 1


def test_save_rejects_foreign_or_multiple_options(world, client_for):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    assert client.put(url, json={"selected_option_ids": ["not-an-option"]}).status_code == 400
    two = [o["option_id"] for o in question["options"][:2]]
    assert client.put(url, json={"selected_option_ids": two}).status_code == 400


def test_timeout_finalises_saved_answers_once(world, client_for, db):  # TC-ATT-005, TC-ATT-006, SEC-007
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    answer_with_score(db, client, attempt, 8)

    clock.freeze(NOW + timedelta(minutes=16))
    question = attempt["questions"][0]
    late = client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": []})
    assert late.status_code == 409  # A late answer is refused.
    result = client.get(f"/attempts/{attempt['attempt_id']}/result").json()["data"]
    assert result["attempt_status"] == "TIMED_OUT"
    assert result["submission_reason"] == "TIME_EXPIRED"
    assert result["score_percent"] == 80.0
    assert db.scalar(select(func.count()).select_from(AssessmentAttempt)) == 1


def test_scheduler_finalises_expired_attempts(world, client_for, db):  # TC-ATT-005
    from app.modules.scheduler.jobs import finalise_expired

    obligation = world.complete(world.employee, world.training())
    attempt = start(client_for(world.employee), obligation.id)
    assert finalise_expired(db, NOW + timedelta(minutes=20)) == 1
    db.expire_all()
    assert db.get(AssessmentAttempt, attempt["attempt_id"]).status == "TIMED_OUT"
    assert finalise_expired(db, NOW + timedelta(minutes=21)) == 0


def test_question_and_option_randomisation(world, client_for, db):  # TC-ATT-007, TC-ATT-008
    from app.modules.assessment import service

    training = world.training(questions=20)
    obligation = world.complete(world.employee, training)
    orders, option_orders = set(), set()
    for _ in range(4):
        attempt = service.start_attempt(db, db.get(AssessmentObligation, obligation.id), True)
        db.flush()
        db.refresh(attempt)
        orders.add(tuple(str(q.question_id) for q in attempt.questions))
        option_orders.add(tuple(q.options_snapshot[0]["option_id"] for q in attempt.questions))
        db.rollback()
    assert len(orders) > 1 and len(option_orders) > 1


def test_option_labels_follow_display_order(world, client_for):  # BR §7.5
    obligation = world.complete(world.employee, world.training())
    attempt = start(client_for(world.employee), obligation.id)
    assert [o["label"] for o in attempt["questions"][0]["options"]] == ["A", "B", "C", "D"]


def test_difficulty_mix_is_followed(world, client_for, db):  # TC-ATT-009
    obligation = world.complete(world.employee, world.training(questions=12, count=6, mix={"EASY": 3, "MEDIUM": 2, "HARD": 1}))
    attempt = start(client_for(world.employee), obligation.id)
    from app.models import AttemptQuestion

    levels = [db.get(AttemptQuestion, q["attempt_question_id"]).difficulty_snapshot for q in attempt["questions"]]
    assert levels.count("EASY") == 3 and levels.count("MEDIUM") == 2 and levels.count("HARD") == 1


def test_insufficient_pool_blocks_start_with_shortfall(world, client_for, db):  # TC-ATT-010
    # Phase 1: an unusable obligation is never created, so the pool shrinks after scheduling instead.
    training = world.training(questions=10, count=10)
    obligation = world.complete(world.employee, training)
    for question in db.scalars(select(Question).where(Question.question_code.in_([f"T1-Q{i:02d}" for i in range(1, 6)]))):
        question.status = "INACTIVE"
    db.commit()
    response = client_for(world.employee).post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == "QUESTION_POOL_INSUFFICIENT"
    assert body["details"]["shortfall"] == 5


def test_duplicate_submit_returns_same_result(world, client_for, db):  # TC-ATT-011, NFR-005, SEC-008
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    answer_with_score(db, client, attempt, 7)
    first = submit(client, attempt["attempt_id"])
    second = submit(client, attempt["attempt_id"])
    assert first["score_percent"] == second["score_percent"] == 70.0
    assert first["submitted_at"] == second["submitted_at"]


def test_concurrent_submit_has_one_result(world, client_for, db):  # TC-ATT-011
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    answer_with_score(db, client, attempt, 3)
    others = [client_for(world.employee) for _ in range(3)]
    results: list[dict] = []

    def go(c):
        results.append(c.post(f"/attempts/{attempt['attempt_id']}/submit").json()["data"])

    threads = [threading.Thread(target=go, args=(c,)) for c in others]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len({r["submitted_at"] for r in results}) == 1
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).status == "RETAKE_PENDING"
    assert len(db.get(AssessmentObligation, obligation.id).attempts) == 1


# ---------- Secure browser monitoring ----------

def test_violation_policy_warning_final_warning_auto_submit(world, client_for, db):  # TC-SEC-001, TC-SEC-002
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    answer_with_score(db, client, attempt, 8)
    url = f"/attempts/{attempt['attempt_id']}/security-events"

    one = client.post(url, json={"event_type": "TAB_HIDDEN"}).json()["data"]
    assert one["counted"] and one["violation_count"] == 1 and not one["auto_submitted"]
    clock.freeze(NOW + timedelta(seconds=30))
    two = client.post(url, json={"event_type": "FULLSCREEN_EXIT"}).json()["data"]
    assert two["violation_count"] == 2 and not two["auto_submitted"]
    clock.freeze(NOW + timedelta(seconds=60))
    three = client.post(url, json={"event_type": "NAVIGATION"}).json()["data"]
    assert three["violation_count"] == 3 and three["auto_submitted"]

    result = client.get(f"/attempts/{attempt['attempt_id']}/result").json()["data"]
    assert result["submission_reason"] == "VIOLATION_LIMIT"
    assert result["score_percent"] == 80.0  # Violations never change the score.
    assert len(result["violations"]) == 3


def test_signals_from_one_incident_count_once(world, client_for, db):  # TC-SEC-003
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    url = f"/attempts/{attempt['attempt_id']}/security-events"
    assert client.post(url, json={"event_type": "TAB_HIDDEN"}).json()["data"]["counted"] is True
    for event in ("FOCUS_LOST", "FULLSCREEN_EXIT"):
        response = client.post(url, json={"event_type": event}).json()["data"]
        assert response["counted"] is False and response["violation_count"] == 1
    assert sorted(db.scalar(select(AttemptSecurityEvent)).signals) == ["FOCUS_LOST", "FULLSCREEN_EXIT", "TAB_HIDDEN"]


def test_internet_loss_is_never_a_violation(world, client_for, db):  # TC-SEC-004
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    url = f"/attempts/{attempt['attempt_id']}/security-events"
    for second in range(0, 20, 5):
        clock.freeze(NOW + timedelta(seconds=second))
        data = client.post(url, json={"event_type": "NETWORK_INTERRUPTION"}).json()["data"]
        assert data["counted"] is False and data["violation_count"] == 0 and data["status"] == "IN_PROGRESS"
    # The original deadline does not move.
    assert client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]["expires_at"] == attempt["expires_at"]


def test_invalid_security_event_rejected(world, client_for):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    assert client.post(f"/attempts/{attempt['attempt_id']}/security-events", json={"event_type": "OTHER"}).status_code == 400


# ---------- Retakes ----------

def test_failure_then_refresher_then_retake_next_login(world, client_for, db):  # TC-RET-001, TC-RET-002
    obligation = world.complete(world.employee, world.training())
    email = world.employee.work_email
    client = client_for(email)
    result = take(db, client, obligation.id, 5)
    assert result["result_status"] == "NOT_PASSED"
    assert result["retake_pending"] is True and result["attempts_remaining"] == 2
    # The current gate is released for this session (provisional, OD-BRD-006).
    assert result["access_state"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get("/me/dashboard").status_code == 200
    # No retake until the next eligible login.
    assert client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).status_code == 409

    assert client.post(f"/assessment-obligations/{obligation.id}/refresher-acknowledgement").status_code == 200
    relogin(client, email)
    assert client.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"
    assert take(db, client, obligation.id, 8)["attempt_number"] == 2


def test_retake_is_due_next_working_day_but_needs_refresher_first(world, client_for, db):  # OD-BRD-007
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    take(db, client, obligation.id, 5)
    clock.freeze(NOW + timedelta(days=1, hours=1))
    relogin(client, world.employee.work_email)
    queue = client.get("/me/assessment-queue").json()["data"]
    assert queue[0]["refresher_required"] is True
    response = client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.json()["error"]["code"] == "REFRESHER_REQUIRED"
    assert client.post(f"/assessment-obligations/{obligation.id}/refresher-acknowledgement").status_code == 200
    assert start(client, obligation.id)["attempt_number"] == 2


def _fail_all(db, client, email, obligation_id, scores=(4, 5, 6)):
    result = None
    for score in scores:
        if result is not None:
            client.post(f"/assessment-obligations/{obligation_id}/refresher-acknowledgement")
            relogin(client, email)
        result = take(db, client, obligation_id, score)
    return result


def test_three_failures_flag_needs_retraining_and_notify(world, client_for, db):  # TC-RET-003, TC-RET-006
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    result = _fail_all(db, client, world.employee.work_email, obligation.id)
    assert result["needs_retraining"] is True and result["attempts_remaining"] == 0
    assert (result["first_score"], result["best_score"], result["latest_score"]) == (40.0, 60.0, 60.0)
    # No indefinite lock after final failure (provisional, OD-BRD-006).
    assert client.get("/me/dashboard").status_code == 200

    response = client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 409

    recipients = {
        code: db.scalar(select(func.count()).select_from(Notification).join(UserAccount, UserAccount.id == Notification.user_account_id).where(UserAccount.employee_id == person.id, Notification.type == "FINAL_FAILURE"))
        for code, person in {"manager": world.manager, "admin": world.admin, "hr": world.hr, "other": world.other_manager, "self": world.employee}.items()
    }
    assert recipients == {"manager": 0, "admin": 1, "hr": 0, "other": 0, "self": 1}  # L&D and the employee only.


def test_pass_on_retake_keeps_all_attempts(world, client_for, db):  # TC-RET-004
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    result = _fail_all(db, client, world.employee.work_email, obligation.id, scores=(5, 9))
    assert result["result_status"] == "PASSED"
    assert (result["first_score"], result["best_score"]) == (50.0, 90.0)
    assert db.scalar(select(func.count()).select_from(AssessmentAttempt)) == 2


def test_attempt_limit_holds_even_if_obligation_is_reopened(world, client_for, db):  # TC-RET-005
    obligation = world.complete(world.employee, world.training(max_attempts=1))
    client = client_for(world.employee)
    take(db, client, obligation.id, 1)
    db.expire_all()
    stored = db.get(AssessmentObligation, obligation.id)
    stored.status = "DUE"
    stored.refresher_acknowledged_at = NOW
    db.commit()
    assert client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).json()["error"]["code"] == "MAX_ATTEMPTS_REACHED"


def test_retraining_cycle_keeps_failure_history(world, client_for, db):  # TC-RET-008, BR §9.6
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    _fail_all(db, client, world.employee.work_email, obligation.id)
    admin = client_for(world.admin)
    response = admin.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Completed approved re-training"})
    assert response.status_code == 200, response.text
    new_id = response.json()["data"]["obligation_id"]
    assert response.json()["data"]["cycle_number"] == 2
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).retraining_flag == "RESOLVED"
    assert len(db.get(AssessmentObligation, obligation.id).attempts) == 3
    assert take(db, client, new_id, 9)["result_status"] == "PASSED"


def test_marks_change_after_attempt_does_not_change_result(world, client_for, db):  # DB design §7
    from app.models import Question

    training = world.training()
    obligation = world.complete(world.employee, training)
    result = take(db, client_for(world.employee), obligation.id, 7)
    for question in db.scalars(select(Question)):
        question.marks = Decimal("9")
    db.commit()
    again = client_for(world.employee).get(f"/attempts/{result['attempt_id']}/result").json()["data"]
    assert again["score_percent"] == 70.0 and again["total_marks"] == 10.0


def test_old_config_stays_with_attempt_after_change(world, client_for, db):  # BR §3.1
    training = world.training()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    result = take(db, client, obligation.id, 7)
    admin = client_for(world.admin)
    response = admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 10, "duration_minutes": 20, "pass_mark_percent": 90})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["version"] == 2
    again = client.get(f"/attempts/{result['attempt_id']}/result").json()["data"]
    assert again["pass_mark_percent"] == 70.0 and again["result_status"] == "PASSED"

