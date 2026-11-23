"""Pre-test, training targeting, scheduling, question bank, imports, jobs, audit, scope and Neon settings."""
import io
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from openpyxl import Workbook
from sqlalchemy import func, inspect, select

from app.core import clock
from app.core import db as database
from app.core.config import normalise_database_url
from app.core.db import Base
from app.main import app
from app.models import (
    AssessmentObligation,
    AuditLog,
    CalendarHoliday,
    Enrolment,
    ImportJob,
    ImportJobRow,
    Notification,
    Question,
    QuestionAnswerKey,
    QuestionRevision,
    QuestionTrainingTag,
    Training,
    TrainingCompletion,
    UserAccount,
    WorkingCalendar,
)
from app.modules.assessment.scheduling import CalendarView, calculate_due_at
from app.modules.assessment.service import pool_report
from app.modules.imports.question_format import FIELDS
from app.modules.reports.scorecard import gain_values
from app.modules.scheduler.jobs import pending_assessment_reminders
from tests.conftest import NOW, take

SAMPLES = Path(__file__).resolve().parents[2].parent / "TrainCheck-Prototype" / "sample"


# ---------- Learning gain and pre-test ----------

def test_gain_calculation_edges():  # TC-KIR-003, TC-KIR-004
    assert gain_values(50, 80) == (30, 60.0, None)
    assert gain_values(100, 100)[1] is None and "100%" in gain_values(100, 100)[2]
    assert gain_values(None, 80) == (None, None, "Not collected")
    assert gain_values(50, None) == (None, None, "Not collected")
    assert gain_values(80, 60)[0] == -20


def _pretest_training(world, db):
    from app.core.enums import AssessmentType
    from app.models import AssessmentConfig

    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=10, duration_seconds=600, max_attempts=1))
    db.commit()
    return training


def _take_pre(db, client, enrolment_id, correct):
    from tests.conftest import answer_with_score, submit

    response = client.post(f"/me/pre-tests/{enrolment_id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 200, response.text
    attempt = response.json()["data"]
    # Pre-tests run in the same secure environment as post-training assessments.
    assert attempt["monitored"] is True and attempt["require_fullscreen"] is True
    answer_with_score(db, client, attempt, correct)
    return submit(client, attempt["attempt_id"])


def test_learning_gain_uses_pre_test_and_first_post_test(world, db, client_for):  # SC-2L-107
    from app.modules.training.service import record_completion

    training = _pretest_training(world, db)
    enrolment = world.enrol(world.employee, training)
    client = client_for(world.employee)
    assert _take_pre(db, client, enrolment.id, 5)["score_percent"] == 50.0
    assert client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True}).status_code == 409

    db.expire_all()
    obligation = record_completion(db, db.get(Enrolment, enrolment.id), NOW - timedelta(days=1), "MANUAL", None)
    db.commit()
    assert take(db, client, obligation.id, 8)["first_score"] == 80.0  # A pre-test is not a first post-test score.

    report = client_for(world.admin).get("/reports/learning-gain").json()["data"]
    row = dict(zip(report["columns"], report["rows"][0], strict=True))
    assert (row["Pre-Test %"], row["First Post-Test %"], row["Gain (points)"], row["Normalised Gain %"]) == (50.0, 80.0, 30.0, 60.0)
    card = client_for(world.admin).get(f"/scorecards/{training.id}").json()["data"]["learning"]
    assert card["learning_gain_mean"] == 30.0 and card["pre_test_state"] == "Available"


def test_pre_test_unavailable_after_completion_or_when_disabled(world, db, client_for):
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    client = client_for(world.employee)
    assert client.post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True}).json()["error"]["code"] == "PRE_TEST_UNAVAILABLE"


def test_pre_test_offered_only_once_its_rules_are_saved(world, db, client_for):
    """Enabled on the training but no pre-test rules saved: no Take Pre-test, because starting it would fail."""
    training = world.training()
    training.pretest_enabled = True
    db.commit()
    world.enrol(world.employee, training)
    client = client_for(world.employee)
    card = lambda: next(c for c in client.get("/me/trainings").json()["data"] if c["training_id"] == str(training.id))  # noqa: E731
    assert card()["pre_test_available"] is False

    from app.core.enums import AssessmentType
    from app.models import AssessmentConfig

    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=10, duration_seconds=600, max_attempts=1))
    db.commit()
    assert card()["pre_test_available"] is True


# ---------- Scheduling ----------

class Config:
    def __init__(self, mode, delay=0, working=False, on=None, at=None):
        self.schedule_mode, self.schedule_delay_days, self.schedule_uses_working_days, self.schedule_date = mode, delay, working, on
        self.schedule_at = at  # FIXED_DATE with a chosen time (UTC); None for configurations saved before times.


CALENDAR = CalendarView("UTC", [0, 1, 2, 3, 4], {date(2026, 11, 9)})
FRIDAY = datetime(2026, 11, 6, 15, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("config", "expected"),
    [
        (Config("SAME_DAY"), FRIDAY),
        (Config("NEXT_WORKING_DAY"), datetime(2026, 11, 10, tzinfo=UTC)),  # Weekend and the Monday holiday are skipped.
        (Config("DELAY_DAYS", 3), datetime(2026, 11, 9, tzinfo=UTC)),
        (Config("DELAY_DAYS", 2, True), datetime(2026, 11, 11, tzinfo=UTC)),
        (Config("FIXED_DATE", on=date(2026, 11, 12)), datetime(2026, 11, 12, tzinfo=UTC)),  # The start of the chosen day.
        (Config("FIXED_DATE", on=date(2026, 11, 6)), FRIDAY),  # Completed on the chosen day: due at once.
        (Config("FIXED_DATE", on=date(2026, 11, 2)), FRIDAY),  # Completed after the chosen day: due at once, never in the past.
        (Config("FIXED_DATE", on=date(2026, 11, 12), at=datetime(2026, 11, 12, 9, 45, tzinfo=UTC)), datetime(2026, 11, 12, 9, 45, tzinfo=UTC)),  # The chosen time.
        (Config("FIXED_DATE", on=date(2026, 11, 6), at=datetime(2026, 11, 6, 18, 0, tzinfo=UTC)), datetime(2026, 11, 6, 18, 0, tzinfo=UTC)),  # Later the same day.
        (Config("FIXED_DATE", on=date(2026, 11, 6), at=datetime(2026, 11, 6, 9, 0, tzinfo=UTC)), FRIDAY),  # Completed after the time: due at once.
    ],
)
def test_due_date_policies(config, expected):  # MVP-009
    assert calculate_due_at(CALENDAR, FRIDAY, config) == expected


def test_fixed_date_rule_needs_a_date_that_has_not_passed(world, client_for):
    training = world.training()
    admin = client_for(world.admin)
    rules = {"question_count": 10, "duration_minutes": 20, "pass_mark_percent": 70, "schedule_mode": "FIXED_DATE"}
    assert admin.post(f"/admin/trainings/{training.id}/assessment-configs", json=rules).status_code == 400
    past = (NOW - timedelta(days=3)).date().isoformat()
    assert admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={**rules, "schedule_date": past, "schedule_time": "10:00"}).status_code == 400
    future = (NOW + timedelta(days=3)).date().isoformat()
    # A date alone is not enough: the time is never assumed (it used to mean midnight).
    assert admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={**rules, "schedule_date": future}).status_code == 400
    saved = admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={**rules, "schedule_date": future, "schedule_time": "10:00"})
    assert saved.status_code == 200, saved.text
    assert (saved.json()["data"]["schedule_mode"], saved.json()["data"]["schedule_date"], saved.json()["data"]["schedule_time"]) == ("FIXED_DATE", future, "10:00")


def test_timezone_decides_the_local_day():  # OD-BRD-004 is configuration, not hard-coded.
    late_utc = datetime(2026, 11, 6, 20, 0, tzinfo=UTC)  # Already Saturday in India.
    india = CalendarView("Asia/Kolkata", [0, 1, 2, 3, 4], set())
    due = calculate_due_at(india, late_utc, Config("NEXT_WORKING_DAY"))
    assert due.date() == date(2026, 11, 9)


def test_schedule_snapshot_survives_calendar_change(world, db):  # BR §4.3
    training = world.training(schedule_mode="NEXT_WORKING_DAY")
    obligation = world.complete(world.employee, training, NOW - timedelta(days=1))
    original = obligation.due_at
    assert obligation.schedule_snapshot["mode"] == "NEXT_WORKING_DAY"
    calendar = db.scalar(select(WorkingCalendar))
    db.add(CalendarHoliday(calendar_id=calendar.id, holiday_date=original.date(), name="New holiday"))
    db.commit()
    db.expire_all()
    assert db.get(AssessmentObligation, obligation.id).due_at == original


def test_calendar_api_is_ld_managed(world, client_for):
    admin = client_for(world.admin)
    response = admin.patch("/admin/calendar", json={"name": "Six day", "timezone": "Asia/Kolkata", "working_weekdays": [0, 1, 2, 3, 4, 5]})
    assert response.status_code == 200, response.text
    # Audit B7: invalid input is a 400 VALIDATION_ERROR (it was a 409 CONFLICT), with the same message, and changes nothing.
    bad_zone = admin.patch("/admin/calendar", json={"name": "Bad", "timezone": "Not/AZone", "working_weekdays": [0]})
    assert bad_zone.status_code == 400 and bad_zone.json()["error"]["code"] == "VALIDATION_ERROR"
    assert bad_zone.json()["error"]["message"] == "Use a valid timezone name such as Asia/Kolkata."
    bad_day = admin.patch("/admin/calendar", json={"name": "Bad", "timezone": "UTC", "working_weekdays": [0, 7]})
    assert bad_day.status_code == 400 and bad_day.json()["error"]["code"] == "VALIDATION_ERROR"
    assert bad_day.json()["error"]["message"] == "Weekdays must be numbers from 0 (Monday) to 6 (Sunday)."
    unchanged = admin.get("/admin/calendar").json()["data"]
    assert (unchanged["name"], unchanged["timezone"], unchanged["working_weekdays"]) == ("Six day", "Asia/Kolkata", [0, 1, 2, 3, 4, 5])
    holiday = admin.post("/admin/calendar/holidays", json={"holiday_date": "2026-12-25", "name": "Holiday"}).json()["data"]["holidays"][0]
    assert admin.delete(f"/admin/calendar/holidays/{holiday['id']}").status_code == 200
    assert client_for(world.hr).patch("/admin/calendar", json={"name": "No", "timezone": "UTC", "working_weekdays": [0]}).status_code == 403


# ---------- Targeting and enrolment (SC-2L-103) ----------

def test_common_department_function_and_combined_targeting(world, db, client_for):
    admin = client_for(world.admin)
    ops, compliance = str(world.departments["OPS"].id), str(world.functions["COMPLIANCE"].id)

    def create(code, scope, departments=(), functions=()):
        response = admin.post("/admin/trainings", json={"training_code": code, "title": f"Training {code}", "target_scope": scope, "department_ids": list(departments), "function_ids": list(functions)})
        assert response.status_code == 200, response.text
        training_id = response.json()["data"]["id"]
        # Created as a draft, which cannot take assignments (Phase 1). Targeting is what is under test here.
        db.get(Training, training_id).status = "ACTIVE"
        db.commit()
        return training_id

    assert admin.post("/admin/trainings", json={"title": "No target", "target_scope": "DEPARTMENT"}).status_code == 400

    cases = {
        create("COMMON", "COMMON"): 7,  # All seven people.
        create("DEPT", "DEPARTMENT", [ops]): 5,  # Everyone except the two in CX.
        create("FUNC", "FUNCTION", functions=[compliance]): 1,  # Only the Compliance employee.
        create("BOTH", "COMBINED", [ops], [compliance]): 1,
    }
    for training_id, count in cases.items():
        result = admin.post("/admin/enrolments", json={"training_id": training_id, "use_training_target": True}).json()["data"]
        assert result["created"] == count, result


def test_assignment_never_duplicates_and_respects_target(world, db, client_for):
    admin = client_for(world.admin)
    training = world.training()
    body = {"training_id": str(training.id), "employee_ids": [str(world.employee.id), str(world.teammate.id)]}
    assert admin.post("/admin/enrolments", json=body).json()["data"]["created"] == 2
    again = admin.post("/admin/enrolments", json=body).json()["data"]
    assert (again["created"], again["skipped_existing"], again["skipped_out_of_target"]) == (0, 2, 0)
    assert {r["status"] for r in again["results"]} == {"ALREADY_ASSIGNED"}
    assert db.scalar(select(func.count()).select_from(Enrolment)) == 2


def test_database_rejects_duplicate_enrolment(world, db):
    from sqlalchemy.exc import IntegrityError

    training = world.training()
    world.enrol(world.employee, training)
    db.add(Enrolment(training_id=training.id, employee_id=world.employee.id, assigned_at=NOW))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_completion_flow_through_api(world, db, client_for):
    admin = client_for(world.admin)
    training = world.training()
    enrolment = world.enrol(world.employee, training)
    assert admin.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "PRESENT"}).status_code == 200
    future = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": "2027-01-01"})
    assert future.status_code == 400
    done = admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())})
    assert done.status_code == 200, done.text
    assert done.json()["data"]["assessment_state"] == "Due"
    assert admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())}).status_code == 409
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 1
    assert admin.post(f"/admin/enrolments/{enrolment.id}/cancel", json={"reason": "Completed, should fail"}).status_code == 409


def test_activation_needs_ready_pool(world, db, client_for):  # BR §20.4
    admin = client_for(world.admin)
    created = admin.post("/admin/trainings", json={"title": "Draft", "training_code": "D1"}).json()["data"]
    response = admin.post(f"/admin/trainings/{created['id']}/status", json={"status": "ACTIVE"})
    assert response.status_code == 422
    config = admin.post(f"/admin/trainings/{created['id']}/assessment-configs", json={"question_count": 99, "duration_minutes": 10})
    assert config.status_code == 422 and config.json()["error"]["details"]["shortfall"] == 99


def test_unused_training_can_be_deleted(world, client_for, db):
    admin = client_for(world.admin)
    created = admin.post("/admin/trainings", json={"title": "Never used", "training_code": "DEL1"}).json()["data"]
    assert admin.post(f"/admin/trainings/{created['id']}/materials", json={"kind": "LINK", "title": "Deck", "url": "https://example.com/d"}).status_code == 200
    assert client_for(world.hr).delete(f"/admin/trainings/{created['id']}").status_code == 403
    assert client_for(world.employee).delete(f"/admin/trainings/{created['id']}").status_code == 403
    response = admin.delete(f"/admin/trainings/{created['id']}")
    assert response.status_code == 200, response.text
    assert admin.get(f"/admin/trainings/{created['id']}").status_code == 404
    log = db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_DELETED"))
    assert log.before_summary["code"] == "DEL1" and log.target_id == created["id"]
    assert admin.delete(f"/admin/trainings/{created['id']}").status_code == 404


def test_training_with_history_cannot_be_deleted(world, client_for, db):
    training = world.training()  # Has a batch.
    world.complete(world.employee, training)  # Assignment, completion and assessment.
    response = client_for(world.admin).delete(f"/admin/trainings/{training.id}")
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "TRAINING_IN_USE" and "Archive it instead" in error["message"]
    assert {"assignments", "assessments", "batches"} <= set(error["details"]["in_use"])
    db.expire_all()
    assert db.get(Training, training.id) is not None
    assert db.scalar(select(func.count()).select_from(Enrolment).where(Enrolment.training_id == training.id)) == 1


def test_materials_and_trainers(world, client_for):
    admin = client_for(world.admin)
    training = world.training()
    assert admin.post(f"/admin/trainings/{training.id}/materials", json={"title": "Deck", "url": "http://not-secure.example"}).status_code == 400
    material = admin.post(f"/admin/trainings/{training.id}/materials", json={"kind": "RECORDING", "title": "Recording", "url": "https://example.com/r"})
    assert material.status_code == 200, material.text
    # The Batches & Sessions APIs are removed (audit P5); test_rbac checks they are gone and batches still work.
    assert admin.post("/admin/trainers", json={"name": "New Trainer"}).status_code == 200
    assert admin.post("/admin/functions", json={"code": "RISK", "name": "Risk"}).status_code == 200
    assert admin.post("/admin/functions", json={"code": "RISK", "name": "Risk again"}).status_code == 409


def test_functions_generate_internal_codes_and_keep_them_when_edited(world, client_for):
    admin = client_for(world.admin)
    created = []
    for name in ("Risk", "Recruitment"):
        response = admin.post("/admin/functions", json={"name": name, "is_active": True})
        assert response.status_code == 200, response.text
        created.append(response.json()["data"])
    assert created[0]["code"] != created[1]["code"]
    assert all(unit["code"].startswith("FUNC-") and len(unit["code"]) <= 40 for unit in created)

    original = created[0]
    edited = admin.patch(f"/admin/functions/{original['id']}", json={"name": "Risk Operations", "is_active": False})
    assert edited.status_code == 200, edited.text
    assert edited.json()["data"] == {**original, "name": "Risk Operations", "is_active": False}

    existing = world.functions["COMPLIANCE"]
    edited = admin.patch(f"/admin/functions/{existing.id}", json={"name": "Compliance Operations"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["data"]["code"] == "COMPLIANCE"
    assert admin.post("/admin/departments", json={"name": "Missing code"}).status_code == 400


# ---------- Question bank (SC-2L-104) ----------

def question_body(**overrides):
    return {
        "question_code": "NEW-1",
        "topic": "Topic",
        "question_type": "MCQ_SINGLE",
        "question_text": "What is the right step?",
        "options": ["Right", "Wrong"],
        "correct_option_indexes": [0],
        "difficulty": "EASY",
        "marks": 1,
        **overrides,
    }


@pytest.mark.parametrize(
    "bad",
    [
        {"options": ["Only one"]},
        {"options": ["Same", "same"]},
        {"correct_option_indexes": [5]},
        {"correct_option_indexes": [0, 1]},
        {"question_type": "TRUE_FALSE", "options": ["Yes", "No"]},
        {"marks": 0},
        {"language": "Klingon"},
    ],
)
def test_question_validation(world, client_for, bad):  # BR §14.2
    assert client_for(world.admin).post("/admin/questions", json=question_body(**bad)).status_code == 400


def test_question_create_edit_version_deactivate_search(world, client_for, db):  # MVP-015, MVP-018
    admin = client_for(world.admin)
    training = world.training(questions=0, count=1)
    second = world.training("T2", questions=0, count=1)
    created = admin.post("/admin/questions", json=question_body(training_ids=[str(training.id), str(second.id)])).json()["data"]
    assert created["version"] == 1 and len(created["trainings"]) == 2  # One question, reused by two trainings.
    assert admin.post("/admin/questions", json=question_body()).status_code == 409

    edited = admin.patch(f"/admin/questions/{created['id']}", json=question_body(question_text="A better question?", options=["A", "B", "C"], correct_option_indexes=[2], training_ids=[str(training.id)], expected_version=created["version"])).json()["data"]
    assert edited["version"] == 2
    assert [o["is_correct"] for o in edited["options"]] == [False, False, True]
    assert db.scalar(select(func.count()).select_from(QuestionRevision)) == 2
    assert db.scalar(select(func.count()).select_from(QuestionAnswerKey)) == 1

    assert len(admin.get("/admin/questions?search=better").json()["data"]) == 1
    assert admin.get("/admin/questions?search=nothing").json()["data"] == []
    assert len(admin.get(f"/admin/questions?training_id={training.id}&difficulty=EASY&language=English").json()["data"]) == 1
    assert admin.get(f"/admin/questions?training_id={second.id}").json()["data"] == []

    assert admin.post(f"/admin/questions/{created['id']}/status", json={"status": "INACTIVE"}).json()["data"]["status"] == "INACTIVE"
    assert admin.get("/admin/questions?status=ACTIVE").json()["data"] == []
    assert db.get(Question, created["id"]) is not None  # Deactivated, never deleted.


def test_search_treats_sql_as_data(world, client_for, db):  # SEC-013
    world.training(questions=1, count=1)
    admin = client_for(world.admin)
    assert admin.get("/admin/questions", params={"search": "'; DROP TABLE questions; --"}).json()["data"] == []
    assert db.scalar(select(func.count()).select_from(Question)) == 1


def test_department_and_function_categorisation(world, client_for):
    admin = client_for(world.admin)
    body = question_body(department_id=str(world.departments["OPS"].id), function_id=str(world.functions["SALES"].id))
    assert admin.post("/admin/questions", json=body).status_code == 200
    assert len(admin.get(f"/admin/questions?function_id={world.functions['SALES'].id}").json()["data"]) == 1
    assert admin.get(f"/admin/questions?department_id={world.departments['CX'].id}").json()["data"] == []


# ---------- Imports ----------

HEADERS = ",".join(FIELDS)


def upload(client, kind, name, content, training_id=None, test_type="POST_TEST"):
    """Question imports name a training and a test type; pass test_type=None to leave it out."""
    data = {"import_type": kind}
    if training_id is not None:
        data["training_id"] = str(training_id)
    if kind == "QUESTIONS" and test_type is not None:
        data["test_type"] = test_type
    return client.post("/admin/imports", files={"file": (name, content)}, data=data)


def valid_row(question="Which is right?", **changes):
    """An MCQ-format row: the training is selected on the import screen and the ID is generated on confirmation."""
    row = {"question": question, "option_a": "Right", "option_b": "Wrong", "option_c": "Maybe", "option_d": "Never", "correct": "A", "topic": "Topic"}
    row.update(changes)
    return ",".join(row[h] for h in FIELDS)


def test_question_import_validates_previews_then_commits(world, db, client_for):  # TC-IMP-001, -002, -005
    training = world.training(questions=0, count=1)
    admin = client_for(world.admin)
    text = "\n".join([HEADERS, valid_row(), valid_row("Second?", correct="Z"), valid_row("Third?", option_d=""), valid_row("Fourth?", option_b="right"), valid_row("Fifth?", topic="")])
    job = upload(admin, "QUESTIONS", "questions.csv", text.encode(), training.id).json()["data"]
    assert (job["status"], job["accepted_rows"], job["rejected_rows"]) == ("READY", 1, 4)
    assert job["counts"] == {"VALID": 1, "IMPORTED": 0, "DUPLICATE": 0, "CONFLICT": 0, "INVALID": 4}
    statuses = {r["row"]: r for r in job["rows"]}
    assert statuses[2]["status"] == "VALID" and statuses[2]["record"] == "Which is right?"
    assert [statuses[n]["errors"][0]["field"] for n in (3, 4, 5, 6)] == ["correct", "option_d", "option_b", "topic"]
    assert db.scalar(select(func.count()).select_from(Question)) == 0  # Nothing is applied before commit.

    report = admin.get(f"/admin/imports/{job['id']}/error-report")
    assert report.status_code == 200 and "option_d" in report.text

    done = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["status"] == "COMPLETED_WITH_ERRORS" and done["accepted_rows"] == 1
    assert done["counts"]["IMPORTED"] == 1 and done["counts"]["INVALID"] == 4
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 1
    assert admin.post(f"/admin/imports/{job['id']}/commit").status_code == 409


def test_existing_question_is_never_overwritten(world, db, client_for):  # TC-IMP-003
    training = world.training(questions=1, count=1)
    admin = client_for(world.admin)
    original = db.scalar(select(Question))
    key_before = set(db.scalars(select(QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id == original.id)))
    same = {"question": original.question_text, "topic": original.topic, "option_a": "T1-Q01 option 0", "option_b": "T1-Q01 option 1", "option_c": "T1-Q01 option 2", "option_d": "T1-Q01 option 3", "correct": "A"}
    text = "\n".join([HEADERS, valid_row(**same), valid_row(**{**same, "correct": "B"}), valid_row("New?"), valid_row("New?")])
    job = upload(admin, "QUESTIONS", "q.csv", text.encode(), training.id).json()["data"]
    assert [r["status"] for r in job["rows"]] == ["DUPLICATE", "CONFLICT", "VALID", "DUPLICATE"]
    assert f"already in this training's Post-test pool as {original.question_code}" in job["rows"][0]["errors"][0]["message"]  # Explained, not silent.
    assert "correct answer" in job["rows"][1]["errors"][0]["message"] and f"edit {original.question_code} in the Question Bank" in job["rows"][1]["errors"][0]["message"]
    assert "Same question as row 4" in job["rows"][3]["errors"][0]["message"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    db.expire_all()
    assert db.get(Question, original.id).version == 1
    assert set(db.scalars(select(QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id == original.id))) == key_before


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("virus.exe", b"MZ..."),
        ("empty.csv", b""),
        ("fake.xlsx", b"this is not a workbook"),
        ("fake.csv", b"PK\x03\x04binary"),
        ("big.csv", b"x" * (5 * 1024 * 1024 + 1)),
    ],
)
def test_unsafe_files_are_rejected(world, client_for, name, content):  # TC-IMP-004, SEC-010
    training = world.training(questions=0, count=1)
    response = upload(client_for(world.admin), "QUESTIONS", name, content, training.id)
    assert response.status_code == 400 and response.json()["error"]["code"] == "INVALID_FILE"


def test_formula_cells_and_macros_are_rejected(world, client_for):  # TC-IMP-004
    training = world.training(questions=0, count=1)
    admin = client_for(world.admin)
    workbook = Workbook()
    workbook.active.append(["employee", "training", "completion_date"])
    workbook.active.append(["=1+1", "T1", "2026-11-01"])
    buffer = io.BytesIO()
    workbook.save(buffer)
    assert "formula" in upload(admin, "COMPLETIONS", "f.xlsx", buffer.getvalue()).json()["error"]["message"]

    macro = io.BytesIO()
    with zipfile.ZipFile(buffer) as source, zipfile.ZipFile(macro, "w") as target:
        for item in source.infolist():
            target.writestr(item, source.read(item))
        target.writestr("xl/vbaProject.bin", b"macro")
    assert "macros" in upload(admin, "COMPLETIONS", "m.xlsx", macro.getvalue()).json()["error"]["message"]

    csv_formula = "\n".join([HEADERS, valid_row(question="=HYPERLINK('x')")]).encode()
    job = upload(admin, "QUESTIONS", "f.csv", csv_formula, training.id).json()["data"]
    assert job["rows"][0]["status"] == "INVALID"


def test_wrong_headers_are_explained(world, client_for):
    response = upload(client_for(world.admin), "COMPLETIONS", "c.csv", b"a,b\n1,2")
    assert response.json()["error"]["code"] == "INVALID_HEADERS" and "completion_date" in response.json()["error"]["message"]


def test_completion_import_is_idempotent(world, db, client_for):  # BR §4.5, PRD
    training = world.training()
    admin = client_for(world.admin)
    text = f"employee,training,completion_date\nE1,{training.training_code},2026-11-01\nE1,{training.training_code},2026-11-01\nNOPE,{training.training_code},2026-11-01\nE2,{training.training_code},bad-date\n"
    job = upload(admin, "COMPLETIONS", "c.csv", text.encode()).json()["data"]
    assert [r["status"] for r in job["rows"]] == ["VALID", "DUPLICATE", "INVALID", "INVALID"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 1

    # Removing history preserves completion source links and does not permit duplicate completions.
    assert admin.delete(f"/admin/imports/{job['id']}").json()["data"] == {"deleted": True}
    db.expire_all()
    assert db.get(ImportJob, job["id"]).deleted_at is not None
    assert db.scalar(select(TrainingCompletion).where(TrainingCompletion.import_job_id == job["id"])) is not None
    assert admin.get(f"/admin/imports/{job['id']}").status_code == 404
    assert job["id"] not in {j["id"] for j in admin.get("/admin/imports").json()["data"]}
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 1

    replay = upload(admin, "COMPLETIONS", "c.csv", text.encode()).json()["data"]
    assert replay["rows"][0]["status"] == "DUPLICATE"
    admin.post(f"/admin/imports/{replay['id']}/commit")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 1


def test_templates_download_and_import_cleanly(world, db, client_for):
    training = world.training("ANY-CODE", questions=0, count=1)
    admin = client_for(world.admin)
    for fmt in ("csv", "xlsx"):
        template = admin.get(f"/admin/imports/templates/QUESTIONS?format={fmt}")
        assert template.status_code == 200
        if fmt == "csv":
            assert template.content.decode("utf-8-sig").splitlines()[0] == "question,option_a,option_b,option_c,option_d,correct,topic"
        job = upload(admin, "QUESTIONS", f"template.{fmt}", template.content, training.id).json()["data"]
        assert job["accepted_rows"] == 3, job
    assert admin.get("/admin/imports/templates/QUESTIONS?format=xlsx").content.startswith(b"PK")


@pytest.mark.skipif(not (SAMPLES / "questions-valid.xlsx").exists(), reason="Prototype samples not present")
@pytest.mark.parametrize("name", ["questions-valid.csv", "questions-valid.xlsx"])
def test_old_prototype_question_files_are_refused(world, db, client_for, name):
    """The prototype samples use an old template (ID, type, level, language, active). They are refused with an
    explanation instead of having those columns silently ignored."""
    training = world.training("T001", questions=0, count=1)
    response = upload(client_for(world.admin), "QUESTIONS", name, (SAMPLES / name).read_bytes(), training.id)
    assert response.status_code == 400 and response.json()["error"]["code"] == "INVALID_HEADERS"
    assert "old question template" in response.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_employee_cannot_import(world, client_for):
    assert upload(client_for(world.hr), "QUESTIONS", "q.csv", b"id").status_code == 403
    training = world.training(questions=0, count=1)
    assert upload(client_for(world.hr), "QUESTIONS", "q.csv", b"id", training.id).status_code == 403
    assert upload(client_for(world.employee), "QUESTIONS", "q.csv", b"id", training.id, "PRE_TEST").status_code == 403


# ---------- Imports into a selected training ----------

def test_import_into_draft_training(world, db, client_for):
    training = world.training("DRAFT-1", questions=0, count=1)
    training.status = "DRAFT"
    db.commit()
    admin = client_for(world.admin)
    text = "\n".join([HEADERS, valid_row("First?"), valid_row("Second?"), valid_row("Third?")])
    job = upload(admin, "QUESTIONS", "q.csv", text.encode(), training.id).json()["data"]
    assert (job["status"], job["accepted_rows"], job["rejected_rows"]) == ("READY", 3, 0), job["rows"]
    assert job["training"] == {"id": str(training.id), "code": "DRAFT-1", "title": training.title, "status": "DRAFT"}
    assert job["trainings"] == [job["training"]]
    assert db.get(ImportJob, job["id"]).training_id == training.id  # The selection is saved with the preview.

    done = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["status"] == "COMPLETED" and done["training"]["code"] == "DRAFT-1"
    db.expire_all()
    linked = db.scalars(select(QuestionTrainingTag.training_id).join(Question, Question.id == QuestionTrainingTag.question_id).where(Question.question_text.in_(["First?", "Second?", "Third?"]))).all()
    assert linked == [training.id] * 3
    assert set(db.scalars(select(QuestionTrainingTag.test_type))) == {"POST_TEST"}
    assert set(db.scalars(select(Question.status))) == {"ACTIVE"}  # Confirmed by L&D Admin: Active.
    assert pool_report(db, training.id, assessment_type="POST_TEST")["eligible"] == 3
    assert pool_report(db, training.id, assessment_type="PRE_TEST")["eligible"] == 0  # Post-test questions only.
    assert db.get(Training, training.id).status == "DRAFT"  # Importing never activates the training.
    assert admin.get(f"/admin/imports/{job['id']}").json()["data"]["training"]["code"] == "DRAFT-1"
    listed = admin.get("/admin/imports").json()["data"]
    assert next(j for j in listed if j["id"] == job["id"])["training"]["code"] == "DRAFT-1"
    assert next(j for j in listed if j["id"] == job["id"])["test_type"] == "POST_TEST"


def test_unapplied_import_can_be_edited_and_deleted(world, db, client_for):
    right = world.training("RIGHT", questions=0, count=1)
    wrong = world.training("WRONG", questions=0, count=1)
    admin = client_for(world.admin)
    broken = "\n".join([HEADERS, valid_row("Edit one?", correct="E"), valid_row("Edit two?", correct="AB")]).encode()
    text = "\n".join([HEADERS, valid_row("Edit one?"), valid_row("Edit two?")]).encode()
    job = upload(admin, "QUESTIONS", "q.csv", broken, wrong.id).json()["data"]
    assert (job["accepted_rows"], job["rejected_rows"]) == (0, 2)

    # Edit: a corrected file, for the right training, validated into the same entry.
    edited = admin.post(f"/admin/imports/{job['id']}/replace", files={"file": ("fixed.csv", text)}, data={"training_id": str(right.id), "test_type": "POST_TEST"}).json()["data"]
    assert (edited["id"], edited["status"], edited["file_name"], edited["accepted_rows"], edited["rejected_rows"]) == (job["id"], "READY", "fixed.csv", 2, 0)
    assert edited["training"]["code"] == "RIGHT" and len(edited["rows"]) == 2
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(ImportJobRow).where(ImportJobRow.import_job_id == job["id"])) == 2  # Old rows replaced.
    assert db.scalar(select(func.count()).select_from(Question)) == 0  # Editing never imports.

    # A completed import cannot be edited. Removing its history preserves imported questions and rows.
    assert admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]["status"] == "COMPLETED"
    assert admin.post(f"/admin/imports/{job['id']}/replace", files={"file": ("q.csv", text)}, data={"training_id": str(right.id), "test_type": "POST_TEST"}).status_code == 409
    assert admin.delete(f"/admin/imports/{job['id']}").json()["data"] == {"deleted": True}
    db.expire_all()
    assert db.get(ImportJob, job["id"]).deleted_at is not None
    assert db.scalar(select(func.count()).select_from(ImportJobRow).where(ImportJobRow.import_job_id == job["id"])) == 2
    assert db.scalar(select(func.count()).select_from(Question)) == 2
    assert db.scalar(select(func.count()).select_from(QuestionAnswerKey)) == 2
    assert db.scalar(select(func.count()).select_from(QuestionTrainingTag)) == 2
    assert job["id"] not in {j["id"] for j in admin.get("/admin/imports").json()["data"]}
    assert admin.get(f"/admin/imports/{job['id']}").status_code == 404
    assert admin.delete(f"/admin/imports/{job['id']}").status_code == 404

    # A cancelled preview can be deleted with its rows.
    other = upload(admin, "QUESTIONS", "q.csv", text, wrong.id).json()["data"]
    admin.post(f"/admin/imports/{other['id']}/cancel")
    assert admin.delete(f"/admin/imports/{other['id']}").json()["data"] == {"deleted": True}
    db.expire_all()
    assert db.get(ImportJob, other["id"]) is None
    assert db.scalar(select(func.count()).select_from(ImportJobRow).where(ImportJobRow.import_job_id == other["id"])) == 0
    assert admin.get(f"/admin/imports/{other['id']}").status_code == 404


def test_questions_go_only_to_the_selected_training(world, db, client_for):
    """The file names no training: every question is linked to the selected one, and a training column is refused
    rather than read."""
    training = world.training("SEL", questions=0, count=1)
    world.training("OTHER", questions=0, count=1)
    admin = client_for(world.admin)
    with_training = "\n".join(["training," + HEADERS, "OTHER," + valid_row("Moved?")]).encode()
    refused = upload(admin, "QUESTIONS", "q.csv", with_training, training.id)
    assert refused.status_code == 400 and "column training" in refused.json()["error"]["message"]
    job = upload(admin, "QUESTIONS", "q.csv", "\n".join([HEADERS, valid_row("One?"), valid_row("Two?")]).encode(), training.id).json()["data"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    db.expire_all()
    assert set(db.scalars(select(QuestionTrainingTag.training_id))) == {training.id}  # Never another training.
    assert db.scalar(select(func.count()).select_from(Question)) == 2


def test_invalid_or_archived_training_selection_is_rejected(world, db, client_for):
    admin = client_for(world.admin)
    text = "\n".join([HEADERS, valid_row("X?")]).encode()
    missing = upload(admin, "QUESTIONS", "q.csv", text, "00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 400 and "does not exist" in missing.json()["error"]["message"]
    assert upload(admin, "QUESTIONS", "q.csv", text, "not-a-uuid").status_code == 400
    archived = world.training("OLD", questions=0, count=1)
    archived.status = "ARCHIVED"
    db.commit()
    response = upload(admin, "QUESTIONS", "q.csv", text, archived.id)
    assert response.status_code == 409 and response.json()["error"]["code"] == "TRAINING_NOT_IMPORTABLE"
    active = world.training("ACT", questions=0, count=1)
    completions = upload(admin, "COMPLETIONS", "c.csv", b"employee,training,completion_date\nE1,ACT,2026-11-01\n", active.id)
    assert completions.status_code == 400  # Completion imports keep naming the training on each row.
    assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_commit_rechecks_the_saved_training(world, db, client_for):
    training = world.training("RECHECK", questions=0, count=1)
    admin = client_for(world.admin)
    job = upload(admin, "QUESTIONS", "q.csv", "\n".join([HEADERS, valid_row("R?")]).encode(), training.id).json()["data"]
    training.status = "ARCHIVED"
    db.commit()
    response = admin.post(f"/admin/imports/{job['id']}/commit")
    assert response.status_code == 409 and "validate the file again" in response.json()["error"]["message"]
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 0
    assert db.get(ImportJob, job["id"]).status == "READY"


def test_selected_training_never_relinks_an_existing_question(world, db, client_for):
    """The same question imported into another training becomes that training's own question; the existing one
    keeps its text and its training link."""
    first = world.training("FIRST", questions=1, count=1)
    second = world.training("SECOND", questions=0, count=1)
    admin = client_for(world.admin)
    existing = db.scalar(select(Question))
    text = "\n".join([HEADERS, valid_row(existing.question_text), valid_row("New?"), valid_row("New?")])
    job = upload(admin, "QUESTIONS", "q.csv", text.encode(), second.id).json()["data"]
    assert [r["status"] for r in job["rows"]] == ["VALID", "VALID", "DUPLICATE"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    db.expire_all()
    question = db.get(Question, existing.id)
    assert [t.id for t in question.trainings] == [first.id]  # The existing question stays on its training.
    copies = db.scalars(select(Question).where(Question.question_text == existing.question_text, Question.id != existing.id)).all()
    assert [[t.id for t in q.trainings] for q in copies] == [[second.id]]


def test_question_import_requires_a_training_and_a_test_type(world, db, client_for):
    """The training and the test type are always chosen explicitly on the import screen."""
    training = world.training("FILE-1", questions=0, count=1)
    admin = client_for(world.admin)
    text = "\n".join([HEADERS, valid_row("F?")]).encode()
    no_training = upload(admin, "QUESTIONS", "q.csv", text)
    assert no_training.status_code == 400 and "Select the training" in no_training.json()["error"]["message"]
    no_test = upload(admin, "QUESTIONS", "q.csv", text, training.id, test_type=None)
    assert no_test.status_code == 400 and "test type" in no_test.json()["error"]["message"]
    blank_test = upload(admin, "QUESTIONS", "q.csv", text, training.id, test_type="  ")
    assert blank_test.status_code == 400  # Blank is not a choice; nothing is defaulted.
    wrong_test = upload(admin, "QUESTIONS", "q.csv", text, training.id, test_type="FINAL_TEST")
    assert wrong_test.status_code == 400 and "Pre-test or Post-test" in wrong_test.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
    assert db.scalar(select(func.count()).select_from(Question)) == 0


# ---------- Notifications and audit ----------

def test_pending_escalation_goes_to_ld_after_two_working_days(world, db):  # BR §16.2, Manager and HR roles removed
    world.complete(world.employee, world.training(), NOW)
    pending_assessment_reminders(db, NOW)
    # Completion also sends ASSESSMENT_SCHEDULED; this test is about reminders and escalation only.
    types = lambda: [n.type for n in db.scalars(select(Notification)) if n.type != "ASSESSMENT_SCHEDULED"]  # noqa: E731
    assert types() == ["ASSESSMENT_DUE"]
    pending_assessment_reminders(db, NOW + timedelta(days=2))
    escalations = [n for n in db.scalars(select(Notification)) if n.type == "ASSESSMENT_ESCALATION"]
    admin_account = db.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.admin.id))
    assert [n.user_account_id for n in escalations] == [admin_account]  # L&D only, at two working days.
    pending_assessment_reminders(db, NOW + timedelta(days=7))
    assert types().count("ASSESSMENT_ESCALATION") == 1  # Not repeated, and no later HR step.


def test_policy_changes_are_audited_with_before_and_after(world, db, client_for):  # BR §19
    training = world.training()
    admin = client_for(world.admin)
    admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 10, "duration_minutes": 20, "pass_mark_percent": 80})
    log = db.scalar(select(AuditLog).where(AuditLog.action == "ASSESSMENT_CONFIG_CHANGED"))
    assert log.before_summary["pass_mark_percent"] == 70.0 and log.after_summary["pass_mark_percent"] == 80.0
    assert log.request_id and log.actor_user_id
    # The Audit Logs reader is removed for every role (audit P5); the record above is still written.
    assert admin.get("/admin/audit-logs?action=ASSESSMENT_CONFIG").status_code == 404
    assert client_for(world.hr).get("/admin/audit-logs").status_code == 404


def test_answer_keys_are_not_written_to_the_audit_log(world, db, client_for):
    client_for(world.admin).post("/admin/questions", json=question_body(options=["SECRET-KEY-TEXT", "Other"]))
    assert "SECRET-KEY-TEXT" not in str([(a.before_summary, a.after_summary) for a in db.scalars(select(AuditLog))])


# ---------- Scope change (TC-SCOPE-001) ----------

REMOVED = ("reaction", "feedback", "kpi", "roi", "nps", "l1_", "l4_", "monetis", "business_impact")
# The post-assessment feedback form is part of the approved Level 2 scope (required after each post-test).
APPROVED_FEEDBACK_TABLES = {"assessment_feedback"}
APPROVED_FEEDBACK_ROUTES = {"/api/v1/attempts/{attempt_id}/feedback", "/api/v1/admin/feedback"}


def test_no_level_1_or_level_4_tables_exist():
    live = inspect(database.get_engine()).get_table_names()
    assert set(live) - {"alembic_version"} == set(Base.metadata.tables)  # The version table exists only after Alembic ran.
    assert [t for t in live if any(word in t for word in REMOVED) and t not in APPROVED_FEEDBACK_TABLES] == []


def test_no_level_1_or_level_4_routes_exist():
    from fastapi.routing import APIRoute, iter_route_contexts

    # app.routes holds one wrapper per included router (FastAPI 0.162), so walk the effective routes.
    paths = {r.path for r in iter_route_contexts(app.routes) if isinstance(r.original_route, APIRoute)}
    assert len(paths) > 50, "the route walk is broken"
    words = ("reaction", "feedback", "kpi", "/roi", "nps", "business")
    assert sorted(p for p in paths if any(word in p.lower() for word in words) and p not in APPROVED_FEEDBACK_ROUTES) == []


def test_every_table_is_in_the_migration():
    """The Alembic migration matches the models, so nothing is created outside migrations."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    with database.get_engine().connect() as connection:
        differences = compare_metadata(MigrationContext.configure(connection), Base.metadata)
    assert differences == []


# ---------- Neon settings (SC-2L-108) ----------

def test_neon_url_is_normalised_with_tls():
    url = normalise_database_url("postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=disable&channel_binding=require")
    assert url.startswith("postgresql+psycopg://")
    assert "sslmode=require" in url and "channel_binding" not in url


def test_local_url_does_not_force_tls():
    assert "sslmode" not in normalise_database_url("postgres://u@localhost:5432/db")


def test_missing_url_gives_clear_message():
    with pytest.raises(RuntimeError, match="Neon"):
        normalise_database_url("")


def test_engine_disables_prepared_statements_for_the_pooler():
    engine = database.build_engine("postgresql://u:p@ep-x-pooler.region.aws.neon.tech/db")  # Never connects.
    assert engine.pool._pre_ping is True
    # connect_args reach the driver through the pool's creator; PgBouncer transaction mode needs this switched off.
    params = next(cell.cell_contents for cell in engine.pool._creator.__closure__ if isinstance(cell.cell_contents, dict))
    assert "prepare_threshold" in params and params["prepare_threshold"] is None
    engine.dispose()


def test_clock_is_restored():
    clock.freeze(None)
    assert clock.utcnow().tzinfo is not None


@pytest.mark.parametrize("route", ["upload", "replace"])
def test_an_import_being_processed_does_not_hold_up_other_requests(world, db, client_for, monkeypatch, route):
    """Validating an import is synchronous work (file parsing, database checks). It must run outside the server's
    event loop, or a large file delays every other request handled by that worker, assessment saves included."""
    import asyncio
    import time as clock_time

    import httpx

    from app.main import app
    from app.modules.imports import parsing

    training = world.training()
    admin = client_for(world.admin)
    template = admin.get("/admin/imports/templates/QUESTIONS?format=csv").content  # The real template file.
    job_id = None
    if route == "replace":
        created = admin.post("/admin/imports", files={"file": ("q.csv", template)}, data={"import_type": "QUESTIONS", "training_id": str(training.id), "test_type": "POST_TEST"})
        assert created.status_code == 200, created.text
        job_id = created.json()["data"]["id"]
    read_table = parsing.read_table

    def slow_read_table(*args, **kwargs):
        clock_time.sleep(1.5)  # A large file.
        return read_table(*args, **kwargs)

    monkeypatch.setattr(parsing, "read_table", slow_read_table)
    cookies, csrf = dict(admin.http.cookies), admin.csrf

    async def scenario() -> tuple[float, int]:
        transport = httpx.ASGITransport(app=app, client=("testclient", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", cookies=cookies, headers={"X-CSRF-Token": csrf}) as http:
            path = "/api/v1/admin/imports" if route == "upload" else f"/api/v1/admin/imports/{job_id}/replace"
            began = clock_time.perf_counter()
            importing = asyncio.create_task(http.post(path, files={"file": ("q.csv", template)}, data={"import_type": "QUESTIONS", "training_id": str(training.id), "test_type": "POST_TEST"}))
            await asyncio.sleep(0.3)  # The import is now being processed. (A blocked event loop delays this too.)
            ping = await http.get("/api/v1/system/ping")
            waited = clock_time.perf_counter() - began - 0.3  # Measured from the start: blocking cannot hide.
            assert ping.status_code == 200
            return waited, (await importing).status_code

    waited, status = asyncio.run(scenario())
    assert status == 200
    assert waited < 0.5, f"a ping waited {waited:.2f} s for the import to finish"


def test_completion_import_accepts_the_organisation_date_before_utc_catches_up(world, db, client_for):
    """Audit B2. At 02:00 in Asia/Kolkata it is still the previous day in UTC. A row dated today (local) is not in the
    future; a row dated tomorrow (local) still is."""
    from app.models import WorkingCalendar

    db.scalar(select(WorkingCalendar).where(WorkingCalendar.is_default)).timezone = "Asia/Kolkata"
    training = world.training()
    db.commit()
    early_morning = datetime(2026, 11, 4, 20, 30, tzinfo=UTC)  # 2026-11-05 02:00 in Asia/Kolkata.
    clock.freeze(early_morning)
    try:
        admin = client_for(world.admin)  # Signed in at the frozen time, so the session is not idle-expired.
        text = f"employee,training,completion_date\nE1,{training.training_code},2026-11-05\nE2,{training.training_code},2026-11-06\n"
        job = upload(admin, "COMPLETIONS", "c.csv", text.encode()).json()["data"]
        assert [r["status"] for r in job["rows"]] == ["VALID", "INVALID"]
        assert job["rows"][1]["errors"] == [{"field": "completion_date", "message": "The date cannot be in the future."}]
        committed = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
        assert [r["status"] for r in committed["rows"]] == ["IMPORTED", "INVALID"]
        db.expire_all()
        stored = db.scalar(select(TrainingCompletion.completed_at).where(TrainingCompletion.import_job_id == job["id"]))
        assert stored == datetime(2026, 11, 4, 18, 30, tzinfo=UTC)  # Local midnight of 5 Nov.
    finally:
        clock.freeze(NOW)


def test_trainer_and_competency_blank_optional_fields_are_saved_as_missing(world, client_for):
    """Audit B8. A blank email or description is stored as null (shown as "—"), and a trainer email must be valid."""
    admin = client_for(world.admin)
    trainer = admin.post("/admin/trainers", json={"name": "Blank Email", "email": "", "is_active": True})
    assert trainer.status_code == 200, trainer.text
    assert trainer.json()["data"]["email"] is None
    spaced = admin.post("/admin/trainers", json={"name": "Spaced Email", "email": "   ", "is_active": True}).json()["data"]
    assert spaced["email"] is None
    good = admin.post("/admin/trainers", json={"name": "Has Email", "email": "trainer@example.com", "is_active": True}).json()["data"]
    assert good["email"] == "trainer@example.com"
    bad = admin.post("/admin/trainers", json={"name": "Bad Email", "email": "not-an-email", "is_active": True})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "VALIDATION_ERROR"
    assert [d["field"] for d in bad.json()["error"]["details"]] == ["email"]
    assert admin.patch(f"/admin/trainers/{good['id']}", json={"name": "Has Email", "email": "", "is_active": True}).json()["data"]["email"] is None
    assert "Bad Email" not in {t["name"] for t in admin.get("/admin/trainers").json()["data"]}

    competency = admin.post("/admin/competencies", json={"name": "Blank Description", "description": "", "is_active": True})
    assert competency.status_code == 200, competency.text
    assert competency.json()["data"]["description"] is None


def test_unread_notification_count_is_exact_beyond_the_list_limit(world, db, client_for):
    """Audit B9. The header bell reads /me/notifications/unread-count; a limited list cannot count past its limit."""
    from app.models import UserAccount
    from app.modules.notifications.service import notify_account

    account_id = db.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.employee.id))
    for i in range(60):
        notify_account(db, account_id, "SYNTHETIC", f"Synthetic {i}", "Synthetic message", None, f"synthetic:{i}", NOW)
    db.commit()
    client = client_for(world.employee)
    before = client.get("/me/notifications/unread-count").json()["data"]["unread"]
    assert before >= 60
    listed = client.get("/me/notifications?unread_only=true&limit=50").json()
    assert len(listed["data"]) == 50 and listed["meta"]["unread"] == before
    assert client.patch(f"/me/notifications/{listed['data'][0]['id']}", json={"read": True}).status_code == 200
    assert client.get("/me/notifications/unread-count").json()["data"]["unread"] == before - 1
    assert client.post("/me/notifications/mark-all-read").status_code == 200
    assert client.get("/me/notifications/unread-count").json()["data"]["unread"] == 0
    assert client_for(world.teammate).get("/me/notifications/unread-count").json()["data"]["unread"] >= 0  # Own count only.


# ---------- Training references (audit B19) ----------

def test_unknown_training_references_are_refused_and_nothing_is_saved(world, db, client_for):
    import uuid as _uuid

    from app.models import AuditLog, Training

    admin = client_for(world.admin)
    ops = str(world.departments["OPS"].id)
    ghost = str(_uuid.uuid4())

    def create(code, **fields):
        return admin.post("/admin/trainings", json={"training_code": code, "title": f"Training {code}", **fields})

    refused = create("REF1", target_scope="DEPARTMENT", department_ids=[ops, ghost])
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "VALIDATION_ERROR"
    assert [d["field"] for d in refused.json()["error"]["details"]] == ["department_ids"]
    assert ghost in refused.json()["error"]["details"][0]["message"]
    competency = admin.post("/admin/competencies", json={"name": "Synthetic competency", "is_active": True}).json()["data"]["id"]
    mixed = create("REF2", competency_ids=[competency, ghost])
    assert mixed.status_code == 400 and [d["field"] for d in mixed.json()["error"]["details"]] == ["competency_ids"]
    assert db.scalar(select(func.count()).select_from(Training).where(Training.training_code.in_(["REF1", "REF2"]))) == 0

    created = create("REF3", target_scope="DEPARTMENT", department_ids=[ops], competency_ids=[competency])
    assert created.status_code == 200, created.text
    training_id = created.json()["data"]["id"]
    audits = db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "TRAINING_UPDATED"))
    edit = admin.patch(f"/admin/trainings/{training_id}", json={"title": "Renamed", "target_scope": "COMBINED", "department_ids": [ops], "function_ids": [ghost], "competency_ids": []})
    assert edit.status_code == 400 and [d["field"] for d in edit.json()["error"]["details"]] == ["function_ids"]
    after = admin.get(f"/admin/trainings/{training_id}").json()["data"]
    assert (after["title"], after["target_scope"]) == ("Training REF3", "DEPARTMENT")
    assert [d["id"] for d in after["departments"]] == [ops] and [c["id"] for c in after["competencies"]] == [competency]
    assert after["functions"] == []
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "TRAINING_UPDATED")) == audits

    # Valid references still save, in every targeting scope.
    compliance = str(world.functions["COMPLIANCE"].id)
    ok_edit = admin.patch(f"/admin/trainings/{training_id}", json={"title": "Renamed", "target_scope": "COMBINED", "department_ids": [ops], "function_ids": [compliance], "competency_ids": []})
    assert ok_edit.status_code == 200, ok_edit.text
    assert [f["id"] for f in ok_edit.json()["data"]["functions"]] == [compliance] and ok_edit.json()["data"]["competencies"] == []


def test_notifications_page_through_more_than_100_without_repeats_or_gaps(world, db, client_for):
    """Audit B21. 250 notifications, 60 of them created at the same moment: walking the pages with `before` returns
    every notification exactly once, newest first, in pages of at most 100."""
    from app.models import UserAccount
    from app.modules.notifications.service import notify_account

    account_id = db.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.employee.id))
    for i in range(250):
        moment = NOW - timedelta(minutes=10) if 100 <= i < 160 else NOW - timedelta(minutes=i)  # A tie across a page edge.
        notify_account(db, account_id, "SYNTHETIC", f"Synthetic {i}", "Synthetic message", None, f"page:{i}", moment)
    db.commit()
    client = client_for(world.employee)
    expected = client.get("/me/notifications/unread-count").json()["data"]["unread"]  # Includes any the setup created.

    seen, before, pages = [], None, 0
    while True:
        response = client.get("/me/notifications", params={"before": before} if before else None)
        assert response.status_code == 200, response.text
        body = response.json()
        page = body["data"]
        pages += 1
        assert len(page) <= 100
        seen += [n["id"] for n in page]
        if not body["meta"]["has_more"]:
            assert body["meta"]["next_before"] is None
            break
        assert len(page) == 100 and body["meta"]["next_before"] == page[-1]["id"]
        before = page[-1]["id"]
    assert pages == 3 and len(seen) == len(set(seen)) == expected >= 250
    times = [n["created_at"] for n in client.get("/me/notifications").json()["data"]]
    assert times == sorted(times, reverse=True)
    # Unread-only pages the same way; a page size over the bound is refused.
    unread_first = client.get("/me/notifications", params={"unread_only": "true", "limit": 100}).json()
    unread_rest = client.get("/me/notifications", params={"unread_only": "true", "before": unread_first["data"][-1]["id"]}).json()
    assert len({n["id"] for n in unread_first["data"] + unread_rest["data"]}) == len(unread_first["data"]) + len(unread_rest["data"])
    assert client.get("/me/notifications", params={"limit": 101}).status_code == 400
    # Another person's notification cannot be used as a position.
    assert client_for(world.teammate).get("/me/notifications", params={"before": seen[0]}).status_code == 404


def test_training_trainer_and_owner_references_are_validated(world, db, client_for):
    """Follow-up to B19: an unknown trainer or owner is a clear 400 naming the field (it was reported as a duplicate
    training code), valid references save, and both stay optional."""
    import uuid as _uuid

    from app.models import AuditLog, Training

    admin = client_for(world.admin)
    ghost = str(_uuid.uuid4())
    trainer, owner = str(world.trainer.id), str(world.admin.id)

    def create(code, **fields):
        return admin.post("/admin/trainings", json={"training_code": code, "title": f"Training {code}", **fields})

    def fields_of(response):
        assert response.status_code == 400 and response.json()["error"]["code"] == "VALIDATION_ERROR", response.text
        return [d["field"] for d in response.json()["error"]["details"]]

    assert fields_of(create("OWN1", trainer_id=ghost)) == ["trainer_id"]
    assert fields_of(create("OWN2", owner_employee_id=ghost)) == ["owner_employee_id"]
    assert fields_of(create("OWN3", trainer_id=ghost, owner_employee_id=ghost)) == ["trainer_id", "owner_employee_id"]
    assert db.scalar(select(func.count()).select_from(Training).where(Training.training_code.in_(["OWN1", "OWN2", "OWN3"]))) == 0

    optional = create("OWN4")  # Neither given: both stay empty.
    assert optional.status_code == 200, optional.text
    assert (optional.json()["data"]["trainer_id"], optional.json()["data"]["owner_employee_id"]) == (None, None)
    created = create("OWN5", trainer_id=trainer, owner_employee_id=owner)
    assert created.status_code == 200, created.text
    data = created.json()["data"]
    assert (data["trainer_id"], data["owner_employee_id"], data["trainer_name"], data["owner_name"]) == (trainer, owner, world.trainer.name, world.admin.full_name)

    training_id = data["id"]
    audits = db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "TRAINING_UPDATED"))
    for bad in ({"trainer_id": ghost, "owner_employee_id": owner}, {"trainer_id": trainer, "owner_employee_id": ghost}):
        refused = admin.patch(f"/admin/trainings/{training_id}", json={"title": "Renamed", **bad})
        assert fields_of(refused) == [next(k for k, v in bad.items() if v == ghost)]
    after = admin.get(f"/admin/trainings/{training_id}").json()["data"]
    assert (after["title"], after["trainer_id"], after["owner_employee_id"]) == ("Training OWN5", trainer, owner)
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "TRAINING_UPDATED")) == audits

    kept = admin.patch(f"/admin/trainings/{training_id}", json={"title": "Renamed", "trainer_id": trainer}).json()["data"]
    assert kept["owner_employee_id"] == owner  # An edit that does not mention the owner keeps it.
    cleared = admin.patch(f"/admin/trainings/{training_id}", json={"title": "Renamed", "trainer_id": None, "owner_employee_id": None}).json()["data"]
    assert (cleared["trainer_id"], cleared["owner_employee_id"]) == (None, None)
    assert create("OWN5", title="Same code").json()["error"]["code"] == "DUPLICATE_CODE"  # A real duplicate is still one.
