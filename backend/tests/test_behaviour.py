"""Level 3 Behaviour. TC-KIR-005 to -007, TC-L3-*."""
from datetime import timedelta

from sqlalchemy import func, select

from app.core import clock
from app.models import BehaviourReview, BehaviourReviewCycle, BehaviourTemplate, Notification
from app.modules.scheduler.jobs import behaviour_reminders
from tests.conftest import NOW


def cleared_training(world, employee, db, days_ago=40):
    """A completed training with the post-test waived, so behaviour is the only thing under test."""
    training = world.training()
    world.template(training)
    obligation = world.complete(employee, training, NOW - timedelta(days=days_ago))
    obligation.status = "WAIVED"
    db.commit()
    return training


def form_body(form: dict, rating: int = 4, example: str = "Handled a real case using the approved steps.") -> dict:
    return {"responses": [{"template_question_id": q["template_question_id"], "rating": rating, "example_text": example} for q in form["questions"]]}


def test_completion_creates_30_60_90_cycles_with_both_reviews(world, db):  # TC-L3-001
    cleared_training(world, world.employee, db)
    cycles = db.scalars(select(BehaviourReviewCycle).order_by(BehaviourReviewCycle.period_days)).all()
    assert [c.period_days for c in cycles] == [30, 60, 90]
    assert db.scalar(select(func.count()).select_from(BehaviourReview)) == 6
    assert cycles[0].due_at - (NOW - timedelta(days=40)) == timedelta(days=30)


def test_no_template_means_no_cycles_and_not_configured(world, db, client_for):  # TC-L3-002
    training = world.training()
    obligation = world.complete(world.employee, training)
    obligation.status = "WAIVED"
    db.commit()
    assert db.scalar(select(func.count()).select_from(BehaviourReviewCycle)) == 0
    card = client_for(world.admin).get(f"/scorecards/{training.id}").json()["data"]
    assert card["behaviour"]["state"] == "Not configured"


def test_function_template_wins_over_generic(world, db):  # TC-L3-003
    training = world.training()
    world.template(training, name="Generic")
    specific = world.template(training, world.functions["COMPLIANCE"], name="Compliance")
    world.template(None, world.functions["SALES"], name="Sales wide")
    world.complete(world.employee, training)  # The employee is in Compliance.
    world.complete(world.teammate, training)  # The teammate is in Sales.
    employee_cycle = db.scalar(select(BehaviourReviewCycle).where(BehaviourReviewCycle.employee_id == world.employee.id))
    teammate_cycle = db.scalar(select(BehaviourReviewCycle).where(BehaviourReviewCycle.employee_id == world.teammate.id))
    assert employee_cycle.template_id == specific.id
    # Same training with no function beats a function-wide template.
    assert db.get(BehaviourTemplate, teammate_cycle.template_id).name == "Generic"


def test_self_assessment_flow(world, db, client_for):
    cleared_training(world, world.employee, db)
    client = client_for(world.employee)
    tasks = client.get("/me/behaviour-reviews").json()["data"]
    assert [t["status"] for t in tasks] == ["OVERDUE", "NOT_DUE", "NOT_DUE"]
    form = client.get(f"/me/behaviour-reviews/{tasks[0]['review_id']}").json()["data"]
    response = client.post(f"/me/behaviour-reviews/{tasks[0]['review_id']}/submit", json=form_body(form))
    assert response.status_code == 200, response.text
    assert client.get("/me/behaviour-reviews").json()["data"][0]["status"] == "SUBMITTED"
    again = client.post(f"/me/behaviour-reviews/{tasks[0]['review_id']}/submit", json=form_body(form))
    assert again.status_code == 409


def test_not_due_review_is_refused(world, db, client_for):
    cleared_training(world, world.employee, db)
    client = client_for(world.employee)
    task = client.get("/me/behaviour-reviews").json()["data"][1]
    form = client.get(f"/me/behaviour-reviews/{task['review_id']}").json()["data"]
    response = client.post(f"/me/behaviour-reviews/{task['review_id']}/submit", json=form_body(form))
    assert response.json()["error"]["code"] == "REVIEW_NOT_DUE"


def test_rating_range_and_required_example(world, db, client_for):  # TC-L3-004
    cleared_training(world, world.employee, db)
    client = client_for(world.employee)
    task = client.get("/me/behaviour-reviews").json()["data"][0]
    form = client.get(f"/me/behaviour-reviews/{task['review_id']}").json()["data"]
    url = f"/me/behaviour-reviews/{task['review_id']}/submit"
    assert client.post(url, json=form_body(form, rating=6)).status_code == 400
    assert client.post(url, json=form_body(form, rating=0)).status_code == 400
    assert client.post(url, json=form_body(form, example="short")).status_code == 400
    assert client.post(url, json={"responses": []}).status_code == 400


def test_database_enforces_rating_range(world, db):  # DB design §6
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import BehaviourReviewResponse

    cleared_training(world, world.employee, db)
    review = db.scalar(select(BehaviourReview))
    question = review.cycle.template.questions[0]
    db.add(BehaviourReviewResponse(review_id=review.id, template_question_id=question.id, competency_id=question.competency_id, rating=6))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_manager_observes_only_own_team(world, db, client_for):  # TC-KIR-006, TC-L3-005
    cleared_training(world, world.employee, db)
    manager = client_for(world.manager)
    tasks = manager.get("/manager/behaviour-reviews").json()["data"]
    assert {t["employee_code"] for t in tasks} == {"E1"}
    other = client_for(world.other_manager)
    assert other.get("/manager/behaviour-reviews").json()["data"] == []
    assert other.get(f"/manager/behaviour-reviews/{tasks[0]['review_id']}").status_code == 404
    assert other.post(f"/manager/behaviour-reviews/{tasks[0]['review_id']}/submit", json={"responses": []}).status_code == 404
    # An employee cannot use the manager route or open a manager's form.
    employee = client_for(world.employee)
    assert employee.get("/manager/behaviour-reviews").status_code == 403
    assert employee.get(f"/me/behaviour-reviews/{tasks[0]['review_id']}").status_code == 404


def test_self_and_manager_are_compared_on_the_same_competency_and_period(world, db, client_for):  # TC-L3-006, TC-REP-009
    training = cleared_training(world, world.employee, db)
    employee, manager = client_for(world.employee), client_for(world.manager)

    self_task = employee.get("/me/behaviour-reviews").json()["data"][0]
    form = employee.get(f"/me/behaviour-reviews/{self_task['review_id']}").json()["data"]
    employee.post(f"/me/behaviour-reviews/{self_task['review_id']}/submit", json=form_body(form, rating=5))

    report = client_for(world.hr).get(f"/reports/behaviour?training_id={training.id}").json()["data"]
    columns = report["columns"]
    row = next(r for r in report["rows"] if r[columns.index("Period (days)")] == 30)
    assert row[columns.index("Self /5")] == 5
    assert row[columns.index("Manager /5")] == "Not collected"  # Missing stays missing.
    assert row[columns.index("Gap (manager − self)")] == "Not comparable"

    manager_task = next(t for t in manager.get("/manager/behaviour-reviews").json()["data"] if t["period_days"] == 30)
    form = manager.get(f"/manager/behaviour-reviews/{manager_task['review_id']}").json()["data"]
    assert form["self_assessment"] is None  # Self-ratings cannot anchor the observation.
    assert manager.post(f"/manager/behaviour-reviews/{manager_task['review_id']}/submit", json=form_body(form, rating=3)).status_code == 200

    report = client_for(world.hr).get(f"/reports/behaviour?training_id={training.id}").json()["data"]
    row = next(r for r in report["rows"] if r[columns.index("Period (days)")] == 30)
    assert row[columns.index("Manager /5")] == 3
    assert row[columns.index("Gap (manager − self)")] == -2
    other_period = next(r for r in report["rows"] if r[columns.index("Period (days)")] == 60)
    assert other_period[columns.index("Gap (manager − self)")] == "Not comparable"


def test_reminders_are_not_duplicated(world, db):  # TC-KIR-007, BR §16.5
    cleared_training(world, world.employee, db)
    behaviour_reminders(db, NOW)
    count = db.scalar(select(func.count()).select_from(Notification).where(Notification.type == "BEHAVIOUR_REVIEW"))
    assert count == 2  # One for the employee and one for the manager.
    behaviour_reminders(db, NOW)
    assert db.scalar(select(func.count()).select_from(Notification).where(Notification.type == "BEHAVIOUR_REVIEW")) == 2


def test_cycle_due_date_arrives_with_time(world, db, client_for):
    cleared_training(world, world.employee, db)
    clock.freeze(NOW + timedelta(days=21))
    tasks = client_for(world.employee).get("/me/behaviour-reviews").json()["data"]
    assert tasks[1]["status"] in ("PENDING", "OVERDUE")


def test_template_edit_creates_version_and_keeps_existing_cycles(world, db, client_for):
    training = cleared_training(world, world.employee, db)
    admin = client_for(world.admin)
    template = admin.get("/admin/behaviour-templates").json()["data"][0]
    body = {"name": "Revised", "training_id": str(training.id), "questions": [{"competency_id": str(world.competency.id), "prompt": "A revised behavioural question?"}]}
    updated = admin.patch(f"/admin/behaviour-templates/{template['id']}", json=body).json()["data"]
    assert updated["version"] == 2 and updated["code"] == template["code"]
    cycle = db.scalar(select(BehaviourReviewCycle))
    db.expire_all()
    assert str(cycle.template_id) == template["id"]
    assert cycle.template.name != "Revised"


def test_hr_cannot_change_templates(world, client_for, db):
    training = cleared_training(world, world.employee, db)
    body = {"name": "Nope", "training_id": str(training.id), "questions": [{"competency_id": str(world.competency.id), "prompt": "Should not save?"}]}
    assert client_for(world.hr).post("/admin/behaviour-templates", json=body).status_code == 403
