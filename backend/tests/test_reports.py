"""Reports, scorecard and exports. TC-REP-*, TC-KIR-010, SC-2L-101, SC-2L-102."""
import io
from datetime import timedelta
from decimal import Decimal

import pytest
from openpyxl import load_workbook
from sqlalchemy import select

from app.models import AuditLog, Question
from app.modules.reports.exports import safe_text
from tests.conftest import NOW, take

CODES = ["compliance", "pass-fail", "learning-gain", "behaviour", "question-analytics", "employee-history", "scorecard"]
FORMATS = ["CSV", "XLSX", "PDF"]


def fixture_data(world, db, client_for):
    training = world.training(pass_mark=Decimal("70"))
    world.template(training)
    passed = world.complete(world.employee, training, NOW - timedelta(days=5))
    failed = world.complete(world.teammate, training, NOW - timedelta(days=5))
    other = world.complete(world.outsider, training, NOW - timedelta(days=5))
    take(db, client_for(world.employee), passed.id, 9)
    take(db, client_for(world.teammate), failed.id, 4)
    take(db, client_for(world.outsider), other.id, 8)
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
    client = client_for(world.hr)
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
    training = fixture_data(world, db, client_for)
    other = world.training("T2")
    world.enrol(world.employee, other)
    admin = client_for(world.admin)
    cx = rows_as_dicts(admin.get(f"/reports/compliance?department_id={world.departments['CX'].id}").json()["data"])
    assert {r["Employee ID"] for r in cx} == {"E3"}
    grade = rows_as_dicts(admin.get("/reports/compliance?grade=NONE").json()["data"])
    assert grade == []
    by_training = rows_as_dicts(admin.get(f"/reports/compliance?training_id={other.id}").json()["data"])
    assert {r["Training"] for r in by_training} == {other.title}
    by_manager = rows_as_dicts(admin.get(f"/reports/compliance?manager_id={world.manager.id}&training_id={training.id}").json()["data"])
    assert {r["Employee ID"] for r in by_manager} == {"E1", "E2"}
    future = rows_as_dicts(admin.get(f"/reports/compliance?date_from={(NOW + timedelta(days=1)).date()}").json()["data"])
    assert future == []
    by_trainer = rows_as_dicts(admin.get(f"/reports/compliance?trainer_id={world.trainer.id}").json()["data"])
    assert len(by_trainer) == 4
    assert rows_as_dicts(admin.get(f"/reports/compliance?location_id={world.location.id}").json()["data"])


def test_managers_keep_only_the_team_scorecard_export(world, db, client_for):  # Team Reports removed; SEC-014
    training = fixture_data(world, db, client_for)
    manager = client_for(world.manager)
    assert manager.get("/reports/pass-fail").status_code == 403
    assert manager.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "XLSX"}).status_code == 403
    assert [c["code"] for c in manager.get("/reports/catalogue").json()["data"]] == ["scorecard"]
    export = manager.post("/reports/exports", json={"report_code": "scorecard", "export_format": "XLSX", "filters": {"training_id": str(training.id)}})
    assert export.status_code == 200, export.text
    content = manager.get(f"/reports/exports/{export.json()['data']['id']}/download").content
    values = [str(c.value) for row in load_workbook(io.BytesIO(content)).active.iter_rows() for c in row]
    assert any("Team of" in v for v in values)  # The Team Scorecards export keeps the team scope.


def test_export_permissions(world, db, client_for):  # TC-REP-005, SEC-009
    fixture_data(world, db, client_for)
    employee = client_for(world.employee)
    assert employee.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).status_code == 403
    assert employee.get("/reports/pass-fail").status_code == 403
    assert employee.post("/reports/exports", json={"report_code": "employee-history", "export_format": "CSV"}).status_code == 403
    assert employee.get("/reports/employee-history").status_code == 403  # Assessment History was removed.
    assert employee.get("/reports/catalogue").json()["data"] == []

    hr = client_for(world.hr)
    private = hr.post("/reports/exports", json={"report_code": "pass-fail", "export_format": "CSV"}).json()["data"]
    assert employee.get(f"/reports/exports/{private['id']}/download").status_code == 404
    assert client_for(world.admin).get(f"/reports/exports/{private['id']}/download").status_code == 404
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
    card = client_for(world.hr).get(f"/scorecards/{training.id}").json()["data"]
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


def test_manager_scorecard_is_team_scoped(world, db, client_for):
    training = fixture_data(world, db, client_for)
    card = client_for(world.other_manager).get(f"/scorecards/{training.id}").json()["data"]
    assert card["learning"]["assigned"] == 1  # Only the outsider is on this manager's team.
    assert client_for(world.employee).get(f"/scorecards/{training.id}").status_code == 403


def test_filter_options_are_scoped(world, db, client_for):
    fixture_data(world, db, client_for)
    options = client_for(world.other_manager).get("/reports/filter-options").json()["data"]
    assert [d["name"] for d in options["departments"]] == ["Cx"]
    assert options["managers"] == []
    assert {m["name"] for m in client_for(world.hr).get("/reports/filter-options").json()["data"]["managers"]} == {"Person M1", "Person M2"}


def test_scheduled_report_delivery_and_history(world, db, client_for):  # PRD-REPORT-014, P3-010
    from app.core import clock
    from app.modules.reports.router import run_due_schedules

    fixture_data(world, db, client_for)
    assert client_for(world.manager).post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).status_code == 403
    client = client_for(world.hr)
    created = client.post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    assert run_due_schedules(db, NOW) == 0

    later = NOW + timedelta(days=8)
    assert run_due_schedules(db, later) == 1
    assert run_due_schedules(db, later) == 0  # Running again does not deliver twice.

    clock.freeze(NOW + timedelta(days=8))
    client = client_for(world.hr)
    schedule = next(s for s in client.get("/reports/schedules").json()["data"] if s["id"] == created["id"])
    assert schedule["deliveries"][0]["status"] == "DELIVERED"
    notes = client.get("/me/notifications").json()["data"]
    assert any(n["type"] == "REPORT_READY" for n in notes)
    export_id = schedule["deliveries"][0]["export_id"]
    content = client.get(f"/reports/exports/{export_id}/download").content
    assert b"E1" in content and b"Organisation" in content  # The delivered file keeps the owner's scope.


def test_only_report_users_can_schedule(world, client_for):
    client = client_for(world.employee)
    assert client.post("/reports/schedules", json={"report_code": "pass-fail", "cadence": "WEEKLY"}).status_code == 403


def test_dashboards_keep_missing_values_as_none(world, client_for):
    assert client_for(world.admin).get("/admin/dashboard").json()["data"]["summary"]["pass_rate"] is None
    assert client_for(world.manager).get("/manager/dashboard").json()["data"]["summary"]["pass_rate"] is None
    assert client_for(world.employee).get("/me/dashboard").json()["data"]["overall_score"] is None


def test_all_role_dashboards_load_with_data(world, db, client_for):
    fixture_data(world, db, client_for)
    assert client_for(world.admin).get("/admin/dashboard").json()["data"]["total_employees"] == 7
    org = client_for(world.hr).get("/reports/organisation-summary").json()["data"]
    assert org["summary"]["assessed"] == 3 and org["trend"]
    team = client_for(world.manager).get("/manager/dashboard").json()["data"]
    assert team["summary"]["employees"] == 2
    own = client_for(world.employee).get("/me/dashboard").json()["data"]
    assert own["overall_score"] == 90.0
    assert client_for(world.employee).get("/me/certificates").status_code == 404  # Certificates were removed from the product.
    assert client_for(world.teammate).get("/me/refresher-materials").json()["data"][0]["refresher_text"]


def test_analytics_and_manager_evaluation(world, db, client_for, behaviour_on):  # Legacy Level 3 trend; needs Behaviour on.
    fixture_data(world, db, client_for)
    hr = client_for(world.hr)
    data = hr.get("/reports/analytics").json()["data"]
    assert {d["department"] for d in data["departments"]} == {"Ops", "Cx"}
    assert {f["function"] for f in data["functions"]} == {"Compliance", "Sales"}
    assert data["topics"] and data["behaviour_trend"]
    assert data["behaviour_trend"][0]["self_mean"] is None  # No ratings yet: missing, not zero.
    evaluation = hr.get("/reports/manager-evaluation").json()["data"]
    assert {m["manager"] for m in evaluation} == {"Person M1", "Person M2"}
    assert evaluation[0]["completion_rate"] is None
    assert client_for(world.manager).get("/reports/manager-evaluation").status_code == 403
    team_only = client_for(world.other_manager).get("/reports/analytics").json()["data"]
    assert team_only["summary"]["employees"] == 1


def test_personal_history_export_and_page_api_are_retired(world, db, client_for):  # Assessment History removed
    fixture_data(world, db, client_for)
    for person in (world.employee, world.manager, world.hr, world.admin):
        client = client_for(person)
        assert client.post("/reports/exports", json={"report_code": "employee-history", "export_format": "CSV", "own_record": True}).status_code == 403
    assert client_for(world.employee).get("/me/history").status_code == 404
