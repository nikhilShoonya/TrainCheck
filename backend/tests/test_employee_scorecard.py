"""Employee Scorecard (Reports & Analytics → employee row): one employee's complete, filtered learning record.

Covers: L&D Admin only, by stable employee ID; no other employee's data; Highest Score is the best submitted post-test
score across every retained attempt and training cycle (never the latest, never a pre-test); missing scores stay
missing; summary counts per assignment, not per attempt; learning gain pairs the pre-test with the FIRST post-test;
filters apply to every section and to the PDF, which holds every matching record.
"""
import io
from datetime import timedelta
from decimal import Decimal

import pytest
from pypdf import PdfReader
from sqlalchemy import select

from app.core import clock
from app.core.config import get_settings
from app.models import AssessmentConfig, AuditLog, Employee, Enrolment
from tests.conftest import NOW, answer_with_score, authorise_reattempt, give_feedback, submit, take


def card(client, employee: Employee, **params) -> dict:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    response = client.get(f"/reports/employees/{employee.id}/scorecard" + (f"?{query}" if query else ""))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def by_training(items: list[dict]) -> dict[str, dict]:
    return {i["training"]: i for i in items}


def tick(minutes: int) -> None:
    """Moves the frozen clock on, so each submission has its own time (newest-first ordering is then observable)."""
    clock.freeze(NOW + timedelta(minutes=minutes))


def fail_three_times_then_retrain(world, db, admin, client, training) -> Enrolment:
    """Cycle 1: 50%, 60%, 40% (three failures). Re-training, then cycle 2 attempt 1: 30%."""
    enrolment = world.enrol(world.employee, training)
    completed = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()})
    assert completed.status_code == 200, completed.text
    obligation_id = completed.json()["data"]["obligation_id"]
    tick(1)
    give_feedback(client, take(db, client, obligation_id, 5)["attempt_id"])
    for minute, correct in ((2, 6), (3, 4)):
        authorise_reattempt(client, admin, obligation_id)
        tick(minute)
        take(db, client, obligation_id, correct)
    retrain = admin.post(f"/admin/obligations/{obligation_id}/retraining-cycle", json={"reason": "Re-training approved"})
    assert retrain.status_code == 200, retrain.text
    again = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()})
    assert again.status_code == 200, again.text
    tick(4)
    take(db, client, again.json()["data"]["obligation_id"], 3)  # Cycle 2: no feedback yet.
    return enrolment


# ---------- Access ----------

def test_only_l_and_d_admins_open_a_scorecard_by_employee_id(world, db, client_for):
    world.complete(world.employee, world.training())
    path = f"/reports/employees/{world.employee.id}/scorecard"
    assert client_for(world.admin).get(path).status_code == 200
    assert client_for(world.employee).get(path).status_code == 403  # Not even one's own, through the admin page.
    assert client_for(world.teammate).get(path).status_code == 403
    assert client_for(world.employee).get(path + "/pdf").status_code == 403
    from tests.conftest import ApiClient

    assert ApiClient().get(path).status_code == 401


def test_unknown_malformed_and_sign_in_only_records_are_not_found(world, db, client_for):
    admin = client_for(world.admin)
    assert admin.get("/reports/employees/3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b/scorecard").status_code == 404
    assert admin.get("/reports/employees/not-an-id/scorecard").status_code in (400, 422)
    reserved = world.person("TC-LD-ADMIN", "reserved@test.example", ["LD_ADMIN"])  # The designated sign-in record.
    db.commit()
    assert admin.get(f"/reports/employees/{reserved.id}/scorecard").status_code == 404


def test_filter_ids_and_dates_are_validated_on_the_server(world, db, client_for):
    mine, not_mine = world.training("T1"), world.training("T2")
    world.complete(world.employee, mine)
    world.complete(world.teammate, not_mine)
    admin = client_for(world.admin)
    path = f"/reports/employees/{world.employee.id}/scorecard"
    refused = admin.get(f"{path}?training_id={not_mine.id}")
    assert refused.status_code == 400 and "not assigned to this employee" in refused.json()["error"]["message"]
    assert admin.get(f"{path}?training_id=nonsense").status_code in (400, 422)
    assert admin.get(f"{path}?date_from=2026-11-05&date_to=2026-11-01").status_code == 400
    assert admin.get(f"{path}?date_from=31-12-2026").status_code in (400, 422)  # Wire format stays ISO.
    assert admin.get(f"{path}/pdf?training_id={not_mine.id}").status_code == 400


# ---------- No cross-employee data ----------

def test_no_other_employees_attempts_feedback_or_trainings_appear(world, db, client_for):
    shared, theirs = world.training("T1"), world.training("T2")
    mine_obligation = world.complete(world.employee, shared)
    their_obligation = world.complete(world.teammate, shared)
    world.complete(world.teammate, theirs)
    me, them = client_for(world.employee), client_for(world.teammate)
    give_feedback(me, take(db, me, mine_obligation.id, 9)["attempt_id"])
    tick(1)
    their_attempt = take(db, them, their_obligation.id, 4)["attempt_id"]
    them.post(f"/attempts/{their_attempt}/feedback", json={"ratings": {"relevance": 1, "clarity": 1, "alignment": 1, "fairness": 1, "confidence": 1}, "comment": "Teammate private comment"})

    data = card(client_for(world.admin), world.employee)
    assert data["employee"]["id"] == str(world.employee.id) and data["employee"]["employee_code"] == "E1"
    assert [o["name"] for o in data["training_options"]] == ["Training T1"]
    assert [t["training"] for t in data["trainings"]] == ["Training T1"]
    assert [a["score"] for a in data["attempts"]] == [90.0]
    assert their_attempt not in {a["id"] for a in data["attempts"]}
    assert [f["overall"] for f in data["feedback"]] == [4.0]
    assert "Teammate private comment" not in str(data)
    assert data["summary"] == {"assigned": 1, "completed": 1, "passed": 1, "overdue": 0}


def test_profile_shows_recorded_fields_and_never_a_password(world, db, client_for):
    world.employee.joining_date = NOW.date() - timedelta(days=400)
    world.teammate.grade = None
    world.teammate.department_id = None
    db.commit()
    admin = client_for(world.admin)
    profile = card(admin, world.employee)["employee"]
    assert profile == {
        "id": str(world.employee.id),
        "name": "Person E1",
        "employee_code": "E1",
        "department": "Ops",
        "location": "Location 1",
        "grade": "G1",
        "joining_date": str(NOW.date() - timedelta(days=400)),
        "email": "employee@test.example",
    }
    missing = card(admin, world.teammate)["employee"]
    assert (missing["grade"], missing["department"], missing["joining_date"]) == (None, None, None)
    text = str(card(admin, world.employee)).lower()
    assert "password" not in text and "hash" not in text


# ---------- Highest score, missing scores and retained re-training history ----------

def test_highest_score_is_the_best_post_test_across_retained_attempts_and_cycles(world, db, client_for):
    training = world.training()
    admin, client = client_for(world.admin), client_for(world.employee)
    fail_three_times_then_retrain(world, db, admin, client, training)

    data = card(admin, world.employee)
    row = data["trainings"][0]
    # First 50, then 60 (the best), 40, and after re-training 30 (the latest). Highest is never the latest.
    assert (row["first_score"], row["latest_score"], row["highest_score"]) == (50.0, 30.0, 60.0)
    assert row["attempts"] == 4  # Every cycle, the same post-test attempts the history lists.
    assert row["result"] == "NOT_PASSED" and row["training_cycle"] == 2

    post = [a for a in data["attempts"] if a["assessment_type"] == "POST_TEST"]
    assert len(post) == row["attempts"]
    # Newest first; attempt numbers repeat across cycles, so each says its cycle.
    assert [(a["training_cycle"], a["attempt_number"], a["score"]) for a in post] == [(2, 1, 30.0), (1, 3, 40.0), (1, 2, 60.0), (1, 1, 50.0)]
    assert all(a["show_cycle"] for a in post)
    assert [a["result"] for a in post] == ["NOT_PASSED"] * 4
    assert {a["submission"] for a in post} == {"By employee"}
    submitted = [a["submitted_at"] for a in post]
    assert submitted == sorted(submitted, reverse=True)


def test_pre_test_never_counts_as_the_highest_and_gain_uses_the_first_post_test(world, db, client_for):
    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type="PRE_TEST", version=1, question_count=10, duration_seconds=900, pass_mark_percent=Decimal("70"), max_attempts=1, schedule_mode="SAME_DAY", is_active=True))
    db.commit()
    enrolment = world.enrol(world.employee, training)
    admin, client = client_for(world.admin), client_for(world.employee)
    pre = client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert pre.status_code == 200, pre.text
    answer_with_score(db, client, pre.json()["data"], 10)  # A perfect pre-test: higher than any post-test.
    submit(client, pre.json()["data"]["attempt_id"])
    obligation_id = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()}).json()["data"]["obligation_id"]
    tick(1)
    give_feedback(client, take(db, client, obligation_id, 5)["attempt_id"])
    authorise_reattempt(client, admin, obligation_id)
    tick(2)
    take(db, client, obligation_id, 8)

    data = card(admin, world.employee)
    row = data["trainings"][0]
    assert (row["first_score"], row["latest_score"], row["highest_score"], row["attempts"]) == (50.0, 80.0, 80.0, 2)
    gain = data["learning_gain"][0]
    assert (gain["pre_test"], gain["first_post_test"], gain["gain"], gain["comparable"]) == (100.0, 50.0, -50.0, True)  # Not 80 − 100.
    pre_rows = [a for a in data["attempts"] if a["assessment_type"] == "PRE_TEST"]
    assert [(a["score"], a["result"], a["show_cycle"]) for a in pre_rows] == [(100.0, "BASELINE", False)]


def test_missing_scores_stay_missing_and_gain_is_not_comparable(world, db, client_for):
    world.enrol(world.employee, world.training("T1"))  # Assigned, not completed.
    world.complete(world.employee, world.training("T2"))  # Completed, not taken.
    data = card(client_for(world.admin), world.employee)
    for row in data["trainings"]:
        assert (row["first_score"], row["latest_score"], row["highest_score"], row["attempts"], row["result"]) == (None, None, None, 0, "PENDING")
    timing = {t["training"]: t["assessment_timing"] for t in data["trainings"]}
    assert timing["Training T1"] == "Awaiting training completion"
    for gain in data["learning_gain"]:
        assert (gain["gain"], gain["comparable"]) == (None, False)
        assert gain["note"] == "No pre-test is set up for this training."
    assert data["attempts"] == [] and data["feedback"] == []


# ---------- Summary counts ----------

def test_summary_counts_assignments_not_attempts(world, db, client_for):
    passed_twice, completed_overdue, assigned_only = world.training("T1"), world.training("T2"), world.training("T3")
    admin, client = client_for(world.admin), client_for(world.employee)
    obligation = world.complete(world.employee, passed_twice)
    give_feedback(client, take(db, client, obligation.id, 4)["attempt_id"])
    authorise_reattempt(client, admin, obligation.id)
    tick(1)
    take(db, client, obligation.id, 9)
    world.complete(world.employee, completed_overdue, NOW - timedelta(days=5))  # Due five days ago, not taken.
    world.enrol(world.employee, assigned_only)

    data = card(admin, world.employee)
    assert data["summary"] == {"assigned": 3, "completed": 2, "passed": 1, "overdue": 1}
    rows = by_training(data["trainings"])
    assert rows["Training T1"]["attempts"] == 2 and rows["Training T1"]["result"] == "PASSED"
    assert rows["Training T2"]["assessment_timing"] == "Overdue"
    assert len([a for a in data["attempts"] if a["training"] == "Training T1"]) == 2


# ---------- Filters ----------

def test_filters_apply_to_every_section_and_the_date_is_training_completion(world, db, client_for):
    early, late = world.training("T1"), world.training("T2")
    admin, client = client_for(world.admin), client_for(world.employee)
    first = world.complete(world.employee, early, NOW - timedelta(days=20))
    second = world.complete(world.employee, late, NOW - timedelta(days=2))
    give_feedback(client, take(db, client, first.id, 9)["attempt_id"])
    tick(1)
    give_feedback(client, take(db, client, second.id, 4)["attempt_id"])

    everything = card(admin, world.employee)
    assert len(everything["trainings"]) == 2 and len(everything["attempts"]) == 2 and len(everything["feedback"]) == 2
    assert "training completion date" in everything["date_basis"]

    start_day = (NOW - timedelta(days=5)).date().isoformat()
    dated = card(admin, world.employee, date_from=start_day)
    assert dated["filters"] == {"date_from": start_day}
    for section in ("trainings", "learning_gain", "feedback", "attempts"):
        assert {i["training"] for i in dated[section]} == {"Training T2"}, section
    assert dated["summary"] == {"assigned": 1, "completed": 1, "passed": 0, "overdue": 0}
    assert len(dated["training_options"]) == 2  # The filter still offers every training of this employee.

    chosen = card(admin, world.employee, training_id=early.id)
    for section in ("trainings", "learning_gain", "feedback", "attempts"):
        assert {i["training"] for i in chosen[section]} == {"Training T1"}, section
    assert chosen["summary"]["passed"] == 1

    nothing = card(admin, world.employee, training_id=early.id, date_from=start_day)
    assert (nothing["trainings"], nothing["attempts"], nothing["feedback"], nothing["learning_gain"]) == ([], [], [], [])
    assert nothing["summary"] == {"assigned": 0, "completed": 0, "passed": 0, "overdue": 0}


# ---------- Feedback ----------

def test_feedback_shows_ratings_overall_comment_and_missing_states(world, db, client_for, monkeypatch):
    given, owed = world.training("T1"), world.training("T2")
    client = client_for(world.employee)
    first = world.complete(world.employee, given)
    attempt = take(db, client, first.id, 9)["attempt_id"]
    response = client.post(f"/attempts/{attempt}/feedback", json={"ratings": {"relevance": 5, "clarity": 4, "alignment": 4, "fairness": 3, "confidence": 5}, "comment": "Clear examples."})
    assert response.status_code == 200, response.text
    tick(1)
    take(db, client, world.complete(world.employee, owed).id, 9)  # Feedback not given yet.

    admin = client_for(world.admin)
    items = by_training(card(admin, world.employee)["feedback"])
    submitted = items["Training T1"]
    assert submitted["status"] == "SUBMITTED"
    assert submitted["ratings"] == {"relevance": 5, "clarity": 4, "alignment": 4, "fairness": 3, "confidence": 5}
    assert submitted["overall"] == 4.2 and submitted["comment"] == "Clear examples." and submitted["submitted_at"]
    assert (items["Training T2"]["status"], items["Training T2"]["overall"], items["Training T2"]["submitted_at"]) == ("NOT_SUBMITTED", None, None)
    # Results from before feedback began are never asked: the same exemption as the feedback form.
    monkeypatch.setattr(get_settings(), "feedback_required_from", "2026-12-31")
    assert by_training(card(admin, world.employee)["feedback"])["Training T2"]["status"] == "NOT_REQUIRED"


# ---------- PDF ----------

def test_pdf_holds_every_matching_record_with_the_same_filters(world, db, client_for):
    admin, client = client_for(world.admin), client_for(world.employee)
    trainings = [world.training(f"T{i}") for i in range(1, 8)]  # Seven: more than the five shown on screen.
    for minute, training in enumerate(trainings, start=1):
        tick(minute)
        give_feedback(client, take(db, client, world.complete(world.employee, training).id, 9)["attempt_id"])

    response = admin.get(f"/reports/employees/{world.employee.id}/scorecard/pdf")
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"%PDF") and response.headers["content-type"] == "application/pdf"
    assert 'filename="traincheck-employee-scorecard-E1-' in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"
    text = " ".join(page.extract_text() for page in PdfReader(io.BytesIO(response.content)).pages)
    for training in trainings:
        assert text.count(training.title) >= 4, training.title  # Record, gain, feedback and history.
    assert "Training record (7)" in text and "Assessment attempt history (7)" in text
    assert "Person E1" in text and "Training: All trainings" in text
    assert "UTC" not in text and " IST" not in text
    assert "04-11-2026" in text  # India dates, DD-MM-YYYY.
    assert db.scalar(select(AuditLog).where(AuditLog.action == "EMPLOYEE_SCORECARD_EXPORTED")) is not None

    one = admin.get(f"/reports/employees/{world.employee.id}/scorecard/pdf?training_id={trainings[0].id}")
    filtered = " ".join(page.extract_text() for page in PdfReader(io.BytesIO(one.content)).pages)
    assert "Training record (1)" in filtered and "Training T2" not in filtered


# ---------- Reports & Analytics rows carry the employee ID ----------

@pytest.mark.parametrize("code", ["compliance", "pass-fail", "learning-gain", "employee-history"])
def test_report_rows_name_their_employee_by_id(world, db, client_for, code):
    training = world.training()
    for person in (world.employee, world.teammate):
        world.complete(person, training)
    report = client_for(world.admin).get(f"/reports/{code}").json()["data"]
    assert len(report["employee_ids"]) == len(report["rows"]) > 0
    names = {str(world.employee.id): "Person E1", str(world.teammate.id): "Person E2"}
    for employee_id, row in zip(report["employee_ids"], report["rows"], strict=True):
        assert row[report["columns"].index("Employee")] == names[employee_id]


def test_reports_without_employee_rows_have_no_ids(world, db, client_for):
    world.complete(world.employee, world.training())
    assert client_for(world.admin).get("/reports/scorecard").json()["data"]["employee_ids"] == []
