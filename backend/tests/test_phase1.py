"""Phase 1: core workflow reliability. Assignment, completion, completion import, gate, scoring and Level 3 switch-off."""
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.models import (
    AssessmentAttempt,
    AssessmentConfig,
    AssessmentObligation,
    AuditLog,
    BehaviourReview,
    BehaviourReviewCycle,
    Enrolment,
    Notification,
    Question,
    TrainingCompletion,
)
from app.modules.scheduler.jobs import behaviour_reminders, build_scheduler, pending_assessment_reminders
from tests.conftest import NOW, start, submit, take


def count(db, model, *where) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def assign(admin, training, *employees, **extra):
    body = {"training_id": str(training.id), "employee_ids": [str(e.id) for e in employees], **extra}
    return admin.post("/admin/enrolments", json=body)


def notices(db, kind: str) -> list[Notification]:
    db.expire_all()
    return list(db.scalars(select(Notification).where(Notification.type == kind)))


def deactivate(db, training_code: str, how_many: int) -> None:
    codes = [f"{training_code}-Q{i:02d}" for i in range(1, how_many + 1)]
    for question in db.scalars(select(Question).where(Question.question_code.in_(codes))):
        question.status = "INACTIVE"
    db.commit()


# ---------- Assignment ----------

@pytest.mark.parametrize("status", ["DRAFT", "ARCHIVED"])
def test_non_active_training_cannot_be_assigned(world, db, client_for, status):
    training = world.training()
    training.status = status
    db.commit()
    response = assign(client_for(world.admin), training, world.employee)
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "TRAINING_NOT_ACTIVE" and status.lower() in error["message"]
    assert count(db, Enrolment) == 0


def test_inactive_unknown_and_out_of_target_employees_are_reported_not_assigned(world, db, client_for):
    import uuid

    training = world.training()
    training.target_scope = "DEPARTMENT"
    training.departments = [world.departments["OPS"]]
    world.teammate.employment_status = "INACTIVE"
    db.commit()
    body = {"training_id": str(training.id), "employee_ids": [str(world.employee.id), str(world.teammate.id), str(world.outsider.id), str(uuid.uuid4())]}
    result = client_for(world.admin).post("/admin/enrolments", json=body).json()["data"]
    assert (result["created"], result["skipped_inactive"], result["skipped_out_of_target"], result["not_found"]) == (1, 1, 1, 1)
    by_status = {r["status"]: r for r in result["results"]}
    assert by_status["INACTIVE"]["employee_code"] == "E2" and "inactive" in by_status["INACTIVE"]["reason"]
    assert "outside this training's audience" in by_status["OUT_OF_TARGET"]["reason"]
    assert count(db, Enrolment) == 1


def test_bulk_audience_assignment_applies_the_same_rules(world, db, client_for):
    training = world.training()
    training.target_scope = "FUNCTION"
    training.functions = [world.functions["SALES"]]
    world.outsider.employment_status = "INACTIVE"  # Sales, but inactive.
    db.commit()
    admin = client_for(world.admin)
    first = admin.post("/admin/enrolments", json={"training_id": str(training.id), "use_training_target": True}).json()["data"]
    assert first["created"] == 1  # Only the active Sales teammate.
    assert {r["employee_code"] for r in first["results"] if r["status"] == "ASSIGNED"} == {"E2"}
    again = admin.post("/admin/enrolments", json={"training_id": str(training.id), "use_training_target": True}).json()["data"]
    assert again["created"] == 0 and again["skipped_existing"] == 1
    log = db.scalar(select(AuditLog).where(AuditLog.action == "EMPLOYEES_ASSIGNED").order_by(AuditLog.created_at))
    assert log.after_summary["assigned"] == ["E2"]


# ---------- Completion ----------

def test_present_employee_completes_and_gets_one_obligation(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    done = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date()), "attendance_status": "PRESENT"})
    assert done.status_code == 200, done.text
    data = done.json()["data"]
    assert data["attendance_status"] == "PRESENT" and data["completed_at"]
    assert data["assessment_scheduling"]["status"] == "SCHEDULED"
    assert admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())}).status_code == 409
    assert count(db, AssessmentObligation) == 1
    completion = db.scalar(select(TrainingCompletion))
    assert completion.recorded_by is not None
    actions = {a.action for a in db.scalars(select(AuditLog))}
    assert {"COMPLETION_RECORDED", "ASSESSMENT_OBLIGATION_CREATED"} <= actions
    assert len(notices(db, "ASSESSMENT_SCHEDULED")) == 1


@pytest.mark.parametrize("attendance", ["ABSENT", "EXCUSED", "PARTIAL"])
def test_absent_excused_and_partial_cannot_complete_by_default(world, db, client_for, attendance):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    assert admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": attendance}).status_code == 200
    response = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ATTENDANCE_NOT_COMPLETABLE"
    assert count(db, TrainingCompletion) == 0 and count(db, AssessmentObligation) == 0


def test_partial_completes_when_policy_allows(world, db, client_for, monkeypatch):
    monkeypatch.setattr(get_settings(), "completion_allows_partial_attendance", True)
    enrolment = world.enrol(world.employee, world.training())
    response = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date()), "attendance_status": "PARTIAL"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["attendance_status"] == "PARTIAL"


def test_invalid_attendance_value_is_rejected(world, client_for):
    enrolment = world.enrol(world.employee, world.training())
    assert client_for(world.admin).patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "MAYBE"}).status_code == 400


def test_attendance_cannot_become_absent_after_completion(world, db, client_for):
    enrolment = world.enrol(world.employee, world.training())
    admin = client_for(world.admin)
    admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())})
    response = admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "ABSENT"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ATTENDANCE_LOCKED"


@pytest.mark.parametrize("status", ["DRAFT", "ARCHIVED"])
def test_non_active_training_cannot_be_completed(world, db, client_for, status):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    training.status = status
    db.commit()
    response = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())})
    assert response.status_code == 409 and response.json()["error"]["code"] == "TRAINING_NOT_ACTIVE"


def test_missing_configuration_keeps_completion_reports_it_and_recovers(world, db, client_for):
    training = world.training()
    db.query(AssessmentConfig).filter(AssessmentConfig.training_id == training.id).update({"is_active": False})
    db.commit()
    enrolment = world.enrol(world.employee, training)
    admin = client_for(world.admin)
    data = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())}).json()["data"]
    assert data["completed_at"]  # The valid completion is kept.
    assert data["assessment_scheduling"]["status"] == "NOT_SCHEDULED"
    assert data["assessment_scheduling"]["reason"] == "NOT_CONFIGURED"
    assert data["assessment_issue"]["code"] == "NOT_SCHEDULED"
    assert count(db, AssessmentObligation) == 0
    assert len(notices(db, "ASSESSMENT_NOT_SCHEDULED")) == 1  # L&D (the admin account) is alerted.
    detail = admin.get(f"/admin/trainings/{training.id}").json()["data"]
    assert detail["pending_scheduling_count"] == 1 and detail["pending_scheduling"][0]["employee_code"] == "E1"

    # Nothing can be scheduled until the configuration is valid.
    assert admin.post(f"/admin/trainings/{training.id}/schedule-assessments").status_code == 422
    assert admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 10, "duration_minutes": 15}).status_code == 200
    fixed = admin.post(f"/admin/trainings/{training.id}/schedule-assessments").json()["data"]
    assert [s["employee_code"] for s in fixed["scheduled"]] == ["E1"]
    assert count(db, AssessmentObligation) == 1
    assert admin.post(f"/admin/trainings/{training.id}/schedule-assessments").json()["data"]["scheduled"] == []  # Idempotent.


def test_insufficient_pool_at_completion_creates_no_unusable_obligation(world, db, client_for):
    training = world.training(questions=5, count=10)  # Pool cannot satisfy the configuration.
    enrolment = world.enrol(world.employee, training)
    data = client_for(world.admin).post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())}).json()["data"]
    assert data["assessment_scheduling"]["reason"] == "QUESTION_POOL_INSUFFICIENT"
    assert count(db, AssessmentObligation) == 0
    assert client_for(world.employee).get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


# ---------- Completion import ----------

COMPLETION_HEADER = "employee,training,completion_date,attendance,source_event_id\n"


def upload(client, text):
    return client.post("/admin/imports", files={"file": ("c.csv", text.encode())}, data={"import_type": "COMPLETIONS"}).json()["data"]


def test_completion_import_follows_manual_rules(world, db, client_for):
    training = world.training()
    world.teammate.employment_status = "INACTIVE"
    cancelled = world.enrol(world.outsider, training)
    cancelled.enrolment_status = "CANCELLED"
    db.commit()
    code = training.training_code
    rows = [
        f"E1,{code},2026-11-01,PRESENT,EV-1",  # Valid: creates the assignment, because E1 is in the audience.
        f"E2,{code},2026-11-01,PRESENT,EV-2",  # Inactive employee.
        f"E3,{code},2026-11-01,PRESENT,EV-3",  # Assignment was cancelled.
        f"M1,{code},2026-11-01,ABSENT,EV-4",  # Absent cannot complete.
        f"A1,{code},2026-11-01,MAYBE,EV-5",  # Unknown attendance value.
        f"H1,{code},2026-11-01,PRESENT,EV-1",  # Source event already used in this file.
    ]
    job = upload(client_for(world.admin), COMPLETION_HEADER + "\n".join(rows) + "\n")
    assert [r["status"] for r in job["rows"]] == ["VALID", "INVALID", "INVALID", "INVALID", "INVALID", "DUPLICATE"]
    assert "inactive" in job["rows"][1]["errors"][0]["message"]
    assert "cancelled" in job["rows"][2]["errors"][0]["message"]
    assert "absent" in job["rows"][3]["errors"][0]["message"]
    assert job["assignments_created"] == 1
    done = client_for(world.admin).post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["accepted_rows"] == 1
    assert count(db, AssessmentObligation) == 1
    assert count(db, Enrolment, Enrolment.employee_id == world.outsider.id, Enrolment.enrolment_status != "CANCELLED") == 0
    assert count(db, AuditLog, AuditLog.action == "ENROLMENT_CREATED_BY_IMPORT") == 1


def test_completion_import_refuses_draft_and_out_of_audience(world, db, client_for):
    draft = world.training("DR")
    draft.status = "DRAFT"
    targeted = world.training("TG")
    targeted.target_scope = "DEPARTMENT"
    targeted.departments = [world.departments["CX"]]
    db.commit()
    job = upload(client_for(world.admin), COMPLETION_HEADER + "E1,DR,2026-11-01,,\nE1,TG,2026-11-01,,\n")
    assert [r["status"] for r in job["rows"]] == ["INVALID", "INVALID"]
    assert "draft" in job["rows"][0]["errors"][0]["message"]
    assert "audience" in job["rows"][1]["errors"][0]["message"]


def test_completion_import_without_ready_assessment_is_transparent(world, db, client_for):
    training = world.training(questions=2, count=10)
    world.enrol(world.employee, training)
    admin = client_for(world.admin)
    job = upload(admin, COMPLETION_HEADER + f"E1,{training.training_code},2026-11-01,,\n")
    assert job["rows"][0]["status"] == "VALID" and job["assessments_not_scheduled"] == 1
    done = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["rows"][0]["status"] == "IMPORTED"
    assert done["assessments_not_scheduled"] == 1
    assert count(db, TrainingCompletion) == 1 and count(db, AssessmentObligation) == 0


def test_duplicate_source_event_from_an_earlier_import_is_a_row_level_duplicate(world, db, client_for):
    training = world.training()
    admin = client_for(world.admin)
    first = upload(admin, COMPLETION_HEADER + f"E1,{training.training_code},2026-11-01,,EV-9\n")
    admin.post(f"/admin/imports/{first['id']}/commit")
    second = upload(admin, COMPLETION_HEADER + f"E2,{training.training_code},2026-11-01,,EV-9\n")
    assert second["rows"][0]["status"] == "DUPLICATE"
    assert count(db, TrainingCompletion) == 1


# ---------- Login gate ----------

def test_queue_order_and_details_for_multiple_pending(world, db, client_for):
    older = world.complete(world.employee, world.training("OLD"), NOW - timedelta(days=5))
    world.complete(world.employee, world.training("NEW", pass_mark=Decimal("80")), NOW - timedelta(days=1))
    state = client_for(world.employee).get("/me/access-state").json()["data"]
    assert state["access_status"] == "ASSESSMENT_REQUIRED"
    assert [q["training_title"] for q in state["queue"]] == ["Training OLD", "Training NEW"]
    first = state["queue"][0]
    assert first["obligation_id"] == str(older.id)
    assert (first["question_count"], first["duration_seconds"], first["pass_mark_percent"]) == (10, 900, 70.0)


def test_pool_shrink_never_locks_the_employee_out(world, db, client_for):
    training = world.training()
    obligation = world.complete(world.employee, training)
    deactivate(db, training.training_code, 3)  # 7 eligible, 10 required.

    client = client_for(world.employee)
    state = client.get("/me/access-state").json()["data"]
    assert state["access_status"] == "DASHBOARD_ALLOWED"
    assert state["unavailable"][0]["obligation_id"] == str(obligation.id)
    assert client.get("/me/dashboard").status_code == 200  # Not locked out.
    assert db.get(AssessmentObligation, obligation.id).status == "SCHEDULED"  # Kept, not discarded.
    alerts = notices(db, "ASSESSMENT_UNAVAILABLE")
    assert len(alerts) == 2  # One to L&D, one to the employee.
    client.get("/me/access-state")
    assert len(notices(db, "ASSESSMENT_UNAVAILABLE")) == 2  # Not repeated.
    admin_view = client_for(world.admin).get("/admin/enrolments").json()["data"][0]
    assert admin_view["assessment_state"] == "Unavailable" and admin_view["assessment_issue"]["code"] == "UNAVAILABLE"

    for question in db.scalars(select(Question).where(Question.status == "INACTIVE")).all():  # L&D restores the pool.
        question.status = "ACTIVE"
    db.commit()
    assert client.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"  # Blocks again once fixable.


def test_reconfiguration_moves_stuck_obligation_onto_a_valid_config(world, db, client_for):
    training = world.training()
    obligation = world.complete(world.employee, training)
    deactivate(db, training.training_code, 3)
    admin = client_for(world.admin)
    assert admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 7, "duration_minutes": 15}).status_code == 200
    moved = admin.post(f"/admin/trainings/{training.id}/schedule-assessments").json()["data"]
    assert [m["employee_code"] for m in moved["reconfigured"]] == ["E1"]
    assert db.get(AssessmentObligation, obligation.id).config.question_count == 7
    state = client_for(world.employee).get("/me/access-state").json()["data"]
    assert state["access_status"] == "ASSESSMENT_REQUIRED" and state["queue"][0]["question_count"] == 7


def test_reminders_skip_unavailable_assessments(world, db):
    training = world.training()
    world.complete(world.employee, training, NOW)
    deactivate(db, training.training_code, 1)
    pending_assessment_reminders(db, NOW)
    assert notices(db, "ASSESSMENT_DUE") == []
    assert len(notices(db, "ASSESSMENT_UNAVAILABLE")) == 2


def test_retraining_cycle_refuses_an_unready_training(world, db, client_for):
    training = world.training()
    obligation = world.complete(world.employee, training)
    obligation.retraining_flag = "NEEDS_RETRAINING"
    obligation.status = "COMPLETED"
    db.commit()
    deactivate(db, training.training_code, 1)
    response = client_for(world.admin).post(f"/admin/obligations/{obligation.id}/retraining-cycle", json={"reason": "Re-trained in person"})
    assert response.status_code == 422 and response.json()["error"]["code"] == "QUESTION_POOL_INSUFFICIENT"


# ---------- Scoring, attempts and notifications ----------

def test_attempts_first_best_and_outcome_notifications(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    first = take(db, client, obligation.id, 6)
    assert first["result_status"] == "NOT_PASSED" and first["refresher"] is not None
    assert len(notices(db, "ASSESSMENT_NOT_PASSED")) == 1
    client.post(f"/assessment-obligations/{obligation.id}/refresher-acknowledgement")
    client.post("/auth/logout")
    client = client_for(world.employee)  # A retake opens at the next sign-in.
    second = take(db, client, obligation.id, 8)
    assert second["result_status"] == "PASSED"
    assert (second["first_score"], second["best_score"]) == (60.0, 80.0)
    assert count(db, AssessmentAttempt) == 2
    assert len(notices(db, "ASSESSMENT_PASSED")) == 1


def test_duplicate_submission_returns_the_same_result(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    once = submit(client, attempt["attempt_id"])
    twice = submit(client, attempt["attempt_id"])
    assert once["score_percent"] == twice["score_percent"] and count(db, AssessmentAttempt) == 1


# ---------- Level 3 switched off ----------

def test_new_completion_creates_no_behaviour_follow_ups(world, db, client_for):
    training = world.training()
    world.template(training)
    world.complete(world.employee, training)
    assert count(db, BehaviourReviewCycle) == 0 and count(db, BehaviourReview) == 0
    assert behaviour_reminders(db, NOW + timedelta(days=40)) == 0
    assert "behaviour_reminders" not in {job.id for job in build_scheduler().get_jobs()}
    me = client_for(world.employee).get("/auth/me").json()["data"]["user"]
    assert me["features"] == {"behaviour": False}


def test_behaviour_writes_are_refused_but_history_is_readable(world, db, client_for, monkeypatch):
    training = world.training()
    world.template(training)
    monkeypatch.setattr(get_settings(), "behaviour_enabled", True)
    obligation = world.complete(world.employee, training, NOW - timedelta(days=40))  # Legacy history, created while on.
    obligation.status = "WAIVED"
    db.commit()
    review = db.scalar(select(BehaviourReview).where(BehaviourReview.reviewer_type == "SELF").order_by(BehaviourReview.id))
    monkeypatch.setattr(get_settings(), "behaviour_enabled", False)

    employee = client_for(world.employee)
    assert employee.post(f"/me/behaviour-reviews/{review.id}/submit", json={"responses": []}).json()["error"]["code"] == "BEHAVIOUR_DISABLED"
    assert employee.get("/me/behaviour-reviews").json()["data"] == []  # No open tasks while switched off.
    assert client_for(world.manager).get("/manager/behaviour-reviews").json()["data"] == []
    admin = client_for(world.admin)
    assert admin.post("/admin/behaviour-templates", json={"name": "New", "training_id": str(training.id), "questions": []}).status_code in (400, 409)
    assert admin.get(f"/scorecards/{training.id}").status_code == 200  # Reports still load.
    assert count(db, BehaviourReviewCycle) == 3  # Historical records are kept.


def test_l3_switch_off_does_not_affect_the_learning_flow(world, db, client_for):
    obligation = world.complete(world.employee, world.training())
    assert take(db, client_for(world.employee), obligation.id, 7)["result_status"] == "PASSED"


# ---------- Security ----------

def test_phase1_admin_actions_are_ld_only(world, db, client_for):
    training = world.training()
    for person in (world.employee, world.manager, world.hr):
        client = client_for(person)
        assert client.post(f"/admin/trainings/{training.id}/schedule-assessments").status_code == 403
        assert client.post("/admin/enrolments", json={"training_id": str(training.id), "employee_ids": [str(world.employee.id)]}).status_code == 403
