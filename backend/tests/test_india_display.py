"""India display stays separate from UTC storage, calendar rules, imports and passwords."""
import io
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from openpyxl import load_workbook
from pypdf import PdfReader
from sqlalchemy import select

from app.core import clock
from app.core.display import display_date, display_datetime, display_legacy_moments, filename_stamp
from app.core.responses import iso
from app.manage import import_employees
from app.models import ManagerAssignment, TrainingBatch
from app.modules.notifications.router import view
from app.modules.organisation.people import employee_password, parse_joining_date
from app.modules.reports.catalogue import Report
from app.modules.reports.exports import render_csv, render_pdf, render_xlsx
from tests.conftest import NOW
from tests.test_manage import row


@pytest.mark.parametrize(("instant", "shown"), [
    ("2026-11-23T10:05:00+00:00", "23-11-2026 03:35 PM"),
    ("2026-11-23T15:35:00+05:30", "23-11-2026 03:35 PM"),
    ("2026-11-23T18:30:00+00:00", "24-11-2026 12:00 AM"),
    ("2026-11-23T06:30:00+00:00", "23-11-2026 12:00 PM"),
    ("2026-12-31T20:55:00+00:00", "01-01-2027 02:25 AM"),
])
def test_india_timestamps_and_api_instants_are_separate(instant, shown):
    value = datetime.fromisoformat(instant)
    assert display_datetime(value) == shown
    assert datetime.fromisoformat(iso(value)) == value
    assert display_date(value) == shown[:10]
    assert display_date(date(2026, 11, 23)) == "23-11-2026"


def test_all_export_formats_and_filename_use_india_time():
    at = datetime(2026, 11, 23, 20, 55, tzinfo=UTC)
    report = Report("synthetic", "Synthetic report", "", ["Submitted"], [[display_datetime(at)]])
    filters = {"date_from": "2026-11-23", "date_to": "2026-11-24"}
    csv = render_csv(report, filters, at, "Synthetic").decode("utf-8-sig")
    workbook = load_workbook(io.BytesIO(render_xlsx(report, filters, at, "Synthetic")))
    sheet = "\n".join(str(cell.value or "") for cells in workbook.active for cell in cells)
    pdf = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(render_pdf(report, filters, at, "Synthetic"))).pages)
    for text in (csv, sheet, pdf):
        assert "24-11-2026 02:25 AM" in text
        assert "date_from=23-11-2026" in text and "date_to=24-11-2026" in text
        assert "UTC" not in text and "Asia/Kolkata" not in text
    assert filename_stamp(at) == "24-11-2026-02-25-AM"
    assert filters == {"date_from": "2026-11-23", "date_to": "2026-11-24"}


def test_existing_generated_notifications_are_formatted_without_rewriting_them():
    text = "Your assessment opens from 2026-11-23 20:55 (UTC)."
    notification = SimpleNamespace(id="synthetic", type="ASSESSMENT_SCHEDULED", title="Synthetic", message=text, link=None, read_at=None, created_at=NOW)
    assert view(notification)["message"] == "Your assessment opens from 24-11-2026 02:25 AM."
    assert notification.message == text
    assert display_legacy_moments("At 2026-11-23 15:35 (Asia/Kolkata).") == "At 23-11-2026 03:35 PM."
    assert display_legacy_moments("Invalid 2026-99-23 15:35 (UTC).") == "Invalid 2026-99-23 15:35 (UTC)."


@pytest.mark.parametrize("text", ["23/11/2026", "23-11-2026", "2026-11-23", "23 Nov 2026", "23112026"])
def test_import_formats_and_password_generation_are_independent_of_display(text):
    joining = parse_joining_date(text)
    assert joining == date(2026, 11, 23)
    assert employee_password(joining) == employee_password(date(2026, 11, 23))
    assert joining.isoformat() == "2026-11-23"


def test_calendar_filters_past_batches_by_india_today(world, db, client_for):
    clock.freeze(datetime(2026, 11, 4, 20, 55, tzinfo=UTC))  # 5 November in India.
    training = world.training()
    world.enrol(world.employee, training)
    batch = db.scalar(select(TrainingBatch).where(TrainingBatch.training_id == training.id))
    batch.start_date = date(2026, 11, 4)
    db.commit()
    client = client_for(world.employee)
    assert not any(item["tag"] == "Training session" for item in client.get("/me/dashboard").json()["data"]["calendar"])
    batch.start_date = date(2026, 11, 5)
    db.commit()
    assert any(item["date"] == "2026-11-05" for item in client.get("/me/dashboard").json()["data"]["calendar"])


def test_operator_manager_history_uses_india_today(world, db):
    clock.freeze(datetime(2026, 11, 4, 20, 55, tzinfo=UTC))
    result = import_employees(db, [row("E1", world.employee.work_email, manager_code="M2")])
    assert result.errors == []
    db.commit()
    links = db.scalars(select(ManagerAssignment).where(ManagerAssignment.employee_id == world.employee.id)).all()
    assert next(link for link in links if link.effective_to is None).effective_from == date(2026, 11, 5)
    assert next(link for link in links if link.effective_to is not None).effective_to == date(2026, 11, 5)


def test_india_schedule_inputs_preserve_instants_with_a_different_saved_calendar(world, client_for):
    training = world.training()  # The test calendar is UTC; the UI always chooses India wall-clock time.
    client = client_for(world.admin)
    body = {"question_count": 10, "duration_minutes": 20, "schedule_mode": "FIXED_DATE", "schedule_date": "2026-11-05", "schedule_time": "02:00", "schedule_timezone": "Asia/Kolkata"}
    path = f"/admin/trainings/{training.id}/assessment-configs"
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    assert datetime.fromisoformat(response.json()["data"]["schedule_at"]) == datetime(2026, 11, 4, 20, 30, tzinfo=UTC)
    assert client.post(path, json=body).json()["data"]["schedule_at"] == response.json()["data"]["schedule_at"]
    legacy = {key: value for key, value in body.items() if key != "schedule_timezone"}
    assert datetime.fromisoformat(client.post(path, json=legacy).json()["data"]["schedule_at"]) == datetime(2026, 11, 5, 2, 0, tzinfo=UTC)
