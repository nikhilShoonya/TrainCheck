"""The automatic countdown before a scheduled post-test opens (access_state.countdown).

The backend only reports which assigned, scheduled, eligible post-test opens within five minutes; it never
creates or starts anything, and start_attempt still refuses any start before the opening moment.
Synthetic data only. NOW is Wednesday 2026-11-04 06:00 UTC."""
from datetime import timedelta

from sqlalchemy import func, select

from app.core import clock
from app.core.enums import AssessmentType, ObligationStatus, QuestionStatus, TrainingStatus
from app.core.responses import iso
from app.models import AssessmentAttempt, AssessmentConfig, AssessmentObligation, Question
from tests.conftest import NOW, give_feedback, start, take


def opens_at(world, code: str, moment, employee=None, completed=None):
    training = world.training(code, schedule_mode="FIXED_DATE", schedule_date=moment.date(), schedule_at=moment)
    obligation = world.complete(employee or world.employee, training, when=completed or NOW - timedelta(hours=1))
    return training, obligation


def state(client) -> dict:
    response = client.get("/me/access-state")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def attempts(db) -> int:
    return db.scalar(select(func.count()).select_from(AssessmentAttempt))


# ---------- The five-minute window ----------

def test_more_than_five_minutes_away_gives_no_countdown_but_says_when_it_begins(world, client_for, db):
    opens = NOW + timedelta(minutes=5, seconds=1)
    opens_at(world, "T1", opens)
    data = state(client_for(world.employee))
    assert data["access_status"] == "DASHBOARD_ALLOWED"
    assert data["countdown"] is None
    assert data["countdown_starts_at"] == iso(opens - timedelta(minutes=5))
    assert data["server_now"] == iso(NOW)


def test_exactly_five_minutes_away_opens_the_countdown(world, client_for, db):
    opens = NOW + timedelta(minutes=5)
    training, obligation = opens_at(world, "T1", opens)
    data = state(client_for(world.employee))
    assert data["access_status"] == "DASHBOARD_ALLOWED"  # The workspace is not closed by the server before opening.
    assert data["countdown"] == {"obligation_id": str(obligation.id), "training_title": training.title, "due_at": iso(opens), "timezone": "UTC"}
    assert data["countdown_starts_at"] is None


def test_less_than_five_minutes_away_opens_the_countdown_and_creates_nothing(world, client_for, db):
    opens = NOW + timedelta(minutes=3)
    _, obligation = opens_at(world, "T1", opens)
    client = client_for(world.employee)
    assert state(client)["countdown"]["obligation_id"] == str(obligation.id)
    assert attempts(db) == 0
    response = client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ASSESSMENT_NOT_DUE"
    assert attempts(db) == 0  # No attempt and no questions before the opening moment.


def test_entering_the_window_later_is_seen_on_the_next_check(world, client_for, db):
    opens = NOW + timedelta(minutes=20)
    opens_at(world, "T1", opens)
    client = client_for(world.employee)
    assert state(client)["countdown"] is None
    clock.freeze(opens - timedelta(minutes=5, seconds=1))
    assert state(client)["countdown"] is None
    clock.freeze(opens - timedelta(minutes=4, seconds=59))
    assert state(client)["countdown"] is not None


def test_at_the_opening_the_gate_takes_over_and_the_countdown_ends(world, client_for, db):
    opens = NOW + timedelta(minutes=2)
    _, obligation = opens_at(world, "T1", opens)
    client = client_for(world.employee)
    clock.freeze(opens)
    data = state(client)
    assert data["access_status"] == "ASSESSMENT_REQUIRED" and data["queue"][0]["obligation_id"] == str(obligation.id)
    assert data["countdown"] is None
    assert attempts(db) == 0  # Still nothing until the employee's own start request.
    first = start(client, obligation.id)
    again = start(client, obligation.id)  # A repeated start (second tab, uncertain retry) joins the same attempt.
    assert again["attempt_id"] == first["attempt_id"] and attempts(db) == 1


# ---------- Who gets a countdown ----------

def test_no_assignment_means_no_countdown(world, client_for, db):
    data = state(client_for(world.employee))
    assert data["countdown"] is None and data["countdown_starts_at"] is None


def test_an_assigned_training_without_recorded_completion_never_gets_a_countdown(world, client_for, db):
    opens = NOW + timedelta(minutes=2)
    training = world.training("T1", schedule_mode="FIXED_DATE", schedule_date=opens.date(), schedule_at=opens)
    world.enrol(world.employee, training)  # Planned only: no assessment exists, and none is created.
    data = state(client_for(world.employee))
    assert data["countdown"] is None
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 0


def test_pre_tests_never_get_a_countdown(world, client_for, db):
    opens = NOW + timedelta(minutes=2)
    training = world.training("T1")
    enrolment = world.enrol(world.employee, training)
    config = db.scalar(select(AssessmentConfig).where(AssessmentConfig.training_id == training.id))
    db.add(AssessmentObligation(enrolment_id=enrolment.id, employee_id=world.employee.id, training_id=training.id, config_id=config.id, assessment_type=AssessmentType.PRE_TEST, status=ObligationStatus.SCHEDULED, due_at=opens))
    db.commit()
    assert state(client_for(world.employee))["countdown"] is None


def test_waived_cancelled_and_archived_assessments_lose_their_countdown(world, client_for, db):
    _, waived = opens_at(world, "T1", NOW + timedelta(minutes=2))
    client = client_for(world.employee)
    assert state(client)["countdown"]["obligation_id"] == str(waived.id)
    response = client_for(world.admin).post(f"/admin/obligations/{waived.id}/waive", json={"reason": "Synthetic waiver for the test."})
    assert response.status_code == 200, response.text
    assert state(client)["countdown"] is None

    training, cancelled = opens_at(world, "T2", NOW + timedelta(minutes=3))
    assert state(client)["countdown"]["obligation_id"] == str(cancelled.id)
    db.execute(AssessmentObligation.__table__.update().where(AssessmentObligation.id == cancelled.id).values(status=ObligationStatus.CANCELLED))
    db.commit()
    assert state(client)["countdown"] is None

    archived_training, archived = opens_at(world, "T3", NOW + timedelta(minutes=4))
    assert state(client)["countdown"]["obligation_id"] == str(archived.id)
    archived_training.status = TrainingStatus.ARCHIVED
    db.commit()
    assert state(client)["countdown"] is None


def test_an_assessment_that_could_not_start_gets_no_countdown(world, client_for, db):
    training, _ = opens_at(world, "T1", NOW + timedelta(minutes=2))
    for question in db.scalars(select(Question).where(Question.question_code.like("T1-%"))).all()[:5]:
        question.status = QuestionStatus.INACTIVE  # The pool can no longer draw ten questions.
    db.commit()
    assert state(client_for(world.employee))["countdown"] is None


def test_rescheduling_moves_or_removes_the_countdown(world, client_for, db):
    _, obligation = opens_at(world, "T1", NOW + timedelta(minutes=2))
    client = client_for(world.employee)
    assert state(client)["countdown"]["due_at"] == iso(NOW + timedelta(minutes=2))
    obligation.due_at = NOW + timedelta(hours=2)
    db.commit()
    data = state(client)
    assert data["countdown"] is None and data["countdown_starts_at"] == iso(NOW + timedelta(hours=2) - timedelta(minutes=5))
    obligation.due_at = NOW + timedelta(minutes=4)
    db.commit()
    assert state(client)["countdown"]["due_at"] == iso(NOW + timedelta(minutes=4))


def test_the_nearest_opening_comes_first_and_ties_keep_the_queue_order(world, client_for, db):
    opens = NOW + timedelta(minutes=3)
    _, later = opens_at(world, "T1", NOW + timedelta(minutes=4), completed=NOW - timedelta(days=3))
    _, newer = opens_at(world, "T2", opens, completed=NOW - timedelta(hours=1))
    _, older = opens_at(world, "T3", opens, completed=NOW - timedelta(days=2))
    client = client_for(world.employee)
    assert state(client)["countdown"]["obligation_id"] == str(older.id)  # Same opening: oldest completion first.
    older.status = ObligationStatus.WAIVED
    db.commit()
    assert state(client)["countdown"]["obligation_id"] == str(newer.id)
    newer.status = ObligationStatus.WAIVED
    db.commit()
    assert state(client)["countdown"]["obligation_id"] == str(later.id)  # Then the next opening.


# ---------- Priorities: a due assessment, then owed feedback, then the countdown ----------

def test_a_due_assessment_comes_before_any_countdown(world, client_for, db):
    due = world.complete(world.employee, world.training("T1"))
    opens_at(world, "T2", NOW + timedelta(minutes=2))
    data = state(client_for(world.employee))
    assert data["access_status"] == "ASSESSMENT_REQUIRED" and data["queue"][0]["obligation_id"] == str(due.id)
    assert data["countdown"] is None


def test_owed_feedback_comes_before_the_countdown_and_the_countdown_follows_it(world, client_for, db):
    due = world.complete(world.employee, world.training("T1"))
    client = client_for(world.employee)
    result = take(db, client, due.id, 10)
    _, upcoming = opens_at(world, "T2", NOW + timedelta(minutes=2))
    data = state(client)
    assert data["access_status"] == "FEEDBACK_REQUIRED" and data["countdown"] is None
    give_feedback(client, result["attempt_id"])
    data = state(client)
    assert data["access_status"] == "DASHBOARD_ALLOWED" and data["countdown"]["obligation_id"] == str(upcoming.id)


def test_another_employees_assessment_is_never_shown(world, client_for, db):
    opens_at(world, "T1", NOW + timedelta(minutes=2), employee=world.teammate)
    assert state(client_for(world.employee))["countdown"] is None
