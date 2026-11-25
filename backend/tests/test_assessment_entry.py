"""Entering a post-training assessment from My Trainings: the opening moment, the waiting screen's data, resuming,
the reason an assessment cannot be taken, and pending-first ordering of the employee's trainings.

BR §4.1 (only recorded completion creates the assessment), BR §5 (gate), BR §6.3 (start preconditions),
BR §6.6 (server time is authoritative). Synthetic data only. NOW is Wednesday 2026-11-04 06:00 UTC."""
from datetime import timedelta

from sqlalchemy import func, select

from app.core import clock
from app.core.enums import ObligationStatus, QuestionStatus, TrainingStatus
from app.core.responses import iso
from app.models import AssessmentAttempt, AssessmentObligation, Enrolment, Question
from tests.conftest import NOW, give_feedback, start, take


def opens_later(world, code: str, opens_at):
    """A training whose post-test opens at a chosen moment (custom date and time), already completed."""
    training = world.training(code, schedule_mode="FIXED_DATE", schedule_date=opens_at.date(), schedule_at=opens_at)
    obligation = world.complete(world.employee, training, when=NOW - timedelta(hours=1))
    return training, obligation


def entry(client, obligation_id) -> dict:
    response = client.get(f"/me/assessment-obligations/{obligation_id}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def cards(client) -> list[dict]:
    response = client.get("/me/trainings")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def card_for(client, training) -> dict:
    return next(c for c in cards(client) if c["training_id"] == str(training.id))


def attempts(db) -> int:
    return db.scalar(select(func.count()).select_from(AssessmentAttempt))


# ---------- Waiting before the opening moment ----------

def test_future_assessment_reports_its_opening_and_server_time_without_questions(world, client_for, db):  # BR §6.6
    _, obligation = opens_later(world, "T1", NOW + timedelta(hours=2, minutes=5))
    client = client_for(world.employee)
    data = entry(client, obligation.id)
    assert data["entry_state"] == "NOT_YET_OPEN"
    assert data["due_at"] == iso(NOW + timedelta(hours=2, minutes=5))
    assert data["server_now"] == iso(NOW)  # The countdown is timed against this, not the device clock.
    assert data["timezone"] == "UTC"  # The organisation calendar's timezone, for showing the opening time.
    assert data["active_attempt_id"] is None
    assert "questions" not in data and "question" not in data  # Nothing of the assessment is revealed while waiting.
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


def test_starting_before_the_opening_moment_is_refused_and_creates_no_attempt(world, client_for, db):  # BR §6.3
    _, obligation = opens_later(world, "T1", NOW + timedelta(minutes=30))
    client = client_for(world.employee)
    response = client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ASSESSMENT_NOT_DUE"
    assert attempts(db) == 0
    assert entry(client, obligation.id)["entry_state"] == "NOT_YET_OPEN"


def test_my_trainings_card_shows_the_opening_moment_and_a_start_action_before_it_opens(world, client_for, db):
    training, obligation = opens_later(world, "T1", NOW + timedelta(days=1))
    card = card_for(client_for(world.employee), training)
    assert card["entry_state"] == "NOT_YET_OPEN"
    assert card["obligation_id"] == str(obligation.id)
    assert card["due_at"] == iso(NOW + timedelta(days=1))
    assert card["timezone"] == "UTC"  # The test world's organisation calendar.
    assert card["pending_group"] == "UPCOMING"


# ---------- The opening boundary ----------

def test_at_the_opening_moment_the_backend_confirms_it_open_and_the_gate_takes_over(world, client_for, db):  # BR §5
    opens = NOW + timedelta(minutes=10)
    _, obligation = opens_later(world, "T1", opens)
    client = client_for(world.employee)

    clock.freeze(opens - timedelta(seconds=1))
    assert entry(client, obligation.id)["entry_state"] == "NOT_YET_OPEN"
    assert client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}).status_code == 409

    clock.freeze(opens)
    data = entry(client, obligation.id)
    assert data["entry_state"] == "OPEN" and data["server_now"] == iso(opens)
    gate = client.get("/me/access-state").json()["data"]
    assert gate["access_status"] == "ASSESSMENT_REQUIRED" and gate["queue"][0]["obligation_id"] == str(obligation.id)
    assert client.get("/me/trainings").status_code == 403  # The workspace stays closed: no fail-open card access.
    assert attempts(db) == 0  # Re-checking never starts anything; the employee still confirms the instructions.
    start(client, obligation.id)
    assert attempts(db) == 1


def test_a_rescheduled_assessment_reports_its_new_opening_while_the_employee_waits(world, client_for, db):  # BR §4.3
    training, obligation = opens_later(world, "T1", NOW + timedelta(hours=1))
    client = client_for(world.employee)
    assert entry(client, obligation.id)["due_at"] == iso(NOW + timedelta(hours=1))
    later = NOW + timedelta(days=1, hours=3)
    saved = client_for(world.admin).post(
        f"/admin/trainings/{training.id}/assessment-configs",
        json={"question_count": 10, "duration_minutes": 15, "pass_mark_percent": 70, "schedule_mode": "FIXED_DATE", "schedule_date": later.date().isoformat(), "schedule_time": later.strftime("%H:%M"), "apply_to_waiting": True},
    )
    assert saved.status_code == 200, saved.text
    data = entry(client, obligation.id)
    assert data["entry_state"] == "NOT_YET_OPEN" and data["due_at"] == iso(later)


# ---------- Already due and resuming ----------

def test_in_progress_assessment_reports_resume_and_keeps_the_server_deadline(world, client_for, db):  # BR §6.5
    training = world.training("T1", duration_seconds=900)
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    clock.freeze(NOW + timedelta(minutes=5))
    data = entry(client, obligation.id)
    assert data["entry_state"] == "IN_PROGRESS" and data["active_attempt_id"] == attempt["attempt_id"]
    resumed = client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]
    assert resumed["remaining_seconds"] == 600 and resumed["expires_at"] == attempt["expires_at"]  # Not reset by resuming.


# ---------- Completion remains the only trigger ----------

def test_saved_schedule_without_recorded_completion_offers_no_start(world, client_for, db):  # BR §4.1
    opens = NOW + timedelta(days=2)
    training = world.training("T1", schedule_mode="FIXED_DATE", schedule_date=opens.date(), schedule_at=opens)
    world.enrol(world.employee, training)
    card = card_for(client_for(world.employee), training)
    assert card["obligation_id"] is None and card["due_at"] is None
    assert card["planned_at"] == iso(opens)  # Shown as planned, but not actionable.
    assert card["entry_state"] == "UNAVAILABLE" and card["entry_reason"] == "AWAITING_COMPLETION"
    assert card["entry_message"].startswith("Awaiting training completion")
    assert card["pending_group"] == "UNFINISHED"
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 0


def test_passing_the_pre_test_does_not_record_completion_or_open_the_post_test(world, client_for, db):  # SC-2L-107
    from app.models import AssessmentConfig
    from tests.conftest import answer_with_score, submit

    training = world.training("T1")
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type="PRE_TEST", version=1, question_count=10, duration_seconds=600, max_attempts=1))
    db.commit()
    enrolment = world.enrol(world.employee, training)
    client = client_for(world.employee)
    attempt = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True}).json()["data"]
    answer_with_score(db, client, attempt, 10)
    submit(client, attempt["attempt_id"])

    db.expire_all()
    assert db.get(Enrolment, enrolment.id).completion is None
    card = card_for(client, training)
    assert card["completed_at"] is None and card["pre_test_score"] == 100.0
    assert card["entry_state"] == "UNAVAILABLE" and card["entry_reason"] == "AWAITING_COMPLETION"
    assert client.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


# ---------- Unavailable assessments explain why, without an action that would fail ----------

def test_due_assessment_with_an_incomplete_question_pool_reports_the_backend_reason(world, client_for, db):
    training = world.training("T1")
    obligation = world.complete(world.employee, training)
    for question in db.scalars(select(Question)):
        question.status = QuestionStatus.INACTIVE
    db.commit()
    client = client_for(world.employee)
    data = entry(client, obligation.id)
    assert data["entry_state"] == "UNAVAILABLE" and data["entry_reason"] == "QUESTION_POOL_INSUFFICIENT"
    assert "question pool is incomplete" in data["entry_message"]
    card = card_for(client, training)
    assert (card["entry_state"], card["entry_reason"], card["pending_group"]) == ("UNAVAILABLE", "QUESTION_POOL_INSUFFICIENT", "UNFINISHED")


def test_archived_waived_and_cancelled_assessments_report_their_reason(world, client_for, db):
    archived, waived, cancelled = (world.training(code) for code in ("T1", "T2", "T3"))
    obligations = [world.complete(world.employee, t, when=NOW + timedelta(hours=-1)) for t in (archived, waived, cancelled)]
    for o in obligations:  # Scheduled for later, so none of them closes the workspace.
        row = db.get(AssessmentObligation, o.id)
        row.status, row.due_at = ObligationStatus.SCHEDULED, NOW + timedelta(hours=4)
    db.get(AssessmentObligation, obligations[1].id).status = ObligationStatus.WAIVED
    db.get(AssessmentObligation, obligations[2].id).status = ObligationStatus.CANCELLED
    db.get(type(archived), archived.id).status = TrainingStatus.ARCHIVED
    db.commit()
    client = client_for(world.employee)
    reasons = {c["title"]: (c["entry_state"], c["entry_reason"], c["pending_group"]) for c in cards(client)}
    assert reasons["Training T1"] == ("UNAVAILABLE", "TRAINING_ARCHIVED", "UNFINISHED")
    assert reasons["Training T2"] == ("UNAVAILABLE", "WAIVED", "FINISHED")
    assert reasons["Training T3"] == ("UNAVAILABLE", "CANCELLED", "FINISHED")
    assert entry(client, obligations[0].id)["entry_reason"] == "TRAINING_ARCHIVED"


# ---------- Pending first ----------

def test_my_trainings_lists_upcoming_then_unfinished_then_finished(world, client_for, db):
    opens_later(world, "Z-LATER", NOW + timedelta(days=3))
    opens_later(world, "Y-SOONER", NOW + timedelta(hours=3))
    awaiting = world.training("A-AWAIT")
    world.enrol(world.employee, awaiting)
    client = client_for(world.employee)

    passed = world.training("B-PASSED")
    result = take(db, client, world.complete(world.employee, passed).id, 10)
    give_feedback(client, result["attempt_id"])
    failed = world.training("C-FAILED")
    result = take(db, client, world.complete(world.employee, failed).id, 2)
    give_feedback(client, result["attempt_id"])  # Retake pending: waits for L&D, so not finished.

    listed = cards(client)
    assert [c["title"] for c in listed] == ["Training Y-SOONER", "Training Z-LATER", "Training C-FAILED", "Training A-AWAIT", "Training B-PASSED"]
    assert [c["pending_group"] for c in listed] == ["UPCOMING", "UPCOMING", "UNFINISHED", "UNFINISHED", "FINISHED"]
    retake = listed[2]
    assert (retake["entry_state"], retake["entry_reason"]) == ("UNAVAILABLE", "AWAITING_APPROVAL")


def _card(title, group, *, state="UNAVAILABLE", reason=None, due=None, planned=None, enrolment="e"):
    return {"title": title, "pending_group": group, "entry_state": state, "entry_reason": reason, "due_at": due, "planned_at": planned, "enrolment_id": enrolment}


def test_order_puts_due_and_in_progress_first_and_is_deterministic():
    from app.modules.employee.router import order_cards

    unordered = [
        _card("Finished", "FINISHED", reason="COMPLETED"),
        _card("Awaiting completion", "UNFINISHED", reason="AWAITING_COMPLETION"),
        _card("Feedback owed", "UNFINISHED", reason="FEEDBACK_REQUIRED"),
        _card("Upcoming later", "UPCOMING", state="NOT_YET_OPEN", due="2026-11-06T00:00:00+00:00"),
        _card("Due", "DUE", state="OPEN", due="2026-11-03T00:00:00+00:00"),
        _card("Upcoming sooner", "UPCOMING", state="NOT_YET_OPEN", due="2026-11-05T00:00:00+00:00"),
        _card("Running", "DUE", state="IN_PROGRESS", due="2026-11-04T00:00:00+00:00"),
        _card("Approval", "UNFINISHED", reason="AWAITING_APPROVAL"),
        _card("Same title", "FINISHED", reason="WAIVED", enrolment="b"),
        _card("Same title", "FINISHED", reason="WAIVED", enrolment="a"),
    ]
    expected = ["Running", "Due", "Upcoming sooner", "Upcoming later", "Feedback owed", "Approval", "Awaiting completion", "Finished", "Same title", "Same title"]
    assert [c["title"] for c in order_cards(unordered)] == expected
    assert [c["title"] for c in order_cards(list(reversed(unordered)))] == expected
    assert [c["enrolment_id"] for c in order_cards(unordered) if c["title"] == "Same title"] == ["a", "b"]


def test_owed_feedback_and_needs_retraining_are_never_counted_as_finished(world, client_for, db):
    from app.modules.employee.router import _cards, _rows

    training = world.training("T1", max_attempts=1)
    client = client_for(world.employee)
    take(db, client, world.complete(world.employee, training).id, 10)  # Passed, feedback not yet given.
    other = world.training("T2", max_attempts=1)
    result = take(db, client, world.complete(world.employee, other).id, 1)  # Final failure: Needs Re-training.
    assert result["needs_retraining"] is True

    class Who:
        employee_id = world.employee.id

    db.expire_all()
    by_title = {c["title"]: c for c in _cards(db, _rows(db, Who()), NOW)}
    assert by_title["Training T1"]["pending_group"] == "UNFINISHED" and by_title["Training T1"]["entry_reason"] == "FEEDBACK_REQUIRED"
    assert by_title["Training T2"]["pending_group"] == "UNFINISHED" and by_title["Training T2"]["entry_reason"] == "AWAITING_APPROVAL"
