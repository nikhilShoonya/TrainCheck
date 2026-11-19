"""Custom-date schedules with a time of day (organisation timezone, stored as UTC), and applying saved rules to
employees already waiting. MVP-009, BR §3.1, BR §4.1, BR §4.3, OD-BRD-004.

NOW is Wednesday 2026-11-04 06:00 UTC, which is 11:30 in Asia/Kolkata (UTC+05:30)."""
from datetime import UTC, date, datetime, time, timedelta

import pytest
from sqlalchemy import select

from app.core import clock
from app.models import AssessmentAttempt, AssessmentObligation, AuditLog, WorkingCalendar
from app.modules.assessment.scheduling import CalendarView
from tests.conftest import NOW, start, take

RULES = {"question_count": 10, "duration_minutes": 20, "pass_mark_percent": 70, "schedule_mode": "FIXED_DATE"}
INDIA = CalendarView("Asia/Kolkata", [0, 1, 2, 3, 4], set())
LONDON = CalendarView("Europe/London", [0, 1, 2, 3, 4], set())


def india(db) -> None:
    """The test world's calendar is UTC; these tests use the organisation's default, Asia/Kolkata."""
    db.scalar(select(WorkingCalendar)).timezone = "Asia/Kolkata"
    db.commit()


def save(admin, training, **extra):
    return admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={**RULES, **extra})


def moment(text: str) -> datetime:
    return datetime.fromisoformat(text)


def card(client, training) -> dict:
    return next(c for c in client.get("/me/trainings").json()["data"] if c["training_id"] == str(training.id))


def test_local_date_and_time_convert_to_utc_across_midnight_and_clock_changes():  # OD-BRD-004
    assert INDIA.to_utc(date(2026, 11, 5), time(3, 0)) == datetime(2026, 11, 4, 21, 30, tzinfo=UTC)  # Previous UTC day.
    assert INDIA.to_utc(date(2026, 11, 5), time(23, 45)) == datetime(2026, 11, 5, 18, 15, tzinfo=UTC)
    with pytest.raises(ValueError):
        LONDON.to_utc(date(2026, 3, 29), time(1, 30))  # Skipped when the clocks go forward.
    assert LONDON.to_utc(date(2026, 10, 25), time(1, 30)) == datetime(2026, 10, 25, 0, 30, tzinfo=UTC)  # Repeated: the first.


def test_custom_date_needs_a_valid_time_and_never_assumes_midnight(world, client_for, db):
    india(db)
    training = world.training()
    admin = client_for(world.admin)
    tomorrow = "2026-11-05"
    missing = save(admin, training, schedule_date=tomorrow)
    assert missing.status_code == 400
    assert "time" in missing.json()["error"]["message"] and "Asia/Kolkata" in missing.json()["error"]["message"]
    assert save(admin, training, schedule_time="10:00").status_code == 400  # No date.
    assert save(admin, training, schedule_date=tomorrow, schedule_time="25:00").status_code == 400
    assert save(admin, training, schedule_date="2026-02-30", schedule_time="10:00").status_code == 400


def test_today_with_a_passed_time_is_refused_and_a_later_time_is_stored_as_utc(world, client_for, db):
    india(db)
    training = world.training()
    admin = client_for(world.admin)
    passed = save(admin, training, schedule_date="2026-11-04", schedule_time="11:00")  # 11:30 now in India.
    assert passed.status_code == 400 and "has passed" in passed.json()["error"]["message"]
    assert save(admin, training, schedule_date="2026-11-03", schedule_time="18:00").status_code == 400  # Yesterday.
    saved = save(admin, training, schedule_date="2026-11-04", schedule_time="15:30")
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert moment(data["schedule_at"]) == datetime(2026, 11, 4, 10, 0, tzinfo=UTC)
    assert (data["schedule_date"], data["schedule_time"], data["timezone"]) == ("2026-11-04", "15:30", "Asia/Kolkata")


def test_reopening_shows_the_saved_date_and_time_and_editing_keeps_it(world, client_for, db):
    india(db)
    training = world.training()
    admin = client_for(world.admin)
    assert save(admin, training, schedule_date="2026-11-06", schedule_time="02:00").status_code == 200  # 05 Nov 20:30 UTC.
    config = admin.get(f"/admin/trainings/{training.id}").json()["data"]["config"]
    assert (config["schedule_mode"], config["schedule_date"], config["schedule_time"], config["timezone"]) == ("FIXED_DATE", "2026-11-06", "02:00", "Asia/Kolkata")
    assert moment(config["schedule_at"]) == datetime(2026, 11, 5, 20, 30, tzinfo=UTC)

    edited = save(admin, training, schedule_date="2026-11-06", schedule_time="02:00", duration_minutes=30)  # Other settings only.
    assert edited.status_code == 200 and edited.json()["data"]["duration_minutes"] == 30
    clock.freeze(datetime(2026, 11, 6, 0, 0, tzinfo=UTC))  # The opening moment has now passed.
    admin = client_for(world.admin)  # A new sign-in: the earlier session has expired by then.
    kept = save(admin, training, schedule_date="2026-11-06", schedule_time="02:00", duration_minutes=25)
    assert kept.status_code == 200, "re-saving keeps an unchanged opening moment even after it passed"
    assert save(admin, training, schedule_date="2026-11-06", schedule_time="03:00").status_code == 400  # A new past moment.
    moved = save(admin, training, schedule_date="2026-11-07", schedule_time="09:00")
    assert moved.status_code == 200 and moved.json()["data"]["schedule_time"] == "09:00"


def test_existing_custom_dates_without_a_time_keep_opening_at_the_start_of_the_day(world, db):
    training = world.training(schedule_mode="FIXED_DATE", schedule_date=date(2026, 11, 5))
    obligation = world.complete(world.employee, training, NOW - timedelta(hours=1))
    assert obligation.due_at == datetime(2026, 11, 5, tzinfo=UTC)  # The test calendar is UTC.
    assert obligation.schedule_snapshot["at"] == "2026-11-05T00:00:00+00:00"


def test_employee_without_a_recorded_completion_sees_why_not_a_bare_not_scheduled(world, client_for, db):  # BR §4.1
    india(db)
    training = world.training()
    world.enrol(world.employee, training)  # Assigned; completion not recorded (the reported case).
    saved = save(client_for(world.admin), training, schedule_date="2026-11-04", schedule_time="15:30", apply_to_waiting=True)
    assert saved.status_code == 200
    assert saved.json()["data"]["applied"] == {"scheduled": [], "rescheduled": []}
    employee = client_for(world.employee)
    shown = card(employee, training)
    assert shown["assessment_state"] == "Awaiting training completion"
    assert shown["due_at"] is None and shown["obligation_id"] is None
    assert moment(shown["planned_at"]) == datetime(2026, 11, 4, 10, 0, tzinfo=UTC)
    assert shown["timezone"] == "Asia/Kolkata"
    assert db.scalar(select(AssessmentObligation)) is None, "completion is still the only trigger"
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


def test_applying_moves_assessments_not_started_and_never_running_or_submitted_ones(world, client_for, db):  # BR §3.1, §4.3
    india(db)
    training = world.training()
    waiting = world.complete(world.employee, training)
    running = world.complete(world.teammate, training)
    attempt = start(client_for(world.teammate), running.id)
    submitted = world.complete(world.outsider, training)
    take(db, client_for(world.outsider), submitted.id, 8)
    db.expire_all()
    before_running = db.get(AssessmentAttempt, attempt["attempt_id"])
    running_deadline, running_snapshot = before_running.expires_at, dict(before_running.config_snapshot)
    submitted_due, submitted_config = db.get(AssessmentObligation, submitted.id).due_at, db.get(AssessmentObligation, submitted.id).config_id

    saved = save(client_for(world.admin), training, schedule_date="2026-11-05", schedule_time="10:00", apply_to_waiting=True)
    assert saved.status_code == 200, saved.text
    applied = saved.json()["data"]["applied"]
    assert [r["employee_code"] for r in applied["rescheduled"]] == ["E1"]
    db.expire_all()
    moved = db.get(AssessmentObligation, waiting.id)
    assert moved.due_at == datetime(2026, 11, 5, 4, 30, tzinfo=UTC)
    assert moved.config.version == 2 and moved.status == "SCHEDULED"
    assert moved.schedule_snapshot["config_version"] == 2 and moved.schedule_snapshot["at"] == "2026-11-05T04:30:00+00:00"
    assert moved.completed_training_at == waiting.completed_training_at, "the completion time is kept"
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "ASSESSMENT_OBLIGATION_RESCHEDULED"))
    assert audit is not None and audit.target_id == str(waiting.id)
    assert (audit.before_summary["config_version"], audit.after_summary["config_version"]) == (1, 2)

    still_running = db.get(AssessmentAttempt, attempt["attempt_id"])
    assert (still_running.status, still_running.expires_at, still_running.config_snapshot) == ("IN_PROGRESS", running_deadline, running_snapshot)
    assert db.get(AssessmentObligation, running.id).config.version == 1
    assert (db.get(AssessmentObligation, submitted.id).due_at, db.get(AssessmentObligation, submitted.id).config_id) == (submitted_due, submitted_config)


def test_without_applying_existing_assessments_keep_their_schedule(world, client_for, db):  # BR §3.1: prospective
    india(db)
    training = world.training()
    waiting = world.complete(world.employee, training)
    due, config_id = waiting.due_at, waiting.config_id
    saved = save(client_for(world.admin), training, schedule_date="2026-11-05", schedule_time="10:00")
    assert saved.status_code == 200 and saved.json()["data"]["applied"] is None
    db.expire_all()
    assert (db.get(AssessmentObligation, waiting.id).due_at, db.get(AssessmentObligation, waiting.id).config_id) == (due, config_id)


def test_assessment_opens_at_the_scheduled_moment_without_saving_again(world, client_for, db):  # MVP-009, gate
    india(db)
    training = world.training()
    obligation = world.complete(world.employee, training)
    save(client_for(world.admin), training, schedule_date="2026-11-04", schedule_time="15:30", apply_to_waiting=True)
    employee = client_for(world.employee)
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    shown = card(employee, training)
    assert shown["assessment_state"] == "Scheduled" and moment(shown["due_at"]) == datetime(2026, 11, 4, 10, 0, tzinfo=UTC)
    early = employee.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert early.status_code == 409 and early.json()["error"]["code"] == "ASSESSMENT_NOT_DUE"

    clock.freeze(datetime(2026, 11, 4, 9, 59, 59, tzinfo=UTC))
    employee = client_for(world.employee)  # Signs in again later that day.
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    clock.freeze(datetime(2026, 11, 4, 10, 0, tzinfo=UTC))  # 15:30 in India: due now, nothing saved again.
    employee = client_for(world.employee)
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"
    assert start(employee, obligation.id)["status"] == "IN_PROGRESS"


def test_a_completion_left_unscheduled_is_scheduled_when_valid_rules_are_applied(world, client_for, db):
    india(db)
    training = world.training(questions=5, count=10)  # The pool cannot run the first rules.
    world.enrol(world.employee, training)
    admin = client_for(world.admin)
    enrolment = admin.get("/admin/enrolments").json()["data"]
    assert db.scalar(select(AssessmentObligation)) is None
    recorded = admin.post(f"/admin/enrolments/{enrolment[0]['id']}/completion", json={"completion_date": "2026-11-04"})
    assert recorded.status_code == 200, recorded.text
    assert db.scalar(select(AssessmentObligation)) is None  # Recorded, but no assessment could be scheduled.

    saved = save(admin, training, question_count=5, schedule_date="2026-11-05", schedule_time="09:00", apply_to_waiting=True)
    assert saved.status_code == 200, saved.text
    assert [s["employee_code"] for s in saved.json()["data"]["applied"]["scheduled"]] == ["E1"]
    obligation = db.scalar(select(AssessmentObligation))
    assert obligation.due_at == datetime(2026, 11, 5, 3, 30, tzinfo=UTC)


def _saved_rules(client_for, world, training, **extra):
    """Saves new rules without applying them, so applying can run on its own below."""
    saved = save(client_for(world.admin), training, schedule_date="2026-11-06", schedule_time="10:00", **extra)
    assert saved.status_code == 200, saved.text
    return saved.json()["data"]


def test_an_attempt_started_while_rules_are_applied_is_never_rescheduled(world, client_for, db, monkeypatch):
    """The eligibility check and the update happen under the obligation's row lock, the lock starting an attempt
    takes, so an attempt starting in between is seen and its assessment is left alone."""
    from app.core import db as database
    from app.models import AssessmentConfig, Training
    from app.modules.training import service as training_service

    india(db)
    training = world.training()
    obligation = world.complete(world.employee, training)
    employee = client_for(world.employee)
    _saved_rules(client_for, world, training)
    started = {}
    find = training_service.not_started_post_tests

    def then_start(session, training_id):
        found = find(session, training_id)  # Seen as not started...
        started["attempt"] = start(employee, obligation.id)  # ...and then started by the employee, in another request.
        return found

    monkeypatch.setattr(training_service, "not_started_post_tests", then_start)
    session = database.session_factory()()
    config = session.scalar(select(AssessmentConfig).where(AssessmentConfig.training_id == training.id, AssessmentConfig.is_active))
    applied = training_service.apply_schedule(session, session.get(Training, training.id), config, None)
    session.commit()
    session.close()

    assert applied["rescheduled"] == []
    db.expire_all()
    kept = db.get(AssessmentObligation, obligation.id)
    assert (kept.config.version, kept.due_at, kept.status) == (1, obligation.due_at, "IN_PROGRESS")
    attempt = db.get(AssessmentAttempt, started["attempt"]["attempt_id"])
    assert attempt.status == "IN_PROGRESS" and attempt.obligation_id == obligation.id
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED", "the gate still holds"


def test_an_assessment_moved_to_later_cannot_be_started_early(world, client_for, db):
    india(db)
    training = world.training()
    obligation = world.complete(world.employee, training)
    saved = save(client_for(world.admin), training, schedule_date="2026-11-06", schedule_time="10:00", apply_to_waiting=True)
    assert [r["employee_code"] for r in saved.json()["data"]["applied"]["rescheduled"]] == ["E1"]
    early = client_for(world.employee).post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    assert early.status_code == 409 and early.json()["error"]["code"] == "ASSESSMENT_NOT_DUE"


def test_after_a_timezone_change_the_reopened_schedule_is_the_same_moment(world, client_for, db):  # OD-BRD-004
    india(db)
    training = world.training()
    admin = client_for(world.admin)
    assert save(admin, training, schedule_date="2026-11-06", schedule_time="02:00").status_code == 200  # 05 Nov 20:30 UTC.
    db.scalar(select(WorkingCalendar)).timezone = "UTC"  # L&D changes the organisation timezone.
    db.commit()
    config = admin.get(f"/admin/trainings/{training.id}").json()["data"]["config"]
    # Date and time are both read from the stored moment, in the timezone now in force.
    assert (config["schedule_date"], config["schedule_time"], config["timezone"]) == ("2026-11-05", "20:30", "UTC")
    assert moment(config["schedule_at"]) == datetime(2026, 11, 5, 20, 30, tzinfo=UTC)
    resaved = save(admin, training, schedule_date=config["schedule_date"], schedule_time=config["schedule_time"], duration_minutes=25)
    assert resaved.status_code == 200, resaved.text
    assert moment(resaved.json()["data"]["schedule_at"]) == datetime(2026, 11, 5, 20, 30, tzinfo=UTC), "re-saving must not move it"


def test_access_state_says_when_the_next_assessment_opens(world, client_for, db):  # So an open page can re-check then.
    india(db)
    training = world.training()
    world.complete(world.employee, training)
    employee = client_for(world.employee)
    assert employee.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"  # SAME_DAY: due now.
    save(client_for(world.admin), training, schedule_date="2026-11-04", schedule_time="15:30", apply_to_waiting=True)
    state = client_for(world.employee).get("/me/access-state").json()["data"]
    assert state["access_status"] == "DASHBOARD_ALLOWED"
    assert moment(state["next_change_at"]) == datetime(2026, 11, 4, 10, 0, tzinfo=UTC)
    assert moment(state["server_now"]) == NOW
    nothing = client_for(world.teammate).get("/me/access-state").json()["data"]
    assert nothing["next_change_at"] is None
