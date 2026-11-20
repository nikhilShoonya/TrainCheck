"""Import uploads are refused before their body is read when no one is signed in or they are clearly too large.

FastAPI reads (and spools to disk) a multipart body before it runs any dependency, including sign-in checks, so the
size limit and the session check must happen earlier, from the headers (audit F-08).
"""
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.core.config import get_settings
from app.main import app

UPLOAD_PATHS = ["/api/v1/admin/imports", "/api/v1/admin/imports/00000000-0000-0000-0000-000000000001/replace", "/api/v1/admin/employees/import/preview", "/api/v1/admin/employees/import"]


@pytest.fixture
def form_reads(monkeypatch):
    reads: list[str] = []
    real = Request.form

    def spy(self, *args, **kwargs):
        reads.append(self.url.path)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Request, "form", spy)
    return reads


@pytest.mark.parametrize("path", UPLOAD_PATHS)
def test_anonymous_upload_is_refused_without_reading_the_body(path, form_reads):
    anonymous = TestClient(app)
    response = anonymous.post(path, data={"import_type": "QUESTIONS"}, files={"file": ("q.csv", b"x" * 200_000, "text/csv")})
    assert response.status_code == 401
    assert form_reads == []


def test_an_upload_far_over_the_limit_is_refused_from_its_size(world, client_for, form_reads, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 10_000)
    admin = client_for(world.admin)
    response = admin.post("/admin/imports", data={"import_type": "QUESTIONS"}, files={"file": ("q.csv", b"x" * 300_000, "text/csv")})
    assert response.status_code == 413 and response.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert form_reads == []


def test_a_normal_upload_still_works(world, client_for):
    admin = client_for(world.admin)
    response = admin.post("/admin/imports", data={"import_type": "QUESTIONS"}, files={"file": ("q.csv", b"id,topic\n", "text/csv")})
    assert response.status_code in (200, 400), response.text  # Validated normally (here: missing template columns).
    assert response.json().get("error", {}).get("code") != "FILE_TOO_LARGE"


def _count_statements(engine):
    from sqlalchemy import event

    counter = {"n": 0}

    def count(*_args, **_kwargs):
        counter["n"] += 1

    event.listen(engine, "before_cursor_execute", count)
    return counter, lambda: event.remove(engine, "before_cursor_execute", count)


def _csv(rows: list[list[str]]) -> bytes:
    import csv
    import io

    buffer = io.StringIO()
    csv.writer(buffer).writerows(rows)
    return buffer.getvalue().encode()


@pytest.mark.parametrize("size", [300])
def test_validating_a_large_question_file_does_not_query_per_row(world, client_for, size):
    """Validation reads what it needs once per file: on Neon each round trip costs milliseconds (audit F-13)."""
    from app.core import db as database
    from app.modules.imports.question_format import FIELDS

    training = world.training()
    body = [FIELDS] + [
        [f"Question {i}?", "A", "B", "C", "D", "B", "Topic"]
        for i in range(size)
    ]
    admin = client_for(world.admin)
    counter, stop = _count_statements(database.get_engine())
    try:
        response = admin.post("/admin/imports", data={"import_type": "QUESTIONS", "training_id": str(training.id), "test_type": "POST_TEST"}, files={"file": ("q.csv", _csv(body), "text/csv")})
    finally:
        stop()
    assert response.status_code == 200, response.text
    assert response.json()["data"]["accepted_rows"] == size
    assert counter["n"] < 40, f"{counter['n']} statements for {size} rows"


def test_validating_a_large_completion_file_does_not_query_per_row(world, client_for, db):
    from app.core import db as database
    from app.models import Employee, UserAccount

    training = world.training()
    people = []
    for i in range(300):
        person = Employee(employee_code=f"BULK{i:04d}", full_name=f"Bulk {i}", work_email=f"bulk{i}@test.example", department_id=world.employee.department_id)
        db.add(person)
        people.append(person)
    db.commit()
    assert db.scalar(select_count(UserAccount)) > 0
    body = [["employee", "training", "completion_date"]] + [[p.employee_code, training.training_code, "2026-11-01"] for p in people]
    admin = client_for(world.admin)
    counter, stop = _count_statements(database.get_engine())
    try:
        response = admin.post("/admin/imports", data={"import_type": "COMPLETIONS"}, files={"file": ("c.csv", _csv(body), "text/csv")})
    finally:
        stop()
    assert response.status_code == 200, response.text
    assert response.json()["data"]["accepted_rows"] == 300
    assert counter["n"] < 60, f"{counter['n']} statements for 300 rows"


def select_count(model):
    from sqlalchemy import func, select

    return select(func.count()).select_from(model)
