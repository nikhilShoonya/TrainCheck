"""L&D actions that race another request (a double click, two admins, or the employee starting meanwhile).

Each test lets the handler read the record, then lets "another request" change it and commit before the handler
writes, exactly the window a row lock closes. The outcome must be a clear 409, never a 500 or a lost update.
"""
from datetime import timedelta

from sqlalchemy import select

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
    assert client.post(f"/assessment-obligations/{obligation.id}/refresher-acknowledgement").status_code == 200

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

    def other_admin_opens_cycle(other):
        row = other.get(AssessmentObligation, obligation.id)
        row.retraining_flag = "RESOLVED"
        other.add(AssessmentObligation(enrolment_id=row.enrolment_id, employee_id=row.employee_id, training_id=row.training_id, config_id=row.config_id, assessment_type="POST_TEST", cycle_number=row.cycle_number + 1, status="DUE", completed_training_at=NOW, due_at=NOW))

    meanwhile(monkeypatch, "_obligation", other_admin_opens_cycle)
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-trained in person"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "NOT_FLAGGED"
    assert len(db.scalars(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == obligation.enrolment_id)).all()) == 2


def _other_admin_completes(enrolment_id):
    def change(other):
        other.add(TrainingCompletion(enrolment_id=enrolment_id, completed_at=NOW, completion_source="MANUAL"))
        other.get(Enrolment, enrolment_id).enrolment_status = "COMPLETED"

    return change


def test_double_completion_is_a_conflict_not_a_server_error(world, db, client_for, monkeypatch):
    enrolment = world.enrol(world.employee, world.training())
    real = training_service.completion_problem
    change = _other_admin_completes(enrolment.id)

    def checked_then_raced(record, attendance=None):
        problem = real(record, attendance)  # This request sees no completion yet...
        other = database.session_factory()()
        change(other)  # ...and the other request records one before this one inserts.
        other.commit()
        other.close()
        return problem

    monkeypatch.setattr(training_service, "completion_problem", checked_then_raced)
    response = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()})
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
