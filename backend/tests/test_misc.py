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
    Notification,
    Question,
    QuestionAnswerKey,
    QuestionRevision,
    Training,
    WorkingCalendar,
)
from app.modules.assessment.scheduling import CalendarView, calculate_due_at
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
    assert attempt["monitored"] is False and attempt["require_fullscreen"] is False
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


# ---------- Scheduling ----------

class Config:
    def __init__(self, mode, delay=0, working=False):
        self.schedule_mode, self.schedule_delay_days, self.schedule_uses_working_days = mode, delay, working


CALENDAR = CalendarView("UTC", [0, 1, 2, 3, 4], {date(2026, 11, 9)})
FRIDAY = datetime(2026, 11, 6, 15, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("config", "expected"),
    [
        (Config("SAME_DAY"), FRIDAY),
        (Config("NEXT_WORKING_DAY"), datetime(2026, 11, 10, tzinfo=UTC)),  # Weekend and the Monday holiday are skipped.
        (Config("DELAY_DAYS", 3), datetime(2026, 11, 9, tzinfo=UTC)),
        (Config("DELAY_DAYS", 2, True), datetime(2026, 11, 11, tzinfo=UTC)),
    ],
)
def test_due_date_policies(config, expected):  # MVP-009
    assert calculate_due_at(CALENDAR, FRIDAY, config) == expected


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
    assert admin.patch("/admin/calendar", json={"name": "Bad", "timezone": "Not/AZone", "working_weekdays": [0]}).status_code == 409
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


def test_materials_batches_sessions_and_trainers(world, client_for):
    admin = client_for(world.admin)
    training = world.training()
    assert admin.post(f"/admin/trainings/{training.id}/materials", json={"title": "Deck", "url": "http://not-secure.example"}).status_code == 400
    material = admin.post(f"/admin/trainings/{training.id}/materials", json={"kind": "RECORDING", "title": "Recording", "url": "https://example.com/r"})
    assert material.status_code == 200, material.text
    # Batches & Sessions is withdrawn from L&D Admin: existing batches stay listed, creating them is refused.
    batches = admin.get(f"/admin/batches?training_id={training.id}").json()["data"]
    assert [b["batch_code"] for b in batches] == ["B1"]
    assert admin.post("/admin/batches", json={"training_id": str(training.id), "name": "Batch 2", "start_date": "2026-11-10", "end_date": "2026-11-11"}).status_code == 403
    assert admin.post(f"/admin/batches/{batches[0]['id']}/sessions", json={"title": "Day 1", "session_date": "2026-11-10"}).status_code == 403
    assert admin.post("/admin/trainers", json={"name": "New Trainer"}).status_code == 200
    assert admin.post("/admin/functions", json={"code": "RISK", "name": "Risk"}).status_code == 200
    assert admin.post("/admin/functions", json={"code": "RISK", "name": "Risk again"}).status_code == 409


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

    edited = admin.patch(f"/admin/questions/{created['id']}", json=question_body(question_text="A better question?", options=["A", "B", "C"], correct_option_indexes=[2], training_ids=[str(training.id)])).json()["data"]
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

HEADERS = "id,training,topic,competency,type,question,option_a,option_b,option_c,option_d,options_extra,correct,explanation,difficulty,marks,level,language,active"


def upload(client, kind, name, content):
    return client.post("/admin/imports", files={"file": (name, content)}, data={"import_type": kind})


def valid_row(code="IMP-1", training="T1", **changes):
    row = {"id": code, "training": training, "topic": "Topic", "competency": "New competency", "type": "single", "question": "Which is right?", "option_a": "Right", "option_b": "Wrong", "option_c": "", "option_d": "", "options_extra": "", "correct": "A", "explanation": "Because.", "difficulty": "Easy", "marks": "1", "level": "L2", "language": "English", "active": "Active"}
    row.update(changes)
    return ",".join(row[h] for h in HEADERS.split(","))


def test_question_import_validates_previews_then_commits(world, db, client_for):  # TC-IMP-001, -002, -005
    world.training(questions=0, count=1)
    admin = client_for(world.admin)
    text = "\n".join([HEADERS, valid_row(), valid_row("IMP-2", training="NOPE"), valid_row("IMP-3", correct="Z"), valid_row("IMP-4", marks="-1"), valid_row("IMP-5", type="essay")])
    job = upload(admin, "QUESTIONS", "questions.csv", text.encode()).json()["data"]
    assert (job["status"], job["accepted_rows"], job["rejected_rows"]) == ("READY", 1, 4)
    statuses = {r["row"]: r for r in job["rows"]}
    assert statuses[2]["status"] == "VALID"
    assert statuses[3]["errors"][0]["field"] == "training"
    assert statuses[4]["errors"][0]["field"] == "correct"
    assert db.scalar(select(func.count()).select_from(Question)) == 0  # Nothing is applied before commit.

    report = admin.get(f"/admin/imports/{job['id']}/error-report")
    assert report.status_code == 200 and "training" in report.text

    done = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["status"] == "COMPLETED_WITH_ERRORS" and done["accepted_rows"] == 1
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 1
    assert admin.post(f"/admin/imports/{job['id']}/commit").status_code == 409


def test_duplicate_question_id_is_never_overwritten(world, db, client_for):  # TC-IMP-003
    world.training(questions=1, count=1)
    admin = client_for(world.admin)
    original = db.scalar(select(Question))
    text = "\n".join([HEADERS, valid_row(original.question_code, question="Overwrite attempt?"), valid_row("IMP-A"), valid_row("IMP-A")])
    job = upload(admin, "QUESTIONS", "q.csv", text.encode()).json()["data"]
    assert [r["status"] for r in job["rows"]] == ["DUPLICATE", "VALID", "DUPLICATE"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    db.expire_all()
    assert db.get(Question, original.id).question_text != "Overwrite attempt?"


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
    response = upload(client_for(world.admin), "QUESTIONS", name, content)
    assert response.status_code == 400 and response.json()["error"]["code"] == "INVALID_FILE"


def test_formula_cells_and_macros_are_rejected(world, client_for):  # TC-IMP-004
    world.training(questions=0, count=1)
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

    csv_formula = "\n".join([HEADERS, valid_row("IMP-F", question="=HYPERLINK('x')")]).encode()
    job = upload(admin, "QUESTIONS", "f.csv", csv_formula).json()["data"]
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

    replay = upload(admin, "COMPLETIONS", "c.csv", text.encode()).json()["data"]
    assert replay["rows"][0]["status"] == "DUPLICATE"
    admin.post(f"/admin/imports/{replay['id']}/commit")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AssessmentObligation)) == 1


def test_templates_download_and_import_cleanly(world, db, client_for):
    world.training("T001", questions=0, count=1)
    admin = client_for(world.admin)
    csv_template = admin.get("/admin/imports/templates/QUESTIONS")
    xlsx_template = admin.get("/admin/imports/templates/QUESTIONS?format=xlsx")
    assert xlsx_template.content.startswith(b"PK")
    job = upload(admin, "QUESTIONS", "template.csv", csv_template.content).json()["data"]
    assert job["accepted_rows"] == 1, job
    job = upload(admin, "QUESTIONS", "template.xlsx", xlsx_template.content).json()["data"]
    assert job["accepted_rows"] == 1, job


@pytest.mark.skipif(not (SAMPLES / "questions-valid.xlsx").exists(), reason="Prototype samples not present")
@pytest.mark.parametrize("name", ["questions-valid.csv", "questions-valid.xlsx"])
def test_prototype_sample_question_files_import(world, db, client_for, name):  # "Use the existing import template"
    for code in ("T001", "T002", "T003"):
        world.training(code, questions=0, count=1)
    admin = client_for(world.admin)
    job = upload(admin, "QUESTIONS", name, (SAMPLES / name).read_bytes()).json()["data"]
    assert job["rejected_rows"] == 0, job["rows"]
    assert job["accepted_rows"] >= 10
    done = admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]
    assert done["status"] == "COMPLETED"


def test_employee_cannot_import(world, client_for):
    assert upload(client_for(world.hr), "QUESTIONS", "q.csv", b"id").status_code == 403


# ---------- Notifications and audit ----------

def test_pending_escalation_after_two_and_five_working_days(world, db):  # BR §16.2
    world.complete(world.employee, world.training(), NOW)
    pending_assessment_reminders(db, NOW)
    # Completion also sends ASSESSMENT_SCHEDULED; this test is about reminders and escalation only.
    types = lambda: [n.type for n in db.scalars(select(Notification)) if n.type != "ASSESSMENT_SCHEDULED"]  # noqa: E731
    assert types() == ["ASSESSMENT_DUE"]
    pending_assessment_reminders(db, NOW + timedelta(days=2))
    assert types().count("ASSESSMENT_ESCALATION") == 1  # The manager, at two working days.
    pending_assessment_reminders(db, NOW + timedelta(days=2))
    assert types().count("ASSESSMENT_ESCALATION") == 1  # Not repeated.
    pending_assessment_reminders(db, NOW + timedelta(days=7))
    assert types().count("ASSESSMENT_ESCALATION") == 3  # Then L&D and HR.


def test_policy_changes_are_audited_with_before_and_after(world, db, client_for):  # BR §19
    training = world.training()
    admin = client_for(world.admin)
    admin.post(f"/admin/trainings/{training.id}/assessment-configs", json={"question_count": 10, "duration_minutes": 20, "pass_mark_percent": 80})
    log = db.scalar(select(AuditLog).where(AuditLog.action == "ASSESSMENT_CONFIG_CHANGED"))
    assert log.before_summary["pass_mark_percent"] == 70.0 and log.after_summary["pass_mark_percent"] == 80.0
    assert log.request_id and log.actor_user_id
    # The Audit Logs reader is withdrawn from every role; the record above is still written.
    assert admin.get("/admin/audit-logs?action=ASSESSMENT_CONFIG").status_code == 403
    assert client_for(world.hr).get("/admin/audit-logs").status_code == 403


def test_answer_keys_are_not_written_to_the_audit_log(world, db, client_for):
    client_for(world.admin).post("/admin/questions", json=question_body(options=["SECRET-KEY-TEXT", "Other"]))
    assert "SECRET-KEY-TEXT" not in str([(a.before_summary, a.after_summary) for a in db.scalars(select(AuditLog))])


# ---------- Scope change (TC-SCOPE-001) ----------

REMOVED = ("reaction", "feedback", "kpi", "roi", "nps", "l1_", "l4_", "monetis", "business_impact")


def test_no_level_1_or_level_4_tables_exist():
    live = inspect(database.get_engine()).get_table_names()
    assert set(Base.metadata.tables) | {"alembic_version"} == set(live)
    assert [t for t in live if any(word in t for word in REMOVED)] == []


def test_no_level_1_or_level_4_routes_exist():
    paths = [r.path for r in app.routes if hasattr(r, "methods")]
    assert [p for p in paths if any(word in p.lower() for word in ("reaction", "feedback", "kpi", "/roi", "nps", "business"))] == []


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
    engine = database.build_engine("postgresql://u:p@ep-x-pooler.region.aws.neon.tech/db")
    assert engine.pool._pre_ping is True
    assert engine.dialect.create_connect_args(engine.url) is not None
    engine.dispose()


def test_clock_is_restored():
    clock.freeze(None)
    assert clock.utcnow().tzinfo is not None
