"""Feedback after a post-training assessment: asked once per assessment, own attempts only, visible to L&D Admin."""
import uuid

from sqlalchemy import func, select

from app.models import AssessmentFeedback
from tests.conftest import FEEDBACK, authorise_reattempt, start, take

GOOD = {"ratings": {**FEEDBACK["ratings"], "satisfaction": 5}, "comment": "  Useful session.  "}


def test_feedback_is_required_after_a_post_test_and_saved_once(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt_id = take(db, client, obligation.id, 8)["attempt_id"]

    before = client.get(f"/attempts/{attempt_id}/feedback").json()["data"]
    assert before["required"] is True and before["submitted"] is None
    assert [q["key"] for q in before["questions"]] == list(FEEDBACK["ratings"])
    assert len(before["questions"]) == 10
    assert len({q["section"] for q in before["questions"]}) == 6  # Comments make section seven.
    assert before["questions"][0]["stars"] is True
    assert [o["label"] for o in before["questions"][1]["options"]] == ["Very Poor", "Poor", "Neutral", "Good", "Excellent"]
    trainer_questions = [q for q in before["questions"] if q["section"] == "Trainer Expertise & Preparation"]
    assert len(trainer_questions) == 1
    assert trainer_questions[0]["text"] == "The session was well-prepared and organized."
    assert before["questions"][6]["options"] == [{"value": 2, "label": "Fair"}, {"value": 4, "label": "Very good"}, {"value": 5, "label": "Exceptional"}, {"value": 3, "label": "Average"}, {"value": 1, "label": "Below average"}]

    response = client.post(f"/attempts/{attempt_id}/feedback", json=GOOD)
    assert response.status_code == 200, response.text
    after = response.json()["data"]
    assert after["required"] is False
    assert after["submitted"]["ratings"] == GOOD["ratings"]
    assert after["submitted"]["comment"] == "Useful session."

    again = client.post(f"/attempts/{attempt_id}/feedback", json=GOOD)
    assert again.status_code == 409 and again.json()["error"]["code"] == "FEEDBACK_ALREADY_SUBMITTED"
    assert db.scalar(select(func.count()).select_from(AssessmentFeedback)) == 1


def test_retake_does_not_ask_again(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    email = world.employee.work_email
    client = client_for(email)
    first = take(db, client, obligation.id, 5)
    assert client.post(f"/attempts/{first['attempt_id']}/feedback", json=GOOD).status_code == 200
    authorise_reattempt(client, client_for(world.admin), obligation.id)
    second = take(db, client, obligation.id, 8)
    assert client.get(f"/attempts/{second['attempt_id']}/feedback").json()["data"]["required"] is False


def test_feedback_validation_and_ownership(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    running = start(client, obligation.id)
    assert client.post(f"/attempts/{running['attempt_id']}/feedback", json=GOOD).json()["error"]["code"] == "RESULT_NOT_READY"
    assert client.get(f"/attempts/{running['attempt_id']}/feedback").json()["data"]["required"] is False

    done = take(db, client, obligation.id, 8)
    for bad in ({"ratings": {**GOOD["ratings"], "objectives": 6}}, {"ratings": {**GOOD["ratings"], "logistics": 0}}, {"ratings": {"satisfaction": 5}}, {**GOOD, "comment": "x" * 2001}, {"ratings": {**GOOD["ratings"], "pace": True}}, {"ratings": {**GOOD["ratings"], "extra": 4}}, {"ratings": {key: 4 for key in ("relevance", "clarity", "alignment", "fairness", "confidence")}}):
        assert client.post(f"/attempts/{done['attempt_id']}/feedback", json=bad).status_code == 400, bad
    # Another employee cannot read or answer someone else's attempt.
    other = client_for(world.teammate)
    assert other.get(f"/attempts/{done['attempt_id']}/feedback").status_code == 404
    assert other.post(f"/attempts/{done['attempt_id']}/feedback", json=GOOD).status_code == 404


def test_admin_sees_feedback_and_employee_cannot(world, client_for, db):
    training = world.training()
    for employee, ratings in ((world.employee, GOOD["ratings"]), (world.teammate, {**FEEDBACK["ratings"], "satisfaction": 3})):
        obligation = world.complete(employee, training)
        client = client_for(employee)
        attempt_id = take(db, client, obligation.id, 8)["attempt_id"]
        assert client.post(f"/attempts/{attempt_id}/feedback", json={"ratings": ratings}).status_code == 200

    assert client_for(world.employee).get("/admin/feedback").status_code == 403
    data = client_for(world.admin).get("/admin/feedback").json()["data"]
    assert data["summary"]["responses"] == 2 and data["summary"]["trainings"] == 1
    assert data["summary"]["averages"] == {key: 4.0 for key in FEEDBACK["ratings"]}
    assert data["summary"]["overall"] == 4.0
    assert data["trainings"][0]["training_title"] == training.title and data["trainings"][0]["responses"] == 2
    assert {r["employee_code"] for r in data["responses"]} == {world.employee.employee_code, world.teammate.employee_code}
    assert all(r["score_percent"] == 80.0 and r["result_status"] == "PASSED" for r in data["responses"])
    filtered = client_for(world.admin).get(f"/admin/feedback?training_id={world.training('T2').id}").json()["data"]
    assert filtered["summary"]["responses"] == 0


def test_historical_feedback_remains_readable_and_is_not_relabelled(world, client_for, db):
    from app.core.clock import utcnow
    from app.modules.feedback.questionnaire import LEGACY_COLUMNS

    training = world.training()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt_id = take(db, client, obligation.id, 8)["attempt_id"]
    db.add(AssessmentFeedback(obligation_id=obligation.id, attempt_id=uuid.UUID(attempt_id), employee_id=world.employee.id, training_id=training.id, submitted_at=utcnow(), **{column: 3 for column in LEGACY_COLUMNS.values()}))
    db.commit()
    old = client.get(f"/attempts/{attempt_id}/feedback").json()["data"]
    assert old["required"] is False
    assert old["submitted"]["ratings"] == {key: 3 for key in LEGACY_COLUMNS}
    assert [q["key"] for q in old["questions"]] == list(LEGACY_COLUMNS)
    teammate = client_for(world.teammate)
    new_attempt = take(db, teammate, world.complete(world.teammate, training).id, 8)["attempt_id"]
    assert teammate.post(f"/attempts/{new_attempt}/feedback", json=GOOD).status_code == 200
    admin = client_for(world.admin)
    report = admin.get("/admin/feedback").json()["data"]
    assert report["summary"]["responses"] == 2
    assert report["summary"]["averages"]["satisfaction"] == 5.0
    assert report["summary"]["averages"]["alignment"] == 3.0
    assert len(report["questions"]) == 15
    assert admin.get(f"/reports/employees/{world.employee.id}/scorecard/pdf").status_code == 200


def test_previous_eleven_question_responses_are_preserved(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt_id = take(db, client, obligation.id, 8)["attempt_id"]
    assert client.post(f"/attempts/{attempt_id}/feedback", json=GOOD).status_code == 200
    feedback = db.scalar(select(AssessmentFeedback).where(AssessmentFeedback.obligation_id == obligation.id))
    # Represents a response already saved by the earlier 11-question form.
    feedback.training_ratings = {**feedback.training_ratings, "trainer_organisation": 2}
    db.commit()
    saved = client.get(f"/attempts/{attempt_id}/feedback").json()["data"]
    assert saved["required"] is False
    assert saved["submitted"]["ratings"]["trainer_organisation"] == 2
    assert len(saved["questions"]) == 11
    admin = client_for(world.admin)
    report = admin.get("/admin/feedback").json()["data"]
    assert report["summary"]["averages"]["trainer_organisation"] == 2
    assert any(q["key"] == "trainer_organisation" and "previous duplicate" in q["short_label"] for q in report["questions"])
    scorecard = admin.get(f"/reports/employees/{world.employee.id}/scorecard").json()["data"]
    assert scorecard["feedback"][0]["ratings"]["trainer_organisation"] == 2
    assert admin.get(f"/reports/employees/{world.employee.id}/scorecard/pdf").status_code == 200


# ---------- Feedback cutoff (decision of 19 Nov 2026) ----------

def test_assessments_before_the_feedback_cutoff_are_not_asked(world, client_for, db, monkeypatch):
    """Feedback became required on 14 Nov 2026. Results from before then must not block anyone."""
    from datetime import timedelta

    from app.core import clock
    from app.core.config import get_settings
    from tests.conftest import NOW

    monkeypatch.setattr(get_settings(), "feedback_required_from", "2026-11-14")
    old = world.complete(world.employee, world.training("TOLD"), NOW - timedelta(days=2))
    client = client_for(world.employee)
    before = take(db, client, old.id, 8)  # Submitted 4 Nov 2026, before the cutoff.
    assert before["access_state"]["access_status"] == "DASHBOARD_ALLOWED"
    assert client.get(f"/attempts/{before['attempt_id']}/feedback").json()["data"]["required"] is False
    assert client.get("/me/dashboard").status_code == 200

    later = NOW + timedelta(days=16)  # 20 Nov 2026, after the cutoff.
    clock.freeze(later)
    new = world.complete(world.teammate, world.training("TNEW"), later - timedelta(hours=1))
    teammate = client_for(world.teammate)
    after = take(db, teammate, new.id, 8)
    assert after["access_state"]["access_status"] == "FEEDBACK_REQUIRED"
    assert teammate.get(f"/attempts/{after['attempt_id']}/feedback").json()["data"]["required"] is True


def test_empty_cutoff_means_always_required(world, client_for, db, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "feedback_required_from", "")
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    assert take(db, client, obligation.id, 8)["access_state"]["access_status"] == "FEEDBACK_REQUIRED"


def test_oldest_owed_feedback_is_asked_first(world, client_for, db):
    from datetime import timedelta

    from app.core import clock
    from tests.conftest import NOW

    first_obligation = world.complete(world.employee, world.training("TA"), NOW - timedelta(days=3))
    second_obligation = world.complete(world.employee, world.training("TB"), NOW - timedelta(days=2))
    client = client_for(world.employee)
    first = take(db, client, first_obligation.id, 8)
    clock.freeze(NOW + timedelta(minutes=30))
    second = take(db, client, second_obligation.id, 8)
    assert second["access_state"]["feedback_due"]["attempt_id"] == first["attempt_id"]


def test_feedback_audit_names_the_feedback(world, client_for, db):
    from app.models import AuditLog

    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt_id = take(db, client, obligation.id, 8)["attempt_id"]
    saved = client.post(f"/attempts/{attempt_id}/feedback", json=GOOD)
    assert saved.status_code == 200
    feedback_id = db.scalar(select(AssessmentFeedback.id))
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "ASSESSMENT_FEEDBACK_SUBMITTED"))
    assert audit.target_id == str(feedback_id)
