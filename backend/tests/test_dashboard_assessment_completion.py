"""Assessment Completion Rate on the L&D Admin dashboard (27 Nov 2026).

Required post-test assessment obligations with at least one graded submission, over all required post-test
obligations (not waived, not cancelled), overall and per department. All data here is synthetic, in the disposable
test database.
"""
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select

from app.models import AssessmentAttempt, AssessmentConfig, AssessmentObligation, Enrolment
from app.modules.scheduler.jobs import finalise_expired
from tests.conftest import NOW, answer_with_score, authorise_reattempt, start, take


def dashboard(client_for, world) -> dict:
    response = client_for(world.admin).get("/admin/dashboard")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def by_department(data: dict) -> dict:
    return {d["department"]: (d["completed"], d["required"], d["rate"]) for d in data["assessment_departments"]}


def test_graded_results_count_once_and_unfinished_assessments_stay_required(world, db, client_for):
    training = world.training("T1", max_attempts=3)
    admin = client_for(world.admin)

    # Ops: Not Passed then Passed on a retake (one obligation, counted once); Not Passed only; scheduled, not started.
    e1 = client_for(world.employee)
    o1 = world.complete(world.employee, training)
    assert take(db, e1, o1.id, 3)["result_status"] == "NOT_PASSED"
    authorise_reattempt(e1, admin, o1.id)
    assert take(db, e1, o1.id, 9)["result_status"] == "PASSED"
    e2 = client_for(world.teammate)
    o2 = world.complete(world.teammate, training)
    assert take(db, e2, o2.id, 2)["result_status"] == "NOT_PASSED"
    o_scheduled = world.complete(world.manager, training)
    assert o_scheduled.status in ("SCHEDULED", "DUE")
    world.enrol(world.hr, training)  # Training not completed yet: no assessment exists, so none is required.

    # CX: submitted automatically when time ran out, with a graded result; and an attempt still in progress.
    e3 = client_for(world.outsider)
    o3 = world.complete(world.outsider, training)
    answer_with_score(db, e3, start(e3, o3.id), 8)
    assert finalise_expired(db, NOW + timedelta(minutes=20)) == 1
    db.expire_all()
    timed_out = db.scalar(select(AssessmentAttempt).where(AssessmentAttempt.obligation_id == o3.id))
    assert timed_out.status == "TIMED_OUT" and timed_out.result_status is not None
    o_running = world.complete(world.other_manager, training)
    start(client_for(world.other_manager), o_running.id)

    data = dashboard(client_for, world)
    assert data["assessment_completion"] == {"required": 5, "completed": 3, "rate": 60.0}
    assert by_department(data) == {"Ops": (2, 3, 66.7), "Cx": (1, 2, 50.0)}
    # Existing metrics are unchanged by the new ones.
    assert data["summary"]["assignments"] == 6 and data["summary"]["completed"] == 5 and data["summary"]["assessed"] == 3


def test_waived_cancelled_and_pre_tests_are_left_out_and_retraining_cycles_count_separately(world, db, client_for):
    training = world.training("T2", max_attempts=1, duration_seconds=1800)
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type="PRE_TEST", version=1, question_count=5, duration_seconds=1800, pass_mark_percent=Decimal("70"), max_attempts=1, schedule_mode="SAME_DAY", is_active=True))
    db.commit()
    admin = client_for(world.admin)

    # Waived: excluded.
    o_waived = world.complete(world.teammate, training)
    assert admin.post(f"/admin/obligations/{o_waived.id}/waive", json={"reason": "Exempt for this test"}).status_code == 200
    # Cancelled obligation: excluded.
    o_cancelled = world.complete(world.outsider, training)
    db.get(AssessmentObligation, o_cancelled.id).status = "CANCELLED"
    # Cancelled assignment: excluded with its obligation.
    world.complete(world.other_manager, training)
    db.scalar(select(Enrolment).where(Enrolment.employee_id == world.other_manager.id)).enrolment_status = "CANCELLED"
    db.commit()
    # Pre-test taken before completion: only the post-test that follows counts.
    hr = client_for(world.hr)
    hr_enrolment = world.enrol(world.hr, training)
    pre = hr.post(f"/me/pre-tests/{hr_enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert pre.status_code == 200, pre.text
    assert hr.post(f"/attempts/{pre.json()['data']['attempt_id']}/submit").status_code == 200
    assert admin.post(f"/admin/enrolments/{hr_enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()}).status_code == 200

    data = dashboard(client_for, world)
    assert data["assessment_completion"] == {"required": 1, "completed": 0, "rate": 0.0}

    # Retraining: the first cycle's graded obligation stays completed; the new cycle's is required separately.
    e1 = client_for(world.employee)
    o1 = world.complete(world.employee, training)
    assert take(db, e1, o1.id, 2)["needs_retraining"] is True
    assert admin.post(f"/admin/obligations/{o1.id}/retraining-cycle", json={"reason": "Re-training approved"}).status_code == 200
    enrolment = db.scalar(select(Enrolment).where(Enrolment.employee_id == world.employee.id))
    assert admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()}).status_code == 200
    db.expire_all()
    cycles = db.scalars(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == "POST_TEST").order_by(AssessmentObligation.training_cycle)).all()
    assert [o.training_cycle for o in cycles] == [1, 2]
    assert dashboard(client_for, world)["assessment_completion"] == {"required": 3, "completed": 1, "rate": 33.3}

    take(db, e1, cycles[1].id, 9)
    data = dashboard(client_for, world)
    assert data["assessment_completion"] == {"required": 3, "completed": 2, "rate": 66.7}
    assert by_department(data) == {"Ops": (2, 3, 66.7), "Cx": (0, 0, None)}


def test_empty_states_have_no_rate(world, db, client_for):
    data = dashboard(client_for, world)
    assert data["assessment_completion"] == {"required": 0, "completed": 0, "rate": None}
    assert data["assessment_departments"] == []

    world.enrol(world.employee, world.training("T3"))  # Assigned, not completed: nothing required yet.
    data = dashboard(client_for, world)
    assert data["assessment_completion"] == {"required": 0, "completed": 0, "rate": None}
    assert by_department(data) == {"Ops": (0, 0, None)}
