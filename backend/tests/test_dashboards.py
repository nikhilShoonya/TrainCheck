"""Dashboard programme status/counts and recency, using the disposable PostgreSQL harness."""
import uuid
from datetime import timedelta

import pytest

from app.models import Enrolment, Training
from tests.conftest import NOW


def test_admin_counts_exclude_archived_programmes_but_keep_their_history(world, db, client_for):
    active = world.training("READY", questions=1, count=1)
    draft = Training(training_code="DRAFT", title="Draft programme", status="DRAFT")
    archived = Training(training_code="ARCHIVED", title="Archived programme", status="ARCHIVED")
    db.add_all([draft, archived])
    db.commit()
    db.add(Enrolment(training_id=archived.id, employee_id=world.employee.id, assigned_at=NOW))
    db.commit()

    data = client_for(world.admin).get("/admin/dashboard").json()["data"]
    assert data["training_programmes"] == 2
    assert data["programmes_need_setup"] == 1  # The draft, not the retired programme.
    assert data["summary"]["assignments"] == 1  # Archived history remains in reporting.
    statuses = {row["id"]: row["status"] for row in data["recent_trainings"]}
    assert statuses == {str(active.id): "ACTIVE", str(draft.id): "DRAFT", str(archived.id): "ARCHIVED"}


def test_admin_recent_trainings_are_newest_created_first_with_stable_ties(world, db, client_for):
    # Deliberately oppose title order, and give two programmes the same creation time.
    for number, title, days in ((1, "AAA old", 9), (2, "ZZZ new", 1), (3, "Middle", 3), (4, "BBB tied new", 1)):
        db.add(Training(id=uuid.UUID(int=number), training_code=f"RECENT-{number}", title=title, created_at=NOW - timedelta(days=days)))
    db.commit()
    admin = client_for(world.admin)
    expected = [str(uuid.UUID(int=number)) for number in (4, 2, 3)]
    for _ in range(2):
        data = admin.get("/admin/dashboard").json()["data"]
        assert [row["id"] for row in data["recent_trainings"]] == expected


def test_employee_recent_trainings_follow_assignment_date_and_own_scope(world, db, client_for):
    enrolments = []
    for number, title, days in ((1, "AAA old", 9), (2, "ZZZ new", 1), (3, "Middle", 3), (4, "BBB tied new", 1)):
        training = world.training(f"RECENT-{number}", questions=1, count=1)
        training.title = title
        enrolment = world.enrol(world.employee, training)
        enrolment.id = uuid.UUID(int=number)
        enrolment.assigned_at = NOW - timedelta(days=days)
        enrolments.append(enrolment)
    other = world.training("OTHER", questions=1, count=1)
    world.enrol(world.outsider, other).assigned_at = NOW
    db.commit()

    employee = client_for(world.employee)
    expected = [str(enrolments[index].id) for index in (3, 1, 2)]
    for _ in range(2):
        data = employee.get("/me/dashboard").json()["data"]
        assert [row["enrolment_id"] for row in data["recent"]] == expected
        assert data["summary"]["assignments"] == 4


def test_empty_employee_dashboard_does_not_invent_learning_evidence(world, client_for):
    data = client_for(world.employee).get("/me/dashboard").json()["data"]
    assert data["summary"]["assignments"] == 0
    assert data["summary"]["assessed"] == 0
    assert data["summary"]["mean_latest_score"] is None
    assert data["overall_score"] is None
    assert data["recent"] == []


@pytest.mark.parametrize("closed", ["WAIVED", "CANCELLED", "ARCHIVED"])
def test_employee_upcoming_and_calendar_exclude_unavailable_assessments(world, db, client_for, closed):
    training = world.training("FUTURE", questions=1, count=1, schedule_mode="DELAY_DAYS", schedule_delay_days=1)
    obligation = world.complete(world.employee, training, NOW)
    admin = client_for(world.admin)
    if closed == "WAIVED":
        assert admin.post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "Synthetic dashboard regression"}).status_code == 200
    elif closed == "ARCHIVED":
        assert admin.post(f"/admin/trainings/{training.id}/status", json={"status": "ARCHIVED"}).status_code == 200
    else:
        obligation.status = closed
        db.commit()

    data = client_for(world.employee).get("/me/dashboard").json()["data"]
    assert data["upcoming"] is None
    assert [event for event in data["calendar"] if event["tag"] == "Assessment"] == []
    assert data["summary"]["completed"] == 1  # Keep the recorded training history.
    assert data["summary"]["awaiting_assessment"] == 0


def test_employee_upcoming_selects_earliest_opening_and_matches_training_list(world, db, client_for):
    for code, title, delay in (("LATER", "AAA Later assessment", 3), ("EARLIER", "ZZZ Earlier assessment", 1)):
        training = world.training(code, questions=1, count=1, schedule_mode="DELAY_DAYS", schedule_delay_days=delay)
        training.title = title
        db.commit()
        world.complete(world.employee, training, NOW)

    employee = client_for(world.employee)
    data = employee.get("/me/dashboard").json()["data"]
    cards = employee.get("/me/trainings").json()["data"]
    assert data["upcoming"]["title"] == "ZZZ Earlier assessment"
    assert data["upcoming"]["enrolment_id"] == cards[0]["enrolment_id"]
    assert [event["title"] for event in data["calendar"] if event["tag"] == "Assessment"] == ["ZZZ Earlier assessment", "AAA Later assessment"]
    assert data["summary"]["awaiting_assessment"] == 2


def test_employee_pending_count_keeps_unscheduled_completion_but_excludes_unfinished_training(world, db, client_for):
    completed = world.training("UNSCHEDULED", questions=1, count=1)
    obligation = world.complete(world.employee, completed, NOW)
    obligation.due_at = None
    unfinished = world.training("UNFINISHED", questions=1, count=1)
    world.enrol(world.employee, unfinished)
    db.commit()

    data = client_for(world.employee).get("/me/dashboard").json()["data"]
    assert data["summary"]["assignments"] == 2
    assert data["summary"]["awaiting_assessment"] == 1
    assert data["upcoming"] is None
