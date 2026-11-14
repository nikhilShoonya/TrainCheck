"""Test harness. Runs against a real PostgreSQL database, migrated with the real Alembic scripts.

The database in TEST_DATABASE_URL is erased. The suite refuses to run against the application database.
"""
import os
import subprocess
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

os.environ["APP_ENV"] = "test"
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["RATE_LIMIT_ENABLED"] = "false"  # test_rate_limit.py switches it on for its own tests.
os.environ["BEHAVIOUR_ENABLED"] = "false"  # The approved scope; Level 3 tests switch it on with `behaviour_on`.
os.environ["COMPLETION_ALLOWS_PARTIAL_ATTENDANCE"] = "false"

from app.core import clock  # noqa: E402
from app.core import db as database
from app.core.config import get_settings, normalise_database_url  # noqa: E402
from app.core.db import Base  # noqa: E402
from app.core.enums import AssessmentType, TrainingStatus  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    AssessmentConfig,
    AssessmentObligation,
    BehaviourTemplate,
    BehaviourTemplateQuestion,
    Competency,
    Department,
    Employee,
    Enrolment,
    Function,
    Location,
    ManagerAssignment,
    Question,
    QuestionAnswerKey,
    QuestionOption,
    Role,
    Trainer,
    Training,
    TrainingBatch,
    UserAccount,
    UserRole,
    WorkingCalendar,
)
from app.modules.training.service import record_completion  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
PASSWORD = "TestPassword123"
# A Wednesday, so "next working day" and calendar tests are deterministic.
NOW = datetime(2026, 11, 4, 6, 0, tzinfo=UTC)
_password_hash = hash_password(PASSWORD)


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> Iterator[None]:
    settings = get_settings()
    url = settings.test_database_url
    if not url:
        pytest.exit("Set TEST_DATABASE_URL in backend/.env. That database will be erased.", returncode=2)
    if normalise_database_url(url) == normalise_database_url(settings.database_url or "x://none"):
        pytest.exit("TEST_DATABASE_URL must not be the application database.", returncode=2)
    settings.file_storage_dir = str(BACKEND_DIR / "var" / "test-files")

    engine = create_engine(normalise_database_url(url))
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND_DIR, check=True, env={**os.environ, "ALEMBIC_DATABASE_URL": url}, capture_output=True)
    database.configure(url)
    yield


@pytest.fixture(autouse=True)
def clean_tables() -> Iterator[None]:
    clock.freeze(NOW)
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with database.get_engine().begin() as connection:
        connection.execute(text(f"TRUNCATE {tables} CASCADE"))
    yield
    clock.freeze(None)


@pytest.fixture
def behaviour_on(monkeypatch) -> None:
    """Restores the legacy Level 3 workflows for the tests that cover them. Off by default (out of scope)."""
    monkeypatch.setattr(get_settings(), "behaviour_enabled", True)


@pytest.fixture
def db() -> Iterator[Session]:
    session = database.session_factory()()
    yield session
    session.rollback()
    session.close()


class World:
    """A small synthetic organisation shared by the tests."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.departments = {c: Department(code=c, name=c.title()) for c in ("OPS", "CX")}
        self.functions = {c: Function(code=c, name=c.title()) for c in ("COMPLIANCE", "SALES")}
        self.location = Location(code="L1", name="Location 1")
        db.add_all([*self.departments.values(), *self.functions.values(), self.location])
        db.add(WorkingCalendar(code="DEFAULT", name="Test calendar", timezone="UTC", working_weekdays=[0, 1, 2, 3, 4], is_default=True))
        self.roles = {c: Role(code=c, name=c) for c in ("EMPLOYEE", "LD_ADMIN")}
        db.add_all(self.roles.values())
        db.flush()
        # The Manager and HR / Leadership roles were removed. These people stay (reporting lines are kept as
        # data) and hold the Employee role only, so they also stand in for "any non-admin user".
        self.manager = self.person("M1", "manager1@test.example", ["EMPLOYEE"], "OPS")
        self.other_manager = self.person("M2", "manager2@test.example", ["EMPLOYEE"], "CX")
        self.admin = self.person("A1", "admin@test.example", ["LD_ADMIN", "EMPLOYEE"], "OPS")
        self.hr = self.person("H1", "hr@test.example", ["EMPLOYEE"], "OPS")
        self.employee = self.person("E1", "employee@test.example", ["EMPLOYEE"], "OPS", "COMPLIANCE", manager=self.manager)
        self.teammate = self.person("E2", "teammate@test.example", ["EMPLOYEE"], "OPS", "SALES", manager=self.manager)
        self.outsider = self.person("E3", "outsider@test.example", ["EMPLOYEE"], "CX", "SALES", manager=self.other_manager)
        self.competency = Competency(code="C1", name="Applies the documented process")
        db.add(self.competency)
        self.trainer = Trainer(name="Trainer One")
        db.add(self.trainer)
        db.commit()

    def person(self, code: str, email: str, roles: list[str], department: str = "OPS", function: str | None = None, manager: Employee | None = None) -> Employee:
        employee = Employee(employee_code=code, full_name=f"Person {code}", work_email=email, department_id=self.departments[department].id, function_id=self.functions[function].id if function else None, location_id=self.location.id, grade="G1")
        self.db.add(employee)
        self.db.flush()
        account = UserAccount(employee_id=employee.id, login_email=email, password_hash=_password_hash)
        self.db.add(account)
        self.db.flush()
        for role in roles:
            self.db.add(UserRole(user_account_id=account.id, role_id=self.roles[role].id))
        if manager:
            self.db.add(ManagerAssignment(employee_id=employee.id, manager_employee_id=manager.id, effective_from=(NOW - timedelta(days=365)).date()))
        self.db.flush()
        return employee

    def training(self, code: str = "T1", questions: int = 10, count: int = 10, marks: Decimal = Decimal("1"), pass_mark: Decimal = Decimal("70"), mix: dict | None = None, **config) -> Training:
        training = Training(training_code=code, title=f"Training {code}", status=TrainingStatus.ACTIVE, trainer_id=self.trainer.id, refresher_text="Review the guidance.", followup_days=[30], item_minimum_sample=2)
        self.db.add(training)
        self.db.flush()
        batch = TrainingBatch(training_id=training.id, batch_code="B1", name=f"Batch {code}")
        self.db.add(batch)
        self.db.add(
            AssessmentConfig(
                training_id=training.id,
                assessment_type=AssessmentType.POST_TEST,
                version=1,
                question_count=count,
                duration_seconds=config.pop("duration_seconds", 900),
                pass_mark_percent=pass_mark,
                max_attempts=config.pop("max_attempts", 3),
                difficulty_mix=mix,
                schedule_mode=config.pop("schedule_mode", "SAME_DAY"),
                **config,
            )
        )
        self.db.flush()
        for i in range(questions):
            self.question(training, f"{code}-Q{i + 1:02d}", marks=marks, difficulty=("EASY", "MEDIUM", "HARD")[i % 3])
        self.db.commit()
        return training

    def question(self, training: Training, code: str, marks: Decimal = Decimal("1"), difficulty: str = "EASY", question_type: str = "MCQ_SINGLE", correct: int = 1) -> Question:
        question = Question(question_code=code, topic="Topic A" if code[-1] in "13579" else "Topic B", competency_id=self.competency.id, question_type=question_type, question_text=f"Question {code}?", explanation=f"Explanation for {code}", difficulty=difficulty, marks=marks, trainings=[training])
        self.db.add(question)
        self.db.flush()
        options = [QuestionOption(question_id=question.id, option_text=f"{code} option {i}", display_order=i) for i in range(4)]
        self.db.add_all(options)
        self.db.flush()
        for option in options[:correct]:
            self.db.add(QuestionAnswerKey(question_id=question.id, option_id=option.id))
        self.db.flush()
        return question

    def enrol(self, employee: Employee, training: Training) -> Enrolment:
        batch = self.db.scalar(select(TrainingBatch).where(TrainingBatch.training_id == training.id))
        enrolment = Enrolment(training_id=training.id, batch_id=batch.id, employee_id=employee.id, assigned_at=NOW - timedelta(days=30))
        self.db.add(enrolment)
        self.db.commit()
        return enrolment

    def complete(self, employee: Employee, training: Training, when: datetime | None = None) -> AssessmentObligation:
        enrolment = self.enrol(employee, training)
        obligation = record_completion(self.db, enrolment, when or NOW - timedelta(days=2), "MANUAL", None)
        self.db.commit()
        return obligation

    def template(self, training: Training | None = None, function: Function | None = None, name: str = "Template") -> BehaviourTemplate:
        template = BehaviourTemplate(code=name.upper().replace(" ", "-"), name=name, training_id=training.id if training else None, function_id=function.id if function else None)
        self.db.add(template)
        self.db.flush()
        self.db.add(BehaviourTemplateQuestion(template_id=template.id, competency_id=self.competency.id, prompt="How consistently is this applied?", display_order=1))
        self.db.commit()
        return template


@pytest.fixture
def world(db: Session) -> World:
    return World(db)


class ApiClient:
    """Signs in through the real endpoint and sends the CSRF header, as the browser does."""

    def __init__(self, address: str = "testclient", headers: dict[str, str] | None = None) -> None:
        self.http = TestClient(app, raise_server_exceptions=True, client=(address, 50000), headers=headers)
        self.csrf = ""

    def login(self, email: str, password: str = PASSWORD):
        response = self.http.post("/api/v1/auth/login", json={"email": email, "password": password})
        if response.status_code == 200:
            self.csrf = response.json()["data"]["csrf_token"]
        return response

    def _headers(self, headers: dict | None) -> dict:
        return {"X-CSRF-Token": self.csrf, **(headers or {})}

    def get(self, path: str, **kwargs):
        return self.http.get(f"/api/v1{path}", **kwargs)

    def post(self, path: str, json=None, headers: dict | None = None, **kwargs):
        return self.http.post(f"/api/v1{path}", json=json, headers=self._headers(headers), **kwargs)

    def put(self, path: str, json=None, **kwargs):
        return self.http.put(f"/api/v1{path}", json=json, headers=self._headers(None), **kwargs)

    def patch(self, path: str, json=None, **kwargs):
        return self.http.patch(f"/api/v1{path}", json=json, headers=self._headers(None), **kwargs)

    def delete(self, path: str, **kwargs):
        return self.http.delete(f"/api/v1{path}", headers=self._headers(None), **kwargs)


@pytest.fixture
def client_for():
    def make(email: str | Employee) -> ApiClient:
        client = ApiClient()
        response = client.login(email.work_email if isinstance(email, Employee) else email)
        assert response.status_code == 200, response.text
        return client

    return make


def start(client: ApiClient, obligation_id) -> dict:
    response = client.post(f"/assessment-obligations/{obligation_id}/attempts", json={"instructions_acknowledged": True})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def answer_with_score(db: Session, client: ApiClient, attempt: dict, correct_count: int) -> None:
    """Answers through the real API; the key is read from the database, as a test may do."""
    from app.models import AttemptQuestion

    for index, question in enumerate(attempt["questions"]):
        row = db.get(AttemptQuestion, question["attempt_question_id"])
        db.refresh(row)
        all_options = [o["option_id"] for o in question["options"]]
        wrong = [o for o in all_options if o not in row.answer_key_snapshot]
        selected = row.answer_key_snapshot if index < correct_count else [wrong[0]]
        response = client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": selected})
        assert response.status_code == 200, response.text


def submit(client: ApiClient, attempt_id) -> dict:
    response = client.post(f"/attempts/{attempt_id}/submit")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def take(db: Session, client: ApiClient, obligation_id, correct_count: int) -> dict:
    attempt = start(client, obligation_id)
    answer_with_score(db, client, attempt, correct_count)
    return submit(client, attempt["attempt_id"])


def relogin(client: ApiClient, email: str) -> ApiClient:
    client.post("/auth/logout")
    response = client.login(email)
    assert response.status_code == 200, response.text
    return client
