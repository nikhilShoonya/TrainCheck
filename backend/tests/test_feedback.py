"""Feedback after a post-training assessment: asked once per assessment, own attempts only, visible to L&D Admin."""
from sqlalchemy import func, select

from app.models import AssessmentFeedback
from tests.conftest import refresher_then_approval, start, take

GOOD = {"ratings": {"relevance": 5, "clarity": 4, "alignment": 4, "fairness": 3, "confidence": 5}, "comment": "  Useful session.  "}


def test_feedback_is_required_after_a_post_test_and_saved_once(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt_id = take(db, client, obligation.id, 8)["attempt_id"]

    before = client.get(f"/attempts/{attempt_id}/feedback").json()["data"]
    assert before["required"] is True and before["submitted"] is None
    assert [q["key"] for q in before["questions"]] == ["relevance", "clarity", "alignment", "fairness", "confidence"]

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
    refresher_then_approval(client, client_for(world.admin), obligation.id)
    second = take(db, client, obligation.id, 8)
    assert client.get(f"/attempts/{second['attempt_id']}/feedback").json()["data"]["required"] is False


def test_feedback_validation_and_ownership(world, client_for, db):
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    running = start(client, obligation.id)
    assert client.post(f"/attempts/{running['attempt_id']}/feedback", json=GOOD).json()["error"]["code"] == "RESULT_NOT_READY"
    assert client.get(f"/attempts/{running['attempt_id']}/feedback").json()["data"]["required"] is False

    done = take(db, client, obligation.id, 8)
    for bad in ({"ratings": {**GOOD["ratings"], "clarity": 6}}, {"ratings": {**GOOD["ratings"], "fairness": 0}}, {"ratings": {"relevance": 5}}, {**GOOD, "comment": "x" * 2001}):
        assert client.post(f"/attempts/{done['attempt_id']}/feedback", json=bad).status_code == 400, bad
    # Another employee cannot read or answer someone else's attempt.
    other = client_for(world.teammate)
    assert other.get(f"/attempts/{done['attempt_id']}/feedback").status_code == 404
    assert other.post(f"/attempts/{done['attempt_id']}/feedback", json=GOOD).status_code == 404


def test_admin_sees_feedback_and_employee_cannot(world, client_for, db):
    training = world.training()
    for employee, ratings in ((world.employee, GOOD["ratings"]), (world.teammate, {"relevance": 3, "clarity": 2, "alignment": 4, "fairness": 5, "confidence": 1})):
        obligation = world.complete(employee, training)
        client = client_for(employee)
        attempt_id = take(db, client, obligation.id, 8)["attempt_id"]
        assert client.post(f"/attempts/{attempt_id}/feedback", json={"ratings": ratings}).status_code == 200

    assert client_for(world.employee).get("/admin/feedback").status_code == 403
    data = client_for(world.admin).get("/admin/feedback").json()["data"]
    assert data["summary"]["responses"] == 2 and data["summary"]["trainings"] == 1
    assert data["summary"]["averages"] == {"relevance": 4.0, "clarity": 3.0, "alignment": 4.0, "fairness": 4.0, "confidence": 3.0}
    assert data["trainings"][0]["training_title"] == training.title and data["trainings"][0]["responses"] == 2
    assert {r["employee_code"] for r in data["responses"]} == {world.employee.employee_code, world.teammate.employee_code}
    assert all(r["score_percent"] == 80.0 and r["result_status"] == "PASSED" for r in data["responses"])
    filtered = client_for(world.admin).get(f"/admin/feedback?training_id={world.training('T2').id}").json()["data"]
    assert filtered["summary"]["responses"] == 0


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
