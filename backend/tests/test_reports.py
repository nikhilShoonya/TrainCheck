"""Reports, scorecard and exports. TC-REP-*, TC-KIR-010, SC-2L-101, SC-2L-102."""
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import select

from app.models import AuditLog, Question
from app.modules.reports.exports import safe_text
from tests.conftest import NOW, give_feedback, take

CODES = ["compliance", "pass-fail", "learning-gain", "behaviour", "question-analytics", "employee-history", "scorecard"]
FORMATS = ["CSV", "XLSX", "PDF"]


def fixture_data(world, db, client_for):
    training = world.training(pass_mark=Decimal("70"))
    world.template(training)
    passed = world.complete(world.employee, training, NOW - timedelta(days=5))
    failed = world.complete(world.teammate, training, NOW - timedelta(days=5))
    other = world.complete(world.outsider, training, NOW - timedelta(days=5))
    for person, obligation, correct in ((world.employee, passed, 9), (world.teammate, failed, 4), (world.outsider, other, 8)):
        client = client_for(person)
        give_feedback(client, take(db, client, obligation.id, correct)["attempt_id"])  # Required before the workspace opens.
    return training


def rows_as_dicts(report: dict) -> list[dict]:
    return [dict(zip(report["columns"], row, strict=True)) for row in report["rows"]]


@pytest.mark.parametrize("code", CODES)
def test_all_seven_reports_load(world, db, client_for, code):  # TC-REP-011
    fixture_data(world, db, client_for)
    response = client_for(world.admin).get(f"/reports/{code}")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["columns"] and data["title"] and data["definitions"]


@pytest.mark.parametrize("code", CODES)
@pytest.mark.parametrize("fmt", FORMATS)
def test_exports_generate_and_download(world, db, client_for, code, fmt):  # TC-REP-003, -004, -011
    fixture_data(world, db, client_for)
    client = client_for(world.admin)
    response = client.post("/reports/exports", json={"report_code": code, "export_format": fmt})
    assert response.status_code == 200, response.text
    export = response.json()["data"]
    download = client.get(f"/reports/exports/{export['id']}/download")
    assert download.status_code == 200
    magic = {"CSV": b"\xef\xbb\xbf", "XLSX": b"PK", "PDF": b"%PDF"}[fmt]
    assert download.content.startswith(magic)


@pytest.mark.parametrize("code", ["reaction", "kpi-impact", "roi", "reaction-summary"])
def test_withdrawn_reports_do_not_exist(world, client_for, code):  # TC-REP-012
    assert client_for(world.admin).get(f"/reports/{code}").status_code == 404


def test_pass_fail_reconciles_to_attempts(world, db, client_for):  # TC-REP-002
    fixture_data(world, db, client_for)
    rows = rows_as_dicts(client_for(world.admin).get("/reports/pass-fail").json()["data"])
    by_person = {r["Employee ID"]: r for r in rows}
    assert by_person["E1"]["Result"] == "PASSED" and by_person["E1"]["First Score %"] == 90.0
    assert by_person["E2"]["Result"] == "NOT_PASSED" and by_person["E2"]["Red Flag"] == "Yes"
    assert by_person["E2"]["Attempts"] == 1


def test_filters_apply_consistently(world, db, client_for):  # TC-REP-001, PRD-REPORT-013
    fixture_data(world, db, client_for)
    other = world.training("T2")
    world.enrol(world.employee, other)
    admin = client_for(world.admin)
    cx = rows_as_dicts(admin.get(f"/reports/compliance?department_id={world.departments['CX'].id}").json()["data"])
    assert {r["Employee ID"] for r in cx} == {"E3"}
    grade = rows_as_dicts(admin.get("/reports/compliance?grade=NONE").json()["data"])
    assert grade == []
    by_training = rows_as_dicts(admin.get(f"/reports/compliance?training_id={other.id}").json()["data"])
    assert {r["Training"] for r in by_training} == {other.title}
    assert "Manager" not in admin.get("/reports/compliance").json()["data"]["columns"]  # Reporting lines are no longer read.
    future = rows_as_dicts(admin.get(f"/reports/compliance?date_from={(NOW + timedelta(days=1)).date()}").json()["data"])
    assert future == []
    by_trainer = rows_as_dicts(admin.get(f"/reports/compliance?trainer_id={world.trainer.id}").json()["data"])
    assert len(by_trainer) == 4
    assert rows_as_dicts(admin.get(f"/reports/compliance?location_id={world.location.id}").json()["data"])


def test_export_permissions(world, db, client_for):  # TC-REP-005, SEC-009
    fixture_data(world, db, client_for)
    employee = client_for(world.employee)
    assert employee.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).status_code == 403
    assert employee.get("/reports/pass-fail").status_code == 403
    assert employee.post("/reports/exports", json={"report_code": "employee-history", "export_format": "CSV"}).status_code == 403
    assert employee.get("/reports/employee-history").status_code == 403  # Assessment History was removed.
    assert employee.get("/reports/catalogue").json()["data"] == []

    second_admin = world.person("A2", "admin2@test.example", ["LD_ADMIN", "EMPLOYEE"])
    world.db.commit()
    private = client_for(second_admin).post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).json()["data"]
    assert employee.get(f"/reports/exports/{private['id']}/download").status_code == 404
    assert client_for(world.admin).get(f"/reports/exports/{private['id']}/download").status_code == 404  # Only the owner downloads.
    assert db.scalar(select(AuditLog).where(AuditLog.action == "REPORT_EXPORTED")) is not None


def test_spreadsheet_formula_is_neutralised():  # Security §12
    assert safe_text("=HYPERLINK('http://x')") == "'=HYPERLINK('http://x')"
    assert safe_text("+cmd") == "'+cmd"
    assert safe_text("Normal") == "Normal"
    assert safe_text(-5) == -5
    assert safe_text("NOT_PASSED") == "Not Passed"


def test_item_difficulty_and_review_flag(world, db, client_for):  # TC-REP-006, -007, -008
    training = world.training(questions=1, count=1)
    obligations = [world.complete(p, training) for p in (world.employee, world.teammate, world.outsider, world.manager)]
    take(db, client_for(world.employee), obligations[0].id, 1)
    for person, obligation in zip((world.teammate, world.outsider, world.manager), obligations[1:], strict=True):
        take(db, client_for(person), obligation.id, 0)
    rows = rows_as_dicts(client_for(world.admin).get("/reports/question-analytics").json()["data"])
    assert rows[0]["Responses"] == 4
    assert rows[0]["Correct %"] == 25.0 and rows[0]["Incorrect %"] == 75.0
    assert rows[0]["Review Flag"] == "Review required"  # Above 70% incorrect with the minimum sample met.

    training.item_minimum_sample = 50
    db.commit()
    rows = rows_as_dicts(client_for(world.admin).get("/reports/question-analytics").json()["data"])
    assert rows[0]["Review Flag"] == "Insufficient sample"


def test_blank_answers_are_excluded_from_item_analysis(world, db, client_for):  # BR §15.3
    from tests.conftest import start, submit

    training = world.training(questions=1, count=1)
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    submit(client, start(client, obligation.id)["attempt_id"])
    assert client_for(world.admin).get("/reports/question-analytics").json()["data"]["rows"] == []
    assert db.scalar(select(Question).limit(1)) is not None


def test_scorecard_has_only_learning_and_behaviour(world, db, client_for):  # TC-KIR-010, SC-2L-101
    training = fixture_data(world, db, client_for)
    card = client_for(world.admin).get(f"/scorecards/{training.id}").json()["data"]
    assert set(card) == {"training", "generated_at", "learning", "behaviour", "interpretation"}
    learning = card["learning"]
    assert learning["state"] == "Available"
    assert learning["assessed"] == 3 and learning["pass_rate"] == 66.7
    assert learning["first_attempt_mean"] == 70.0
    assert learning["failed_attempts"] == 1
    assert learning["pre_test_state"] == "Not configured"
    assert card["behaviour"]["state"] == "Not yet due"
    assert card["behaviour"]["self_mean"] is None  # Missing is None, never 0.
    assert "effectiveness" not in str(card).lower()
    for term in ("reaction", "kpi", "roi"):
        assert term not in {k.lower() for k in {**card, **learning, **card["behaviour"]}}


def test_scorecard_states_change_with_evidence(world, db, client_for):
    training = world.training(schedule_mode="DELAY_DAYS", schedule_delay_days=30)
    world.template(training)
    admin = client_for(world.admin)
    assert admin.get(f"/scorecards/{training.id}").json()["data"]["learning"]["state"] == "Not collected"
    world.complete(world.employee, training, NOW - timedelta(days=1))
    assert admin.get(f"/scorecards/{training.id}").json()["data"]["learning"]["state"] == "Not yet due"


def test_scorecard_learning_incomplete_when_some_results_missing(world, db, client_for):
    training = world.training()
    done = world.complete(world.employee, training)
    world.complete(world.teammate, training)
    take(db, client_for(world.employee), done.id, 8)
    assert client_for(world.admin).get(f"/scorecards/{training.id}").json()["data"]["learning"]["state"] == "Incomplete"


def test_scorecards_and_filter_options_are_ld_only(world, db, client_for):
    training = fixture_data(world, db, client_for)
    for person in (world.employee, world.manager, world.hr):
        assert client_for(person).get(f"/scorecards/{training.id}").status_code == 403
        assert client_for(person).get("/reports/filter-options").status_code == 403
    options = client_for(world.admin).get("/reports/filter-options").json()["data"]
    assert [d["name"] for d in options["departments"]] == ["Cx", "Ops"]
    assert "managers" not in options


def test_scheduled_report_delivery_and_history(world, db, client_for):  # PRD-REPORT-014, P3-010
    from app.core import clock
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    assert client_for(world.manager).post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).status_code == 403
    client = client_for(world.admin)
    created = client.post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    assert run_due_schedules(db, NOW) == 0

    later = NOW + timedelta(days=8)
    assert run_due_schedules(db, later) == 1
    assert run_due_schedules(db, later) == 0  # Running again does not deliver twice.

    clock.freeze(NOW + timedelta(days=8))
    client = client_for(world.admin)
    schedule = next(s for s in client.get("/reports/schedules").json()["data"] if s["id"] == created["id"])
    assert schedule["deliveries"][0]["status"] == "DELIVERED"
    notes = client.get("/me/notifications").json()["data"]
    ready = [n for n in notes if n["type"] == "REPORT_READY"]
    assert ready
    # Audit B4: the link opens the Reports page that lists downloads (there is no /reports/downloads page).
    assert {n["link"] for n in ready} == {"/lnd/reports"}
    frontend_pages = Path(__file__).resolve().parents[2] / "frontend" / "src" / "app" / "(workspace)"
    if frontend_pages.exists():
        assert (frontend_pages / "lnd" / "reports" / "page.tsx").exists()
    export_id = schedule["deliveries"][0]["export_id"]
    content = client.get(f"/reports/exports/{export_id}/download").content
    assert b"E1" in content and b"Organisation" in content  # The delivered file keeps the owner's scope.


def test_only_report_users_can_schedule(world, client_for):
    client = client_for(world.employee)
    assert client.post("/reports/schedules", json={"report_code": "pass-fail", "cadence": "WEEKLY"}).status_code == 403


def test_dashboards_keep_missing_values_as_none(world, client_for):
    assert client_for(world.admin).get("/admin/dashboard").json()["data"]["summary"]["pass_rate"] is None
    assert client_for(world.employee).get("/me/dashboard").json()["data"]["overall_score"] is None


def test_all_role_dashboards_load_with_data(world, db, client_for):
    fixture_data(world, db, client_for)
    assert client_for(world.admin).get("/admin/dashboard").json()["data"]["total_employees"] == 7
    org = client_for(world.admin).get("/reports/organisation-summary").json()["data"]
    assert org["summary"]["assessed"] == 3 and org["trend"]
    own = client_for(world.employee).get("/me/dashboard").json()["data"]
    assert own["overall_score"] == 90.0
    assert client_for(world.employee).get("/me/certificates").status_code == 404  # Certificates were removed from the product.
    assert client_for(world.teammate).get("/me/refresher-materials").json()["data"][0]["refresher_text"]


def test_analytics(world, db, client_for, behaviour_on):  # Legacy Level 3 trend; needs Behaviour on.
    fixture_data(world, db, client_for)
    admin = client_for(world.admin)
    data = admin.get("/reports/analytics").json()["data"]
    assert {d["department"] for d in data["departments"]} == {"Ops", "Cx"}
    assert {f["function"] for f in data["functions"]} == {"Compliance", "Sales"}
    assert data["topics"] and data["behaviour_trend"]
    assert data["behaviour_trend"][0]["self_mean"] is None  # No ratings yet: missing, not zero.
    assert admin.get("/reports/manager-evaluation").status_code == 404  # Removed with the Manager role.
    assert client_for(world.other_manager).get("/reports/analytics").status_code == 403


def test_personal_history_export_and_page_api_are_retired(world, db, client_for):  # Assessment History removed
    fixture_data(world, db, client_for)
    for person in (world.employee, world.manager, world.hr, world.admin):
        client = client_for(person)
        assert client.post("/reports/exports", json={"report_code": "employee-history", "export_format": "CSV", "own_record": True}).status_code == 403
    assert client_for(world.employee).get("/me/history").status_code == 404


def test_scorecard_list_and_filter_options_do_not_load_every_record(world, db, client_for, monkeypatch):
    """Dropdowns and the scorecard list need names only, not every enrolment and attempt (audit F-12)."""
    from app.modules.reports import router as reports_router

    fixture_data(world, db, client_for)
    admin = client_for(world.admin)
    expected_options = admin.get("/reports/filter-options").json()["data"]
    expected_cards = admin.get("/scorecards").json()["data"]

    def refuse(*_args, **_kwargs):
        raise AssertionError("loaded every enrolment and attempt")

    monkeypatch.setattr(reports_router, "load_rows", refuse)
    assert admin.get("/reports/filter-options").json()["data"] == expected_options
    assert admin.get("/scorecards").json()["data"] == expected_cards


def test_employee_pages_do_not_query_once_per_training(world, db, client_for):
    """The employee's own pages cost the same number of queries for 3 trainings as for 6 (audit F-22)."""
    from sqlalchemy import event

    from app.core import db as database
    from app.models import TrainingMaterial

    def add_trainings(codes):
        for code in codes:
            training = world.training(code)
            db.add(TrainingMaterial(training_id=training.id, kind="LINK", title=f"Guide {code}", url="https://example.com/guide"))
            db.commit()
            obligation = world.complete(world.employee, training)
            obligation.status = "WAIVED"
            db.commit()

    def statements_for(path: str) -> int:
        client = client_for(world.employee)
        seen = {"n": 0}

        def count(*_args, **_kwargs):
            seen["n"] += 1

        event.listen(database.get_engine(), "before_cursor_execute", count)
        try:
            assert client.get(path).status_code == 200
        finally:
            event.remove(database.get_engine(), "before_cursor_execute", count)
        return seen["n"]

    add_trainings(["N1", "N2", "N3"])
    small = {path: statements_for(path) for path in ("/me/trainings", "/me/scorecard", "/me/dashboard")}
    add_trainings(["N4", "N5", "N6"])
    large = {path: statements_for(path) for path in ("/me/trainings", "/me/scorecard", "/me/dashboard")}
    assert large == small, (small, large)


# ---------- Dates in the organisation timezone (audit B1) ----------
# The test calendar is UTC, which hid these: in Asia/Kolkata a completion recorded for a past date is stored as local
# midnight, the previous day in UTC.


def _organisation_timezone(db, name: str = "Asia/Kolkata") -> None:
    from app.models import WorkingCalendar

    db.scalar(select(WorkingCalendar).where(WorkingCalendar.is_default)).timezone = name
    db.commit()


def _complete_on(world, client, training, local_date: str) -> None:
    enrolment = world.enrol(world.employee, training)
    response = client.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": local_date})
    assert response.status_code == 200, response.text


def test_report_date_filters_and_dates_use_the_organisation_date(world, db, client_for):
    _organisation_timezone(db)
    admin = client_for(world.admin)
    _complete_on(world, admin, world.training(), "2026-11-02")  # Stored as 2026-11-01 18:30 UTC.

    same_day = rows_as_dicts(admin.get("/reports/compliance?date_from=2026-11-02&date_to=2026-11-02").json()["data"])
    assert [r["Completed"] for r in same_day] == ["02-11-2026"]
    assert rows_as_dicts(admin.get("/reports/compliance?date_from=2026-11-01&date_to=2026-11-01").json()["data"]) == []
    pass_fail = rows_as_dicts(admin.get("/reports/pass-fail?date_from=2026-11-02").json()["data"])
    assert [r["Completion Date"] for r in pass_fail] == ["02-11-2026"]


def test_monthly_trend_counts_the_first_of_the_month_in_its_own_month(world, db, client_for):
    _organisation_timezone(db)
    admin = client_for(world.admin)
    _complete_on(world, admin, world.training(), "2026-11-01")  # Stored as 2026-10-31 18:30 UTC.
    months = [point["month"] for point in admin.get("/reports/organisation-summary").json()["data"]["trend"]]
    assert months == ["2026-11"]
    assert [p["month"] for p in admin.get("/admin/dashboard").json()["data"]["trend"]] == ["2026-11"]
    assert [p["month"] for p in admin.get("/reports/analytics").json()["data"]["trend"]] == ["2026-11"]


def test_employee_history_shows_submission_time_in_the_organisation_timezone(world, db, client_for):
    _organisation_timezone(db)
    obligation = world.complete(world.employee, world.training())
    take(db, client_for(world.employee), obligation.id, 9)  # Submitted at NOW: 06:00 UTC, 11:30 in Asia/Kolkata.
    report = client_for(world.admin).get("/reports/employee-history").json()["data"]
    assert "Submitted" in report["columns"] and not any("Submitted (" in column for column in report["columns"])
    rows = [r for r in rows_as_dicts(report) if r["Type"] == "Post-test"]
    assert [r["Submitted"] for r in rows] == ["04-11-2026 11:30 AM"]


# ---------- Report schedules: monthly anchor and downtime (audit B11) ----------

def test_monthly_schedule_keeps_its_anchor_day_and_local_time():
    from datetime import UTC, datetime
    from zoneinfo import ZoneInfo

    from app.modules.reports.router import next_run

    ist = ZoneInfo("Asia/Kolkata")
    jan31 = datetime(2027, 1, 31, 10, 0, tzinfo=ist).astimezone(UTC)
    feb = next_run("MONTHLY", jan31, 31, ist)
    mar = next_run("MONTHLY", feb, 31, ist)
    assert [m.astimezone(ist).strftime("%Y-%m-%d %H:%M") for m in (feb, mar)] == ["2027-02-28 10:00", "2027-03-31 10:00"]
    assert next_run("MONTHLY", datetime(2028, 1, 30, 6, 0, tzinfo=UTC), 30, UTC) == datetime(2028, 2, 29, 6, 0, tzinfo=UTC)  # Leap year.
    assert next_run("MONTHLY", datetime(2026, 12, 15, 6, 0, tzinfo=UTC), 15, UTC) == datetime(2027, 1, 15, 6, 0, tzinfo=UTC)
    assert next_run("WEEKLY", jan31, 31, ist) == jan31 + timedelta(days=7)


def test_monthly_schedule_created_on_the_31st_returns_to_the_31st(world, db, client_for):
    from datetime import UTC, datetime

    from app.core import clock
    from app.models import ReportSchedule
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    created_at = datetime(2027, 1, 31, 6, 0, tzinfo=UTC)
    clock.freeze(created_at)
    try:
        schedule = client_for(world.admin).post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "MONTHLY"}).json()["data"]
        assert schedule["next_run_at"] == "2027-02-28T06:00:00+00:00"
        assert run_due_schedules(db, datetime(2027, 2, 28, 6, 0, tzinfo=UTC)) == 1
        db.expire_all()
        assert db.get(ReportSchedule, schedule["id"]).next_run_at == datetime(2027, 3, 31, 6, 0, tzinfo=UTC)  # Not 28 Mar.
    finally:
        clock.freeze(NOW)


def test_downtime_skips_missed_runs_and_schedules_the_next_future_run(world, db, client_for):
    from app.models import ReportDelivery, ReportSchedule
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    schedule = client_for(world.admin).post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    assert schedule["next_run_at"] == (NOW + timedelta(days=7)).isoformat()
    back_up = NOW + timedelta(days=30)  # Runs were due on days 7, 14, 21 and 28 while the scheduler was down.
    assert run_due_schedules(db, back_up) == 1  # One delivery now, not four.
    assert run_due_schedules(db, back_up) == 0
    db.expire_all()
    assert db.get(ReportSchedule, schedule["id"]).next_run_at == NOW + timedelta(days=35)  # Next future run, same weekday.
    assert len(db.scalars(select(ReportDelivery).where(ReportDelivery.schedule_id == schedule["id"])).all()) == 1
    assert run_due_schedules(db, NOW + timedelta(days=35)) == 1


def test_download_of_an_export_whose_file_is_missing_is_a_404(world, db, client_for):
    """Audit B13. The record outlives its file (storage moved or cleaned): a clear 404, not a server error."""
    from app.core.config import get_settings
    from app.models import FileArtifact, ReportExport

    fixture_data(world, db, client_for)
    client = client_for(world.admin)
    export = client.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).json()["data"]
    record = db.get(ReportExport, export["id"])
    (get_settings().storage_path / db.get(FileArtifact, record.artifact_id).storage_key).unlink()
    response = client.get(f"/reports/exports/{export['id']}/download")
    assert response.status_code == 404 and response.json()["error"]["code"] == "NOT_FOUND"
    assert response.json()["error"]["message"] == "This export file is no longer available. Export the report again."


def test_owner_deletes_an_export_and_its_file(world, db, client_for):
    """Downloads card Delete: owner only (others get 404, file kept); the record, file record and stored file go."""
    from app.core.config import get_settings
    from app.models import FileArtifact, ReportExport

    fixture_data(world, db, client_for)
    client = client_for(world.admin)
    export = client.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).json()["data"]
    artifact_id = db.get(ReportExport, export["id"]).artifact_id
    stored = get_settings().storage_path / db.get(FileArtifact, artifact_id).storage_key
    assert stored.exists()

    second_admin = world.person("A2", "admin2@test.example", ["LD_ADMIN", "EMPLOYEE"])
    world.db.commit()
    assert client_for(second_admin).delete(f"/reports/exports/{export['id']}").status_code == 404
    assert client_for(world.employee).delete(f"/reports/exports/{export['id']}").status_code in (403, 404)
    assert stored.exists()

    response = client.delete(f"/reports/exports/{export['id']}")
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(ReportExport, export["id"]) is None and db.get(FileArtifact, artifact_id) is None
    assert not stored.exists()
    assert export["id"] not in {e["id"] for e in client.get("/reports/exports").json()["data"]}
    assert client.get(f"/reports/exports/{export['id']}/download").status_code == 404
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "REPORT_EXPORT_DELETED"))
    assert audit is not None and audit.target_id == export["id"] and audit.before_summary["report_code"] == "pass-fail"
    assert client.delete(f"/reports/exports/{export['id']}").status_code == 404  # Already gone.


def test_deleting_a_delivered_export_keeps_the_delivery_history(world, db, client_for):
    from app.models import ReportDelivery
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    client = client_for(world.admin)
    created = client.post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    assert run_due_schedules(db, NOW + timedelta(days=8)) == 1
    delivery = db.scalar(select(ReportDelivery).where(ReportDelivery.schedule_id == created["id"]))
    assert delivery.export_id is not None

    assert client_for(world.admin).delete(f"/reports/exports/{delivery.export_id}").status_code == 200
    db.expire_all()
    kept = db.scalar(select(ReportDelivery).where(ReportDelivery.schedule_id == created["id"]))
    assert kept is not None and kept.export_id is None and kept.status == "DELIVERED"


# ---------- Schedule owners who lost access (audit B18) ----------

@pytest.mark.parametrize(
    ("change", "reason"),
    [("account_disabled", "OWNER_ACCOUNT_DISABLED"), ("employee_inactive", "OWNER_EMPLOYEE_INACTIVE"), ("role_removed", "OWNER_NOT_AUTHORISED")],
)
def test_a_schedule_whose_owner_lost_access_generates_nothing(world, db, client_for, change, reason):
    from sqlalchemy import delete, func

    from app.models import FileArtifact, Notification, ReportDelivery, ReportExport, ReportSchedule, Role, UserAccount, UserRole
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    schedule = client_for(world.admin).post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == world.admin.id))
    if change == "account_disabled":
        account.account_status = "DISABLED"
    elif change == "employee_inactive":
        world.admin.employment_status = "INACTIVE"
    else:
        ld_admin = db.scalar(select(Role.id).where(Role.code == "LD_ADMIN"))
        db.execute(delete(UserRole).where(UserRole.user_account_id == account.id, UserRole.role_id == ld_admin))
    db.commit()
    exports_before = db.scalar(select(func.count()).select_from(ReportExport))
    files_before = db.scalar(select(func.count()).select_from(FileArtifact))

    assert run_due_schedules(db, NOW + timedelta(days=8)) == 0
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(ReportExport)) == exports_before
    assert db.scalar(select(func.count()).select_from(FileArtifact)) == files_before
    deliveries = db.scalars(select(ReportDelivery).where(ReportDelivery.schedule_id == schedule["id"])).all()
    assert [(d.status, d.error, d.export_id) for d in deliveries] == [("FAILED", reason, None)]
    assert db.scalar(select(Notification).where(Notification.user_account_id == account.id, Notification.type == "REPORT_READY")) is None
    assert db.get(ReportSchedule, schedule["id"]).next_run_at > NOW + timedelta(days=8)  # Claimed once, not retried every hour.
    assert run_due_schedules(db, NOW + timedelta(days=8)) == 0


# ---------- Report columns (approved: no Batch column in Compliance) ----------

def test_every_report_row_matches_its_columns_and_batch_columns_are_where_approved(world, db, client_for):
    """The Compliance report has no Batch column; Pass/Fail, Learning Gain and Employee History keep theirs, filled
    from the assignment's batch. Every row of every report, on screen and in a CSV export, has one value per column."""
    import csv
    import io

    from app.models import TrainingBatch

    training = fixture_data(world, db, client_for)
    batch_name = db.scalar(select(TrainingBatch.name).where(TrainingBatch.training_id == training.id))
    admin = client_for(world.admin)
    with_batch = {"pass-fail", "learning-gain", "employee-history"}
    for code in CODES:
        data = admin.get(f"/reports/{code}").json()["data"]
        if code != "behaviour":  # Level 3 is switched off, so the Behaviour report has no rows to check.
            assert data["rows"], code
        assert all(len(row) == len(data["columns"]) for row in data["rows"]), code
        if code == "compliance":
            assert "Batch" not in data["columns"]
        if code in with_batch:
            assert "Batch" in data["columns"], code
            assert {dict(zip(data["columns"], row, strict=True))["Batch"] for row in data["rows"]} == {batch_name}, code

    export = admin.post("/reports/exports", json={"report_code": "compliance", "export_format": "CSV"}).json()["data"]
    lines = list(csv.reader(io.StringIO(admin.get(f"/reports/exports/{export['id']}/download").content.decode("utf-8-sig"))))
    header_at = next(i for i, line in enumerate(lines) if line and line[0] == "Employee")
    header = lines[header_at]
    assert "Batch" not in header
    body = [line for line in lines[header_at + 1 :] if len(line) > 1]
    assert body and all(len(line) == len(header) for line in body)


# ---------- Submission labels (TRAINING_COMPLETED) ----------

def test_every_submission_reason_has_a_label():
    from app.core.enums import SubmissionReason
    from app.modules.reports.catalogue import SUBMISSION_LABELS

    assert set(SUBMISSION_LABELS) == {reason.value for reason in SubmissionReason}
    assert all(label.strip() for label in SUBMISSION_LABELS.values())


def test_pre_test_submitted_when_completion_is_recorded_is_labelled_in_history_and_exports(world, db, client_for):
    """A pre-test still running when L&D records completion is submitted automatically (TRAINING_COMPLETED). The
    Employee History report, and its CSV and Excel exports, say so instead of leaving Submission blank."""
    import csv
    import io

    from openpyxl import load_workbook

    from app.core.enums import AssessmentType
    from app.models import AssessmentAttempt, AssessmentConfig

    training = world.training()
    training.pretest_enabled = True
    db.add(AssessmentConfig(training_id=training.id, assessment_type=AssessmentType.PRE_TEST, version=1, question_count=10, duration_seconds=600, max_attempts=1))
    enrolment = world.enrol(world.employee, training)
    db.commit()
    started = client_for(world.employee).post(f"/me/pre-tests/{enrolment.id}/attempts", json={"instructions_acknowledged": True})
    assert started.status_code == 200, started.text
    admin = client_for(world.admin)
    assert admin.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": NOW.date().isoformat()}).status_code == 200
    db.expire_all()
    assert db.get(AssessmentAttempt, started.json()["data"]["attempt_id"]).submission_reason == "TRAINING_COMPLETED"

    label = "Training completion recorded"
    report = admin.get(f"/reports/employee-history?training_id={training.id}").json()["data"]
    pre = [dict(zip(report["columns"], row, strict=True)) for row in report["rows"] if row[report["columns"].index("Type")] == "Pre-test"]
    assert [row["Submission"] for row in pre] == [label]

    def export(fmt: str) -> bytes:
        record = admin.post("/reports/exports", json={"report_code": "employee-history", "export_format": fmt, "filters": {"training_id": str(training.id)}}).json()["data"]
        return admin.get(f"/reports/exports/{record['id']}/download").content

    rows = list(csv.reader(io.StringIO(export("CSV").decode("utf-8-sig"))))
    header = next(r for r in rows if r and r[0] == "Employee")
    assert [r[header.index("Submission")] for r in rows if len(r) == len(header) and r[header.index("Type")] == "Pre-test"] == [label]
    sheet = load_workbook(io.BytesIO(export("XLSX"))).active
    values = [[cell for cell in row] for row in sheet.iter_rows(values_only=True)]
    header = next(list(r) for r in values if r and r[0] == "Employee")
    assert [r[header.index("Submission")] for r in values if r and len(r) >= len(header) and r[header.index("Type")] == "Pre-test"] == [label]
