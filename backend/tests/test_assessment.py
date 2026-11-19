"""Attempt lifecycle, secure monitoring and retakes. TC-ATT-*, TC-RET-*, TC-SEC-*."""
import threading
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.core import clock
from app.models import AssessmentAttempt, AssessmentObligation, AttemptSecurityEvent, Notification, Question, UserAccount
from tests.conftest import NOW, answer_with_score, give_feedback, refresher_then_approval, relogin, start, submit, take


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


def test_answer_revision_stops_a_stale_window_overwriting_a_newer_answer(world, client_for, db):  # Two tabs or devices
    from app.models import AttemptAnswer

    obligation = world.complete(world.employee, world.training())
    tab_a, tab_b = client_for(world.employee), client_for(world.employee)
    attempt = start(tab_a, obligation.id)
    question = attempt["questions"][0]
    assert question["revision"] == 0
    first, second = (o["option_id"] for o in question["options"][:2])
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"

    saved = tab_b.put(url, json={"selected_option_ids": [second], "base_revision": 0, "op_id": "op-tab-b-0001"})
    assert saved.status_code == 200
    assert saved.json()["data"]["selected_option_ids"] == [second]
    assert saved.json()["data"]["revision"] == 1

    stale = tab_a.put(url, json={"selected_option_ids": [first], "base_revision": 0})  # Made before tab B's save.
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "ANSWER_CONFLICT"
    assert stale.json()["error"]["details"] == {"selected_option_ids": [second], "revision": 1, "op_id": "op-tab-b-0001"}
    db.expire_all()
    assert db.scalar(select(AttemptAnswer.selected_option_ids)) == [second]

    rebased = tab_a.put(url, json={"selected_option_ids": [first], "base_revision": 1})  # A deliberate new choice.
    assert rebased.status_code == 200
    assert rebased.json()["data"]["revision"] == 2


def test_the_save_that_wrote_an_answer_is_identified(world, client_for):  # Own lost save vs another device's save
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    assert question["op_id"] is None
    first, second = (o["option_id"] for o in question["options"][:2])
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    saved = client.put(url, json={"selected_option_ids": [first], "base_revision": 0, "op_id": "op-device-a-01"})
    assert saved.json()["data"]["op_id"] == "op-device-a-01"
    view = client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]["questions"][0]
    assert (view["revision"], view["op_id"]) == (1, "op-device-a-01")
    other = client.put(url, json={"selected_option_ids": [second], "base_revision": 1, "op_id": "op-device-b-01"})
    assert other.json()["data"]["op_id"] == "op-device-b-01"
    late = client.put(url, json={"selected_option_ids": [first], "base_revision": 1, "op_id": "op-device-a-02"})
    assert late.status_code == 409 and late.json()["error"]["details"]["op_id"] == "op-device-b-01"
    assert client.put(url, json={"selected_option_ids": [first], "op_id": "bad id!"}).status_code == 400


def test_answer_revision_accepts_a_retry_of_a_save_that_already_landed(world, client_for):  # Timed-out request
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    option = question["options"][0]["option_id"]
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    body = {"selected_option_ids": [option], "base_revision": 0}
    assert client.put(url, json=body).json()["data"]["revision"] == 1
    retry = client.put(url, json=body)  # Its first reply was lost: same choice, same base.
    assert retry.status_code == 200
    assert retry.json()["data"]["selected_option_ids"] == [option]
    assert retry.json()["data"]["revision"] == 1  # Not bumped: nothing changed.


def test_answer_revision_rejects_a_delayed_older_request(world, client_for, db):
    from app.models import AttemptAnswer

    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    older, newer = (o["option_id"] for o in question["options"][:2])
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    assert client.put(url, json={"selected_option_ids": [newer], "base_revision": 0}).status_code == 200
    late = client.put(url, json={"selected_option_ids": [older], "base_revision": 0})  # Sent earlier, arrives last.
    assert late.status_code == 409
    db.expire_all()
    assert db.scalar(select(AttemptAnswer.selected_option_ids)) == [newer]


def test_answer_revision_never_bypasses_the_deadline(world, client_for):  # SEC-007
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    url = f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer"
    clock.freeze(NOW + timedelta(minutes=16))
    late = client.put(url, json={"selected_option_ids": [question["options"][0]["option_id"]], "base_revision": 0})
    assert late.status_code == 409
    assert late.json()["error"]["code"] == "ATTEMPT_ALREADY_SUBMITTED"


def test_overlapping_submissions_never_finalise_twice(world, client_for, db):  # TC-ATT-006: one authoritative result
    from app.core import db as database
    from app.modules.assessment.service import finalise_attempt

    obligation = world.complete(world.employee, world.training())
    attempt_id = start(client_for(world.employee), obligation.id)["attempt_id"]
    late = database.session_factory()()  # A second submit request: it has already loaded the attempt, as routes do.
    loaded = late.get(AssessmentAttempt, attempt_id)
    assert loaded.status == "IN_PROGRESS"
    first = database.session_factory()()  # The first request finalises and commits while the second waits for the lock.
    finalise_attempt(first, attempt_id)
    first.commit()
    final = first.get(AssessmentAttempt, attempt_id)
    snapshot = (final.status, final.submitted_at, final.score_percent, final.result_status)
    first.close()

    clock.freeze(NOW + timedelta(seconds=2))
    again = finalise_attempt(late, attempt_id)  # Must read the row it locked, not the copy it loaded earlier.
    late.commit()
    assert again is loaded
    assert (again.status, again.submitted_at, again.score_percent, again.result_status) == snapshot
    late.close()


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

def test_failure_then_refresher_then_retake_after_approval(world, client_for, db):  # TC-RET-001, TC-RET-002
    obligation = world.complete(world.employee, world.training())
    email = world.employee.work_email
    client = client_for(email)
    admin = client_for(world.admin)
    result = take(db, client, obligation.id, 5)
    assert result["result_status"] == "NOT_PASSED"
    assert result["retake_pending"] is True and result["attempts_remaining"] == 2
    # The required feedback comes first; after it, waiting for L&D does not block the workspace.
    assert result["access_state"]["access_status"] == "FEEDBACK_REQUIRED"
    give_feedback(client, result["attempt_id"])
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get("/me/dashboard").status_code == 200
    assert client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).status_code == 409

    assert client.post(f"/assessment-obligations/{obligation.id}/refresher-acknowledgement").status_code == 200
    admin_notices = db.scalars(select(Notification).join(UserAccount, UserAccount.id == Notification.user_account_id).where(UserAccount.employee_id == world.admin.id, Notification.type == "RETAKE_APPROVAL_REQUIRED")).all()
    assert len(admin_notices) == 1
    # A new sign-in alone no longer opens the retake.
    relogin(client, email)
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    row = next(r for r in admin.get("/admin/enrolments").json()["data"] if r["obligation_id"] == str(obligation.id))
    assert (row["assessment_state"], row["attempts_used"], row["max_attempts"], row["retrainings"]) == ("Awaiting approval", 1, 3, 0)

    assert admin.post(f"/admin/obligations/{obligation.id}/approve-retake").status_code == 200
    assert client.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"
    assert take(db, client, obligation.id, 8)["attempt_number"] == 2


def test_retake_never_opens_by_itself_and_approval_needs_the_refresher(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    give_feedback(client, take(db, client, obligation.id, 5)["attempt_id"])
    clock.freeze(NOW + timedelta(days=3))
    relogin(client, world.employee.work_email)
    admin = client_for(world.admin)  # Signed in after the clock moved: a session lasts 12 hours at most.
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    response = admin.post(f"/admin/obligations/{obligation.id}/approve-retake")
    assert response.status_code == 409 and response.json()["error"]["code"] == "REFRESHER_NOT_ACKNOWLEDGED"
    refresher_then_approval(client, admin, obligation.id)
    assert start(client, obligation.id)["attempt_number"] == 2


def _fail_all(db, client, admin, obligation_id, scores=(4, 5, 6)):
    result = None
    for score in scores:
        if result is not None:
            refresher_then_approval(client, admin, obligation_id)
        result = take(db, client, obligation_id, score)
    return result


def test_three_failures_flag_needs_retraining_and_notify(world, client_for, db):  # TC-RET-003, TC-RET-006
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    result = _fail_all(db, client, client_for(world.admin), obligation.id)
    assert result["needs_retraining"] is True and result["attempts_remaining"] == 0
    assert (result["first_score"], result["best_score"], result["latest_score"]) == (40.0, 60.0, 60.0)
    # No indefinite lock after final failure (provisional, OD-BRD-006), once the required feedback is given.
    give_feedback(client, result["attempt_id"])
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
    result = _fail_all(db, client, client_for(world.admin), obligation.id, scores=(5, 9))
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
    admin = client_for(world.admin)
    _fail_all(db, client, admin, obligation.id)
    # Once all attempts are used, only re-training can be approved, never another re-attempt.
    refused = admin.post(f"/admin/obligations/{obligation.id}/approve-retake")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "NO_RETAKE_PENDING"
    response = admin.post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Completed approved re-training"})
    assert response.status_code == 200, response.text
    new_id = response.json()["data"]["obligation_id"]
    assert response.json()["data"]["cycle_number"] == 2
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).retraining_flag == "RESOLVED"
    assert len(db.get(AssessmentObligation, obligation.id).attempts) == 3
    row = next(r for r in admin.get("/admin/enrolments").json()["data"] if r["obligation_id"] == new_id)
    assert (row["attempts_used"], row["retrainings"]) == (0, 1)
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



def test_completion_recorded_mid_pre_test_submits_it_and_frees_the_post_test(world, client_for, db):
    """Decision of 19 Nov 2026: a pre-test still running when completion is recorded is submitted with its saved
    answers, so the employee is never trapped between a gate that demands the post-test and a running pre-test."""
    from decimal import Decimal

    from app.models import AssessmentAttempt, AssessmentConfig

    training = world.training(duration_seconds=1800)
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type="PRE_TEST", version=1, question_count=5, duration_seconds=1800, pass_mark_percent=Decimal("70"), max_attempts=1, schedule_mode="SAME_DAY", is_active=True))
    db.commit()
    enrolment = world.enrol(world.employee, training)
    employee, admin = client_for(world.employee), client_for(world.admin)
    pre = employee.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert pre.status_code == 200, pre.text
    pre_id = pre.json()["data"]["attempt_id"]

    assert admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()}).status_code == 200
    db.expire_all()
    stored = db.get(AssessmentAttempt, pre_id)
    assert stored.status == "SUBMITTED" and stored.submission_reason == "TRAINING_COMPLETED" and stored.score_percent is not None

    queue = employee.get("/me/access-state").json()["data"]["queue"]
    started = employee.post(f"/assessment-obligations/{queue[0]['obligation_id']}/attempts", json={"instructions_acknowledged": True})
    assert started.status_code == 200, started.text


def _insert_answer_meanwhile(monkeypatch, marked: bool, selected=None):
    """Simulates another request creating this question's answer row between our read and our insert."""
    from app.core import db as database
    from app.models import AttemptAnswer
    from app.modules.assessment import service

    real, state = service._answer_for, {"done": False}

    def interleaved(session, attempt_question_id):
        if not state["done"]:
            state["done"] = True
            other = database.session_factory()()
            other.add(AttemptAnswer(attempt_question_id=attempt_question_id, selected_option_ids=selected or [], marked_for_review=marked, saved_at=NOW))
            other.commit()
            other.close()
            return None
        return real(session, attempt_question_id)

    monkeypatch.setattr(service, "_answer_for", interleaved)


def test_first_save_racing_a_review_mark_keeps_both(world, client_for, db, monkeypatch):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    choice = question["options"][1]["option_id"]
    _insert_answer_meanwhile(monkeypatch, marked=True)
    saved = client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": [choice], "base_revision": 0})
    assert saved.status_code == 200, saved.text
    view = next(q for q in client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]["questions"] if q["attempt_question_id"] == question["attempt_question_id"])
    assert view["selected_option_ids"] == [choice] and view["marked_for_review"] is True


def test_review_mark_racing_a_first_save_keeps_both(world, client_for, db, monkeypatch):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    choice = question["options"][2]["option_id"]
    _insert_answer_meanwhile(monkeypatch, marked=False, selected=[choice])
    marked = client.post(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/mark", json={"marked": True})
    assert marked.status_code == 200, marked.text
    view = next(q for q in client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]["questions"] if q["attempt_question_id"] == question["attempt_question_id"])
    assert view["selected_option_ids"] == [choice] and view["marked_for_review"] is True
