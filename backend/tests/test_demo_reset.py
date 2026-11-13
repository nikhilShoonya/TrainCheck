"""Demo data reset from the sign-in page: off by default, never in production, and a true fresh start."""
from sqlalchemy import func, select, text

from app import seed_data
from app.core.config import get_settings
from app.models import AssessmentFeedback, Employee, UserSession
from app.modules.demo.router import job
from tests.conftest import ApiClient

RESET = {"confirm": "RESET"}


def _employee_count(db) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(Employee))


def test_reset_is_off_by_default(world, db):
    client = ApiClient()
    assert client.get("/demo/status").json()["data"] == {"reset_enabled": False, "reset": None}
    before = _employee_count(db)
    response = client.post("/demo/reset", json=RESET)
    assert response.status_code == 404
    assert _employee_count(db) == before


def test_reset_is_refused_in_production(monkeypatch, db):
    settings = get_settings()
    monkeypatch.setattr(settings, "demo_reset_enabled", True)
    monkeypatch.setattr(settings, "app_env", "production")
    client = ApiClient()
    assert client.get("/demo/status").json()["data"] == {"reset_enabled": False, "reset": None}
    assert client.post("/demo/reset", json=RESET).status_code == 404


def test_reset_needs_explicit_json_confirmation(monkeypatch, db):
    monkeypatch.setattr(get_settings(), "demo_reset_enabled", True)
    client = ApiClient()
    assert client.post("/demo/reset", json={}).status_code == 400
    assert client.post("/demo/reset", json={"confirm": "yes"}).status_code == 400
    form = client.http.post("/api/v1/demo/reset", data={"confirm": "RESET"})
    assert form.status_code in (400, 415)
    assert _employee_count(db) == 0


def test_reset_erases_changes_and_restores_demo_data(monkeypatch, world, db):
    monkeypatch.setattr(get_settings(), "demo_reset_enabled", True)
    test_only = world.person("Z999", "tester@test.example", ["EMPLOYEE"])
    db.commit()
    signed_in = ApiClient()
    assert signed_in.login(test_only.work_email).status_code == 200

    client = ApiClient()
    assert client.get("/demo/status").json()["data"]["reset_enabled"] is True
    response = client.post("/demo/reset", json=RESET)
    assert response.status_code == 202, response.text
    assert response.json()["data"]["started"] is True
    # A second press while it runs does not start another reset.
    assert client.post("/demo/reset", json=RESET).json()["data"]["started"] is False
    assert job.finished.wait(timeout=600)
    status = client.get("/demo/status").json()["data"]["reset"]
    assert status["state"] == "DONE", status

    db.expire_all()
    assert db.scalar(select(Employee).where(Employee.employee_code == "Z999")) is None
    assert db.scalar(select(func.count()).select_from(UserSession)) == 0
    assert signed_in.get("/auth/me").status_code == 401
    assert db.scalar(select(func.count()).select_from(AssessmentFeedback)) == 8
    assert db.scalar(text("SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'demo_build'")) == 0
    for email in ("admin@traincheck.demo", "employee@traincheck.demo"):
        assert ApiClient().login(email, seed_data.DEMO_PASSWORD).status_code == 200, email
