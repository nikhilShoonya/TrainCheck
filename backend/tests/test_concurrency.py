"""L&D actions that race another request (a double click, two admins, or the employee starting meanwhile).

Each test lets the handler read the record, then lets "another request" change it and commit before the handler
writes, exactly the window a row lock closes. The outcome must be a clear 409, never a 500 or a lost update.
"""
from datetime import timedelta

from sqlalchemy import func, select

from app.core import db as database
from app.models import AssessmentAttempt, AssessmentConfig, AssessmentObligation, Enrolment, TrainingCompletion
from app.modules.training import router as training_router
from app.modules.training import service as training_service
from tests.conftest import NOW, start, take


def meanwhile(monkeypatch, loader_name: str, change) -> None:
    """Wraps a router loader so that, after it has read the row, `change(session)` runs in another session and commits."""
    real = getattr(training_router, loader_name)

    def stale(db, record_id):
        record = real(db, record_id)
        other = database.session_factory()()
        change(other)
        other.commit()
        other.close()
        return record

    monkeypatch.setattr(training_router, loader_name, stale)


def test_waive_does_not_overwrite_an_attempt_that_just_started(world, db, client_for, monkeypatch):
    obligation = world.complete(world.employee, world.training())
    employee = client_for(world.employee)

    def employee_starts(other):
        row = other.get(AssessmentObligation, obligation.id)
        row.status = "IN_PROGRESS"
        other.add(AssessmentAttempt(obligation_id=row.id, employee_id=row.employee_id, training_id=row.training_id, assessment_type="POST_TEST", attempt_number=1, status="IN_PROGRESS", started_at=NOW, expires_at=NOW + timedelta(minutes=15), config_snapshot={}))

    meanwhile(monkeypatch, "_obligation", employee_starts)
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "Exempt by policy"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ATTEMPT_IN_PROGRESS"
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).status == "IN_PROGRESS"
    assert employee.get("/me/access-state").status_code == 200


def test_double_approve_retake_is_a_conflict(world, db, client_for, monkeypatch):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    take(db, client, obligation.id, 5)

    def other_admin_approves(other):
        row = other.get(AssessmentObligation, obligation.id)
        row.status, row.due_at = "DUE", NOW

    meanwhile(monkeypatch, "_obligation", other_admin_approves)
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/approve-retake")
    assert response.status_code == 409 and response.json()["error"]["code"] == "NO_RETAKE_PENDING"


def test_double_retraining_cycle_is_a_conflict_not_a_server_error(world, db, client_for, monkeypatch):
    training = world.training()
    obligation = world.complete(world.employee, training)
    obligation.status, obligation.retraining_flag = "COMPLETED", "NEEDS_RETRAINING"
    db.commit()

    def other_admin_assigns_retraining(other):
        row = other.get(AssessmentObligation, obligation.id)
        row.retraining_flag = "RESOLVED"
        other.get(Enrolment, row.enrolment_id).training_cycle = 2

    meanwhile(monkeypatch, "_obligation", other_admin_assigns_retraining)
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-trained in person"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "NOT_FLAGGED"
    db.expire_all()
    assert db.get(Enrolment, obligation.enrolment_id).training_cycle == 2  # Never a third cycle.


def _other_admin_completes(enrolment_id):
    def change(other):
        other.add(TrainingCompletion(enrolment_id=enrolment_id, completed_at=NOW, completion_source="MANUAL"))
        other.get(Enrolment, enrolment_id).enrolment_status = "COMPLETED"

    return change


def test_double_completion_is_a_conflict_not_a_server_error(world, db, client_for, monkeypatch):
    """The other admin records completion after this request has read the enrolment but before it takes the row lock
    (the window a double click opens). Inside the lock the request must see that completion and refuse with 409.

    The race is placed before the lock on purpose: a writer cannot change the enrolment while the lock is held, so
    simulating it there would only wait for the lock timeout (a 503), which is not a race real requests can produce."""
    enrolment = world.enrol(world.employee, world.training())
    seen_without_completion = []
    real = training_router._enrolment

    def read_then_raced(session, record_id):
        record = real(session, record_id)
        seen_without_completion.append(record.completion is None)  # This request read it before the other one completed it.
        other = database.session_factory()()
        _other_admin_completes(enrolment.id)(other)
        other.commit()
        other.close()
        return record

    monkeypatch.setattr(training_router, "_enrolment", read_then_raced)
    response = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()})
    assert seen_without_completion == [True]
    assert response.status_code == 409 and response.json()["error"]["code"] == "COMPLETION_EXISTS"
    assert len(db.scalars(select(TrainingCompletion)).all()) == 1


def test_cancel_after_a_completion_meanwhile_is_refused(world, db, client_for, monkeypatch):
    enrolment = world.enrol(world.employee, world.training())
    real = training_router._enrolment

    def loaded_then_raced(session, record_id):
        record = real(session, record_id)
        assert record.completion is None  # Read fully before the other request completes it.
        other = database.session_factory()()
        _other_admin_completes(enrolment.id)(other)
        other.commit()
        other.close()
        return record

    monkeypatch.setattr(training_router, "_enrolment", loaded_then_raced)
    response = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/cancel", json={"reason": "Left the team"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ENROLMENT_COMPLETED"
    db.expire_all()
    assert db.get(Enrolment, enrolment.id).enrolment_status == "COMPLETED"


def test_two_settings_saves_at_once_give_a_conflict_not_a_server_error(world, db, client_for, monkeypatch):
    training = world.training()
    # The other save took version 2 meanwhile: this one computed the same next version.
    monkeypatch.setattr(training_router, "next_config_version", lambda *_args: 1)
    response = client_for(world.admin).post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 5, "duration_minutes": 15})
    assert response.status_code == 409 and response.json()["error"]["code"] == "CONFIG_CHANGED_MEANWHILE"
    db.expire_all()
    assert len(db.scalars(select(AssessmentConfig).where(AssessmentConfig.training_id == training.id, AssessmentConfig.is_active)).all()) == 1


def test_locked_reads_do_not_change_normal_behaviour(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    assert start(client, obligation.id)["attempt_number"] == 1
    assert training_service is not None


def test_two_pre_test_starts_at_once_share_one_obligation_not_a_server_error(world, db, client_for):
    """Audit B5. Both requests find no pre-test obligation; the other one inserts it first. This request must use that
    obligation (uq_obligation_cycle) and answer normally: one obligation, one attempt, no 500."""
    from sqlalchemy import event

    from app.core.enums import AssessmentType
    from app.models import AssessmentObligation as Obligation

    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=10, duration_seconds=600, max_attempts=1))
    enrolment = world.enrol(world.employee, training)
    db.commit()
    config_id = db.scalar(select(AssessmentConfig.id).where(AssessmentConfig.training_id == training.id, AssessmentConfig.assessment_type == AssessmentType.PRE_TEST))
    client = client_for(world.employee)
    raced = []
    factory = database.session_factory()

    def other_tab_inserts_first(session, _context, _instances):
        if raced or not any(isinstance(o, Obligation) and o.assessment_type == AssessmentType.PRE_TEST for o in session.new):
            return
        raced.append(True)
        other = factory()
        other.add(Obligation(enrolment_id=enrolment.id, employee_id=enrolment.employee_id, training_id=training.id, config_id=config_id, assessment_type=AssessmentType.PRE_TEST, status="DUE", due_at=NOW))
        other.commit()
        other.close()

    event.listen(factory, "before_flush", other_tab_inserts_first)
    try:
        response = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    finally:
        event.remove(factory, "before_flush", other_tab_inserts_first)
    assert raced == [True]
    assert response.status_code == 200, response.text
    db.expire_all()
    obligations = db.scalars(select(Obligation).where(Obligation.enrolment_id == enrolment.id, Obligation.assessment_type == AssessmentType.PRE_TEST)).all()
    assert len(obligations) == 1
    assert response.json()["data"]["obligation_id"] == str(obligations[0].id)
    assert len(db.scalars(select(AssessmentAttempt).where(AssessmentAttempt.obligation_id == obligations[0].id)).all()) == 1
    # A repeat from either tab resumes the same attempt.
    again = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert again.status_code == 200 and again.json()["data"]["attempt_id"] == response.json()["data"]["attempt_id"]


# ---------- Pre-tests of cancelled assignments (audit B16) ----------

def _pre_test_ready(world, db):
    from app.core.enums import AssessmentType

    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=10, duration_seconds=600, max_attempts=1))
    enrolment = world.enrol(world.employee, training)
    db.commit()
    return enrolment


def _pre_test_rows(db, enrolment_id) -> tuple[int, int]:
    db.expire_all()
    obligations = db.scalars(select(AssessmentObligation.id).where(AssessmentObligation.enrolment_id == enrolment_id, AssessmentObligation.assessment_type == "PRE_TEST")).all()
    attempts = db.scalars(select(AssessmentAttempt.id).where(AssessmentAttempt.obligation_id.in_(obligations))).all() if obligations else []
    return len(obligations), len(attempts)


def test_cancelled_assignment_offers_and_starts_no_pre_test(world, db, client_for):
    enrolment = _pre_test_ready(world, db)
    client = client_for(world.employee)
    assert client.get(f"/me/pre-tests/{enrolment.id}").json()["data"]["available"] is True
    assert client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/cancel", json={"reason": "Assigned in error"}).status_code == 200
    assert client.get(f"/me/pre-tests/{enrolment.id}").json()["data"]["available"] is False
    refused = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "PRE_TEST_UNAVAILABLE"
    assert "cancelled" in refused.json()["error"]["message"]
    assert _pre_test_rows(db, enrolment.id) == (0, 0)


def test_pre_test_start_waits_for_a_cancellation_holding_the_lock(world, db, client_for):
    """Another request (L&D cancelling) holds the enrolment lock. The start must wait for it, then see the
    cancellation and refuse: no obligation or attempt is created for a cancelled assignment."""
    import threading
    import time

    enrolment = _pre_test_ready(world, db)
    client = client_for(world.employee)
    other = database.session_factory()()
    row = other.scalar(select(Enrolment).where(Enrolment.id == enrolment.id).with_for_update())
    outcome: dict = {}
    starter = threading.Thread(target=lambda: outcome.setdefault("response", client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})))
    starter.start()
    time.sleep(1.5)
    assert starter.is_alive(), "the start must wait for the enrolment lock"
    row.enrolment_status, row.cancel_reason = "CANCELLED", "Assigned in error"
    other.commit()
    other.close()
    starter.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 409 and response.json()["error"]["code"] == "PRE_TEST_UNAVAILABLE", response.text
    assert _pre_test_rows(db, enrolment.id) == (0, 0)


def test_pre_test_start_rereads_a_cancellation_committed_after_its_first_read(world, db, client_for, monkeypatch):
    from app.modules.assessment import router as assessment_router

    enrolment = _pre_test_ready(world, db)
    real = assessment_router._own_enrolment

    def read_then_cancelled(session, enrolment_id, employee_id):
        record = real(session, enrolment_id, employee_id)
        assert record.enrolment_status != "CANCELLED"  # Read before the cancellation.
        other = database.session_factory()()
        other.get(Enrolment, enrolment.id).enrolment_status = "CANCELLED"
        other.commit()
        other.close()
        return record

    monkeypatch.setattr(assessment_router, "_own_enrolment", read_then_cancelled)
    response = client_for(world.employee).post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 409 and response.json()["error"]["code"] == "PRE_TEST_UNAVAILABLE"
    assert _pre_test_rows(db, enrolment.id) == (0, 0)


# ---------- Attendance racing completion (audit B17) ----------

def _complete_in(other, enrolment_id) -> None:
    other.add(TrainingCompletion(enrolment_id=enrolment_id, completed_at=NOW, completion_source="MANUAL"))
    row = other.get(Enrolment, enrolment_id)
    row.enrolment_status, row.attendance_status = "COMPLETED", "PRESENT"


def test_attendance_change_waits_for_a_completion_holding_the_lock(world, db, client_for):
    """L&D records completion (holding the enrolment lock) while another admin sets Absent. The attendance change
    must wait, then see the completion and refuse: a completed assignment never becomes Absent."""
    import threading
    import time

    enrolment = world.enrol(world.employee, world.training())
    admin = client_for(world.admin)
    other = database.session_factory()()
    other.scalar(select(Enrolment).where(Enrolment.id == enrolment.id).with_for_update())
    _complete_in(other, enrolment.id)
    other.flush()
    outcome: dict = {}
    changer = threading.Thread(target=lambda: outcome.setdefault("response", admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "ABSENT"})))
    changer.start()
    time.sleep(1.5)
    assert changer.is_alive(), "the attendance change must wait for the enrolment lock"
    other.commit()
    other.close()
    changer.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 409 and response.json()["error"]["code"] == "ATTENDANCE_LOCKED", response.text
    db.expire_all()
    assert db.get(Enrolment, enrolment.id).attendance_status == "PRESENT"


def test_attendance_change_rereads_a_completion_committed_after_its_first_read(world, db, client_for, monkeypatch):
    enrolment = world.enrol(world.employee, world.training())
    real = training_router._enrolment

    def read_then_completed(session, record_id):
        record = real(session, record_id)
        assert record.completion is None  # This request read it (and its completion) before the other one completed it.
        other = database.session_factory()()
        _complete_in(other, enrolment.id)
        other.commit()
        other.close()
        return record

    monkeypatch.setattr(training_router, "_enrolment", read_then_completed)
    response = client_for(world.admin).patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "ABSENT"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ATTENDANCE_LOCKED"
    db.expire_all()
    assert db.get(Enrolment, enrolment.id).attendance_status == "PRESENT"


def test_attendance_changes_still_work_when_nothing_races(world, db, client_for):
    enrolment = world.enrol(world.employee, world.training())
    admin = client_for(world.admin)
    for status in ("PRESENT", "ABSENT", "EXCUSED", "PENDING"):
        response = admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": status})
        assert response.status_code == 200 and response.json()["data"]["attendance_status"] == status


# ---------- Two admins editing one question ----------

def _question_edit(training_id, version, text, options):
    return {
        "topic": "Topic", "question_type": "MCQ_SINGLE", "question_text": text, "options": options, "correct_option_indexes": [0],
        "difficulty": "EASY", "marks": 1, "language": "English", "training_ids": [str(training_id)], "expected_version": version,
    }


def test_two_question_edits_at_once_the_stale_one_is_refused_not_a_server_error(world, db, client_for):
    """Admin 1 is part-way through saving (holding the question's row lock, options, answer key and revision N+1
    written). Admin 2's edit, made against version N, must wait, then be refused with 409: no 500, no duplicate
    revision, and admin 1's options and answer key are kept."""
    import threading
    import time

    from app.models import Question, QuestionAnswerKey, QuestionOption, QuestionRevision
    from app.modules.question_bank.router import set_content

    training = world.training("QED", questions=1, count=1)
    question = db.scalar(select(Question).where(Question.question_code == "QED-Q01"))
    question_id, version = question.id, question.version
    revisions_before = db.scalars(select(QuestionRevision.version).where(QuestionRevision.question_id == question_id).order_by(QuestionRevision.version)).all()
    admin = client_for(world.admin)

    other = database.session_factory()()
    mine = other.scalar(select(Question).where(Question.id == question_id).with_for_update())
    mine.version, mine.question_text = version + 1, "Admin one's text?"
    set_content(other, mine, ["One right", "One wrong"], [0])
    other.add(QuestionRevision(question_id=question_id, version=version + 1, content_snapshot={"question_text": "Admin one's text?"}))
    other.flush()

    outcome: dict = {}
    body = _question_edit(training.id, version, "Admin two's text?", ["Two right", "Two wrong"])
    editor = threading.Thread(target=lambda: outcome.setdefault("response", admin.patch(f"/admin/questions/{question_id}", json=body)))
    editor.start()
    time.sleep(1.5)
    assert editor.is_alive(), "the second edit must wait for the first one's lock"
    other.commit()
    other.close()
    editor.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "QUESTION_CHANGED"
    assert response.json()["error"]["details"] == {"current_version": version + 1, "expected_version": version}

    db.expire_all()
    saved = db.get(Question, question_id)
    assert (saved.version, saved.question_text) == (version + 1, "Admin one's text?")
    assert db.scalars(select(QuestionRevision.version).where(QuestionRevision.question_id == question_id).order_by(QuestionRevision.version)).all() == [*revisions_before, version + 1]
    options = db.scalars(select(QuestionOption).where(QuestionOption.question_id == question_id).order_by(QuestionOption.display_order)).all()
    assert [o.option_text for o in options] == ["One right", "One wrong"]
    assert db.scalars(select(QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id == question_id)).all() == [options[0].id]

    # Reloaded, admin 2's edit is made against the current version and saves; an edit without a version is refused.
    again = admin.patch(f"/admin/questions/{question_id}", json=_question_edit(training.id, version + 1, "Admin two's text?", ["Two right", "Two wrong"]))
    assert again.status_code == 200 and again.json()["data"]["version"] == version + 2, again.text
    missing = {k: v for k, v in body.items() if k != "expected_version"}
    assert admin.patch(f"/admin/questions/{question_id}", json=missing).status_code == 400


def test_a_stale_question_edit_is_refused_even_after_the_other_save_finished(world, db, client_for):
    """Two admins load version N; the first saves; the second's save from version N is refused, not applied over it."""
    from app.models import Question

    training = world.training("QED", questions=1, count=1)
    question = db.scalar(select(Question).where(Question.question_code == "QED-Q01"))
    first, second = client_for(world.admin), client_for(world.admin)
    assert first.patch(f"/admin/questions/{question.id}", json=_question_edit(training.id, question.version, "First save?", ["A", "B"])).status_code == 200
    stale = second.patch(f"/admin/questions/{question.id}", json=_question_edit(training.id, question.version, "Second save?", ["C", "D"]))
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "QUESTION_CHANGED"
    db.expire_all()
    assert db.get(Question, question.id).question_text == "First save?"


# ---------- Schedule pending assessments twice at once ----------

def _completed_without_assessment(world, db):
    """A completion recorded while the training could not run an assessment: no post-test obligation exists."""
    training = world.training("REC")
    enrolment = world.enrol(world.employee, training)
    db.add(TrainingCompletion(enrolment_id=enrolment.id, completed_at=NOW - timedelta(days=1), completion_source="MANUAL"))
    enrolment.enrolment_status, enrolment.attendance_status = "COMPLETED", "PRESENT"
    db.commit()
    return training, enrolment


def _post_tests(db, enrolment_id) -> list:
    db.expire_all()
    return db.scalars(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment_id, AssessmentObligation.assessment_type == "POST_TEST")).all()


def test_two_recoveries_at_once_create_one_assessment_not_a_server_error(world, db, client_for):
    """The first "Schedule pending assessments" is part-way through (holding the enrolment's lock, its assessment
    created but not committed). The second must wait, find that assessment and create none: no 500, no duplicate."""
    import threading
    import time

    from app.models import AuditLog

    training, enrolment = _completed_without_assessment(world, db)
    config_id = db.scalar(select(AssessmentConfig.id).where(AssessmentConfig.training_id == training.id, AssessmentConfig.assessment_type == "POST_TEST", AssessmentConfig.is_active))
    admin = client_for(world.admin)

    other = database.session_factory()()
    other.scalar(select(Enrolment).where(Enrolment.id == enrolment.id).with_for_update())
    other.add(AssessmentObligation(enrolment_id=enrolment.id, employee_id=enrolment.employee_id, training_id=training.id, config_id=config_id, assessment_type="POST_TEST", status="SCHEDULED", completed_training_at=NOW - timedelta(days=1), due_at=NOW))
    other.flush()
    created_before = db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "ASSESSMENT_OBLIGATION_CREATED"))

    outcome: dict = {}
    second = threading.Thread(target=lambda: outcome.setdefault("response", admin.post(f"/admin/trainings/{training.id}/schedule-assessments")))
    second.start()
    time.sleep(1.5)
    assert second.is_alive(), "the second recovery must wait for the enrolment lock"
    other.commit()
    other.close()
    second.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 200, response.text
    assert response.json()["data"]["scheduled"] == []
    obligations = _post_tests(db, enrolment.id)
    assert len(obligations) == 1 and obligations[0].due_at == NOW
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "ASSESSMENT_OBLIGATION_CREATED")) == created_before


def test_recovery_is_safely_repeatable(world, db, client_for):
    training, enrolment = _completed_without_assessment(world, db)
    admin = client_for(world.admin)
    first = admin.post(f"/admin/trainings/{training.id}/schedule-assessments").json()["data"]
    assert [s["employee_code"] for s in first["scheduled"]] == [world.employee.employee_code]
    created = _post_tests(db, enrolment.id)
    second = admin.post(f"/admin/trainings/{training.id}/schedule-assessments").json()["data"]
    assert second["scheduled"] == [] and second["reconfigured"] == []
    assert [o.id for o in _post_tests(db, enrolment.id)] == [o.id for o in created]  # The existing assessment is kept.
