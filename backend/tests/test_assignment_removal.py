"""Removing employees assigned to a training by mistake (27 Nov 2026), even after completion was recorded.

The chosen assignments go with their completions, assessments, attempts, feedback and notifications; the employees,
other assignments of the training and other trainings stay. All data here is synthetic, in the disposable test database.
"""
from sqlalchemy import func, select

from app.models import (
    AssessmentAttempt,
    AssessmentFeedback,
    AssessmentObligation,
    AttemptAnswer,
    AttemptQuestion,
    AuditLog,
    Employee,
    Enrolment,
    Notification,
    Training,
    TrainingCompletion,
)
from tests.conftest import give_feedback, start, take

REASON = {"reason": "Assigned to this training by mistake"}


def count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def enrolment_of(db, employee: Employee, training: Training) -> Enrolment:
    return db.scalar(select(Enrolment).where(Enrolment.employee_id == employee.id, Enrolment.training_id == training.id))


def remove(admin, training: Training, *enrolments: Enrolment, body: dict | None = None):
    return admin.post(f"/admin/trainings/{training.id}/assignments/remove", json={**REASON, "enrolment_ids": [str(e.id) for e in enrolments], **(body or {})})


def test_completed_assignments_are_removed_with_their_records_and_everything_else_stays(world, db, client_for):
    t1, t2 = world.training("T1"), world.training("T2")
    admin = client_for(world.admin)
    e1, e2 = client_for(world.employee), client_for(world.teammate)

    # Employee: completed, tested and gave feedback. Teammate: completed, test scheduled and blocking the workspace.
    # Outsider: stays in T1. Employee's T2 history must survive.
    o1 = world.complete(world.employee, t1)
    give_feedback(e1, take(db, e1, o1.id, 9)["attempt_id"])
    world.complete(world.teammate, t1)
    assert e2.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"
    kept_o = world.complete(world.outsider, t1)
    o_t2 = world.complete(world.employee, t2)
    give_feedback(e1, take(db, e1, o_t2.id, 9)["attempt_id"])

    mine, teammate, outsider = (enrolment_of(db, p, t1) for p in (world.employee, world.teammate, world.outsider))
    removed_ids = {str(i) for i in [mine.id, teammate.id, *db.scalars(select(AssessmentObligation.id).where(AssessmentObligation.enrolment_id.in_([mine.id, teammate.id])))]}
    attempts = list(db.scalars(select(AssessmentAttempt.id).where(AssessmentAttempt.obligation_id == o1.id)))
    snapshots = list(db.scalars(select(AttemptQuestion.id).where(AttemptQuestion.attempt_id.in_(attempts))))
    assert attempts and snapshots
    employees = count(db, Employee)
    t2_rows = {m: count(db, m, m.training_id == t2.id) for m in (Enrolment, AssessmentObligation, AssessmentAttempt, AssessmentFeedback)}

    response = remove(admin, t1, mine, teammate)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"removed": 2, "completions": 2, "assessments": 2, "attempts": 1, "notifications": response.json()["data"]["notifications"]}

    db.expunge_all()
    assert count(db, Enrolment, Enrolment.id.in_([mine.id, teammate.id])) == 0
    assert count(db, TrainingCompletion, TrainingCompletion.enrolment_id.in_([mine.id, teammate.id])) == 0
    assert count(db, AssessmentObligation, AssessmentObligation.enrolment_id.in_([mine.id, teammate.id])) == 0
    assert count(db, AssessmentAttempt, AssessmentAttempt.id.in_(attempts)) == 0
    assert count(db, AttemptQuestion, AttemptQuestion.id.in_(snapshots)) == 0
    assert count(db, AttemptAnswer, AttemptAnswer.attempt_question_id.in_(snapshots)) == 0
    assert count(db, AssessmentFeedback, AssessmentFeedback.obligation_id == o1.id) == 0
    notes = db.execute(select(Notification.link, Notification.dedupe_key)).all()
    assert not [n for n in notes if any(i in f"{n.link} {n.dedupe_key}" for i in removed_ids)]

    # Kept: the people, the third assignment, T2.
    assert count(db, Employee) == employees
    assert count(db, Enrolment, Enrolment.id == outsider.id) == 1 and count(db, AssessmentObligation, AssessmentObligation.id == kept_o.id) == 1
    assert {m: count(db, m, m.training_id == t2.id) for m in t2_rows} == t2_rows

    # One audit record per removed assignment, with who it was, what it held and the reason.
    logs = {log.target_id: log for log in db.scalars(select(AuditLog).where(AuditLog.action == "TRAINING_ASSIGNMENT_REMOVED"))}
    assert set(logs) == {str(mine.id), str(teammate.id)}
    mine_log = logs[str(mine.id)]
    assert mine_log.reason == REASON["reason"]
    assert {k: mine_log.before_summary[k] for k in ("training_code", "employee_code", "completions", "attempts", "feedback")} == {
        "training_code": "T1", "employee_code": world.employee.employee_code, "completions": 1, "attempts": 1, "feedback": 1,
    }

    # The teammate's workspace is no longer blocked; the training is gone from their list. The list shows only the outsider.
    assert e2.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    assert all(card["training_id"] != str(t1.id) for card in e2.get("/me/trainings").json()["data"])
    listed = admin.get(f"/admin/enrolments?training_id={t1.id}").json()["data"]
    assert [row["id"] for row in listed] == [str(outsider.id)]

    # They can be assigned again later, if that is ever wanted.
    assert world.enrol(world.teammate, t1).id != teammate.id


def test_removal_is_all_or_nothing_and_admin_only(world, db, client_for):
    t1, t2 = world.training("T1"), world.training("T2")
    admin = client_for(world.admin)
    world.complete(world.employee, t1)
    world.complete(world.teammate, t2)
    mine, other_training = enrolment_of(db, world.employee, t1), enrolment_of(db, world.teammate, t2)

    # An assignment of another training: 404, and the valid one is not removed either.
    response = remove(admin, t1, mine, other_training)
    assert response.status_code == 404 and "nothing was removed" in response.json()["error"]["message"]
    assert count(db, Enrolment, Enrolment.id.in_([mine.id, other_training.id])) == 2

    # A reason and at least one employee are required.
    assert remove(admin, t1, mine, body={"reason": ""}).status_code == 400
    assert admin.post(f"/admin/trainings/{t1.id}/assignments/remove", json={**REASON, "enrolment_ids": []}).status_code == 400
    # Not an admin: refused.
    assert remove(client_for(world.employee), t1, mine).status_code == 403
    assert count(db, Enrolment, Enrolment.id == mine.id) == 1
    assert count(db, AuditLog, AuditLog.action == "TRAINING_ASSIGNMENT_REMOVED") == 0


def test_an_assignment_with_a_test_in_progress_is_not_removed(world, db, client_for):
    t1 = world.training("T1")
    admin = client_for(world.admin)
    o1 = world.complete(world.employee, t1)
    start(client_for(world.employee), o1.id)
    mine = enrolment_of(db, world.employee, t1)

    response = remove(admin, t1, mine)
    assert response.status_code == 409 and response.json()["error"]["code"] == "ATTEMPT_IN_PROGRESS"
    db.expunge_all()
    assert count(db, Enrolment, Enrolment.id == mine.id) == 1
    assert count(db, AssessmentAttempt, AssessmentAttempt.obligation_id == o1.id) == 1
