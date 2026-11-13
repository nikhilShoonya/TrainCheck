"""Load synthetic development data.  Usage:  python -m app.seed  [--reset]

Results are produced by the real services, so they carry genuine snapshots and scores.
Refuses to run in production. `--reset` replaces every table's contents (see reset_and_seed).
"""
import random
import sys
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import seed_data as S
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.db import Base, get_engine, session_factory
from app.core.enums import AssessmentType, ObligationStatus, RoleCode, TrainingStatus
from app.core.security import hash_password
from app.models import (
    AssessmentConfig,
    AssessmentFeedback,
    AssessmentObligation,
    BehaviourReview,
    BehaviourReviewCycle,
    BehaviourTemplate,
    BehaviourTemplateQuestion,
    CalendarHoliday,  # noqa: F401
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
    QuestionRevision,
    Role,
    Trainer,
    Training,
    TrainingBatch,
    TrainingSession,
    UserAccount,
    UserRole,
    WorkingCalendar,
)
from app.modules.assessment import service as assessment
from app.modules.behaviour import service as behaviour
from app.modules.question_bank.router import revision_snapshot
from app.modules.training.service import record_completion


def _org(db: Session, now: datetime) -> dict:
    departments = {c: Department(code=c, name=n) for c, n in S.DEPARTMENTS}
    functions = {c: Function(code=c, name=n) for c, n in S.FUNCTIONS}
    locations = {c: Location(code=c, name=n) for c, n in S.LOCATIONS}
    db.add_all([*departments.values(), *functions.values(), *locations.values()])
    db.add(WorkingCalendar(code="DEFAULT", name="Illustrative Monday to Friday calendar (not Finvasia policy)", timezone=get_settings().default_timezone, working_weekdays=[0, 1, 2, 3, 4], is_default=True))
    # Reuse role rows that already exist: migration d5a2e7c91f04 creates EMPLOYEE even in an empty database.
    roles = {r.code: r for r in db.scalars(select(Role))}
    for r in RoleCode:
        if r.value not in roles:
            roles[r.value] = Role(code=r.value, name={"EMPLOYEE": "Employee", "LD_ADMIN": "L&D Admin"}[r.value])
            db.add(roles[r.value])
    db.flush()

    password = hash_password(S.DEMO_PASSWORD)
    employees: dict[str, Employee] = {}
    for i, (code, name, email, department, function, grade, _) in enumerate(S.EMPLOYEES):
        employee = Employee(
            employee_code=code,
            full_name=name,
            work_email=email,
            department_id=departments[department].id,
            function_id=functions[function].id if function else None,
            location_id=list(locations.values())[i % 2].id,
            grade=grade,
        )
        db.add(employee)
        employees[code] = employee
    db.flush()
    for code, _, email, *_rest in S.EMPLOYEES:
        account = UserAccount(employee_id=employees[code].id, login_email=email, password_hash=password)
        db.add(account)
        db.flush()
        for role in S.ROLES.get(code, ["EMPLOYEE"]):
            db.add(UserRole(user_account_id=account.id, role_id=roles[role].id))
    start = (now - timedelta(days=400)).date()
    for code, *_rest, manager in S.EMPLOYEES:
        if manager:
            db.add(ManagerAssignment(employee_id=employees[code].id, manager_employee_id=employees[manager].id, effective_from=start))
    db.flush()
    return {"employees": employees, "functions": functions}


def _catalogue(db: Session, org: dict, now: datetime) -> dict:
    competencies = {name: Competency(code=uuid.uuid4().hex[:12].upper(), name=name, description=description) for name, description in S.COMPETENCIES}
    db.add_all(competencies.values())
    trainers = [Trainer(name=n) for n in S.TRAINERS]
    db.add_all(trainers)
    db.flush()

    owner = org["employees"]["A001"]
    trainings: dict[str, Training] = {}
    for i, spec in enumerate(S.TRAININGS):
        training = Training(
            training_code=spec["code"],
            title=spec["title"],
            category=spec["category"],
            description=spec["description"],
            owner_employee_id=owner.id,
            trainer_id=trainers[i % 2].id,
            status=TrainingStatus.ACTIVE,
            pretest_enabled=spec["pretest"],
            refresher_text=S.REFRESHER_TEXT,
            competencies=[competencies[c] for c in spec["competencies"]],
        )
        db.add(training)
        db.flush()
        trainings[spec["code"]] = training
        batch = TrainingBatch(training_id=training.id, batch_code="PILOT", name="November pilot", trainer_id=trainers[i % 2].id, start_date=(now - timedelta(days=70)).date(), end_date=(now - timedelta(days=66)).date())
        db.add(batch)
        db.flush()
        db.add(TrainingSession(batch_id=batch.id, title=f"{spec['title']} session", session_date=(now - timedelta(days=70)).date(), delivery_mode="Virtual"))
        for kind in (AssessmentType.POST_TEST, *([AssessmentType.PRE_TEST] if spec["pretest"] else [])):
            db.add(
                AssessmentConfig(
                    training_id=training.id,
                    assessment_type=kind,
                    version=1,
                    question_count=10,
                    duration_seconds=15 * 60,
                    pass_mark_percent=Decimal("70"),
                    max_attempts=1 if kind == AssessmentType.PRE_TEST else 3,
                    show_explanations=spec["code"] == "T002",
                )
            )
    db.flush()

    for code, bank in S.QUESTION_BANKS.items():
        competency_names = [c for c in next(t for t in S.TRAININGS if t["code"] == code)["competencies"]]
        for i, row in enumerate(bank):
            topic, question_text, correct, *wrong = row
            correct_options = list(correct) if isinstance(correct, tuple) else [correct]
            question_type = S.SPECIAL_TYPES.get((code, i + 1), "MCQ_SINGLE")
            question = Question(
                question_code=f"Q{code[-1]}{i + 1:02d}",
                topic=topic,
                competency_id=competencies[competency_names[i % len(competency_names)]].id,
                question_type=question_type,
                question_text=question_text,
                explanation="Use the approved process and seek guidance when required.",
                difficulty="EASY" if i < 4 else "MEDIUM" if i < 8 else "HARD",
                marks=Decimal("1"),
                trainings=[trainings[code]],
            )
            db.add(question)
            db.flush()
            for order, option_text in enumerate([*correct_options, *wrong]):
                option = QuestionOption(question_id=question.id, option_text=option_text, display_order=order)
                db.add(option)
                db.flush()
                if option_text in correct_options:
                    db.add(QuestionAnswerKey(question_id=question.id, option_id=option.id))
            db.flush()
            db.add(QuestionRevision(question_id=question.id, version=1, content_snapshot=revision_snapshot(db, question)))
    db.flush()

    for name, training_code, function_code, questions in S.BEHAVIOUR_TEMPLATES:
        template = BehaviourTemplate(
            code=f"BT-{uuid.uuid4().hex[:8]}",
            name=name,
            training_id=trainings[training_code].id if training_code else None,
            function_id=org["functions"][function_code].id if function_code else None,
        )
        db.add(template)
        db.flush()
        for order, (competency, prompt) in enumerate(questions, start=1):
            db.add(BehaviourTemplateQuestion(template_id=template.id, competency_id=competencies[competency].id, prompt=prompt, display_order=order))
    db.flush()
    return {"trainings": trainings}


def _enrol(db: Session, employee: Employee, training: Training, assigned: datetime) -> Enrolment:
    batch = db.scalar(select(TrainingBatch).where(TrainingBatch.training_id == training.id))
    enrolment = Enrolment(training_id=training.id, batch_id=batch.id, employee_id=employee.id, assigned_at=assigned)
    db.add(enrolment)
    db.flush()
    return enrolment


def _take(db: Session, obligation: AssessmentObligation, score: int, at: datetime, rng: random.Random) -> None:
    """Runs one real attempt, answering correctly often enough to reach the wanted score out of 10."""
    db.refresh(obligation)
    if obligation.assessment_type == AssessmentType.POST_TEST:
        obligation.status = ObligationStatus.DUE  # The backdated attempt needs the obligation open at that moment.
        obligation.due_at = min(obligation.due_at or at, at)
        db.flush()
    if obligation.attempts and obligation.refresher_acknowledged_at is None:
        assessment.acknowledge_refresher(db, obligation, now=at)
        db.flush()
    attempt = assessment.start_attempt(db, obligation, True, now=at, rng=rng)
    db.flush()
    db.refresh(attempt)
    for index, question in enumerate(attempt.questions):
        options = [o["option_id"] for o in question.options_snapshot]
        wrong = [o for o in options if o not in question.answer_key_snapshot]
        selected = question.answer_key_snapshot if index < score // 10 else [wrong[0]]
        assessment.save_answer(db, attempt, question.id, selected, now=at + timedelta(minutes=1))
    assessment.finalise_attempt(db, attempt.id, now=at + timedelta(minutes=9))
    db.flush()


def _post(db: Session, enrolment: Enrolment) -> AssessmentObligation:
    return db.scalar(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == AssessmentType.POST_TEST))


def _review(db: Session, enrolment: Enrolment, period: int, kind: str, rating: int, submitter: Employee, at: datetime) -> None:
    review = db.scalar(
        select(BehaviourReview)
        .join(BehaviourReview.cycle)
        .where(BehaviourReviewCycle.enrolment_id == enrolment.id, BehaviourReviewCycle.period_days == period, BehaviourReview.reviewer_type == kind)
    )
    if review is None:
        return
    responses = [{"template_question_id": q.id, "rating": rating, "example_text": S.EXAMPLE_TEXT, "comment_text": None} for q in review.cycle.template.questions]
    behaviour.submit_review(db, review, submitter.id, responses, now=at)


def _feedback(db: Session, enrolment: Enrolment, ratings: tuple[int, int, int, int, int], comment: str | None) -> None:
    """The employee's feedback, given just after the first submitted attempt of the post-training assessment."""
    obligation = _post(db, enrolment)
    db.refresh(obligation)
    first = obligation.attempts[0]
    relevance, clarity, alignment, fairness, confidence = ratings
    db.add(
        AssessmentFeedback(
            obligation_id=obligation.id,
            attempt_id=first.id,
            employee_id=enrolment.employee_id,
            training_id=enrolment.training_id,
            relevance_rating=relevance,
            clarity_rating=clarity,
            alignment_rating=alignment,
            fairness_rating=fairness,
            confidence_rating=confidence,
            comment_text=comment,
            submitted_at=first.submitted_at + timedelta(minutes=3),
        )
    )
    db.flush()


def _pre_test(db: Session, enrolment: Enrolment, score: int, at: datetime, rng: random.Random) -> None:
    config = assessment.active_config(db, enrolment.training_id, AssessmentType.PRE_TEST)
    obligation = AssessmentObligation(enrolment_id=enrolment.id, employee_id=enrolment.employee_id, training_id=enrolment.training_id, config_id=config.id, assessment_type=AssessmentType.PRE_TEST, status=ObligationStatus.DUE, due_at=at)
    db.add(obligation)
    db.flush()
    _take(db, obligation, score, at, rng)


def _scenarios(db: Session, org: dict, catalogue: dict, now: datetime) -> None:
    e, t = org["employees"], catalogue["trainings"]
    rng = random.Random(20261105)
    old = now - timedelta(days=75)

    # E001: two due assessments, so the mandatory gate opens first, like the prototype.
    for days, code in ((5, "T001"), (4, "T002")):
        record_completion(db, _enrol(db, e["E001"], t[code], old), now - timedelta(days=days), "MANUAL", None)

    # E002: nothing blocking. Passed two trainings, has behaviour history, and one training with a pre-test open.
    done = _enrol(db, e["E002"], t["T001"], old)
    _pre_test(db, done, 50, now - timedelta(days=66), rng)
    record_completion(db, done, now - timedelta(days=65), "MANUAL", None)
    _take(db, _post(db, done), 90, now - timedelta(days=64), rng)
    _review(db, done, 30, "SELF", 3, e["E002"], now - timedelta(days=34))
    _review(db, done, 60, "SELF", 4, e["E002"], now - timedelta(days=4))
    second = _enrol(db, e["E002"], t["T002"], old)
    record_completion(db, second, now - timedelta(days=20), "MANUAL", None)
    _take(db, _post(db, second), 80, now - timedelta(days=19), rng)
    _enrol(db, e["E002"], t["T003"], now - timedelta(days=2))

    # E003: failed once with a retake pending, plus one pass with learning gain.
    failed = _enrol(db, e["E003"], t["T002"], old)
    record_completion(db, failed, now - timedelta(days=10), "MANUAL", None)
    _take(db, _post(db, failed), 60, now - timedelta(days=9), rng)
    passed = _enrol(db, e["E003"], t["T001"], old)
    _pre_test(db, passed, 40, now - timedelta(days=41), rng)
    record_completion(db, passed, now - timedelta(days=40), "MANUAL", None)
    _take(db, _post(db, passed), 80, now - timedelta(days=39), rng)
    _review(db, passed, 30, "SELF", 4, e["E003"], now - timedelta(days=9))

    # E004: three failures, so Needs Re-training with the first, best and latest scores kept apart.
    final = _enrol(db, e["E004"], t["T001"], old)
    record_completion(db, final, now - timedelta(days=15), "MANUAL", None)
    for offset, score in ((14, 40), (12, 50), (10, 60)):
        _take(db, _post(db, final), score, now - timedelta(days=offset), rng)

    # E005 and the second team: a mix of passes, a timed scenario and pending work.
    for code, days, score in (("E005", 12, 100), ("E006", 45, 70), ("E007", 31, 80), ("E008", 8, 90), ("E009", 8, 60)):
        enrolment = _enrol(db, e[code], t["T002" if code != "E005" else "T003"], old)
        record_completion(db, enrolment, now - timedelta(days=days), "MANUAL", None)
        _take(db, _post(db, enrolment), score, now - timedelta(days=days - 1), rng)
    observed = db.scalar(select(Enrolment).where(Enrolment.employee_id == e["E006"].id))
    _review(db, observed, 30, "SELF", 4, e["E006"], now - timedelta(days=14))

    # Feedback given after the post-training assessments. E004 and E009 have not given theirs.
    _feedback(db, done, (5, 4, 5, 4, 5), "Clear examples. The scenario questions matched what we practised.")
    _feedback(db, second, (4, 4, 4, 3, 4), "The time limit felt a little tight for the scenario questions.")
    _feedback(db, failed, (4, 3, 3, 3, 3), "Some assessment questions covered topics only touched on briefly in the session.")
    _feedback(db, passed, (5, 5, 4, 4, 5), None)
    for code, ratings, comment in (
        ("E005", (5, 5, 5, 5, 5), "Very useful for my daily work."),
        ("E006", (3, 4, 4, 4, 3), None),
        ("E007", (4, 5, 4, 4, 4), "Good pace and well explained."),
        ("E008", (5, 4, 5, 5, 4), None),
    ):
        _feedback(db, db.scalar(select(Enrolment).where(Enrolment.employee_id == e[code].id)), ratings, comment)

    # E010: assigned only; completion not yet recorded.
    _enrol(db, e["E010"], t["T002"], now - timedelta(days=3))
    db.flush()


def seed(db: Session, now: datetime | None = None) -> None:
    now = now or utcnow()
    org = _org(db, now)
    catalogue = _catalogue(db, org, now)
    _scenarios(db, org, catalogue, now)
    db.commit()


BUILD_SCHEMA = "demo_build"


def _swap_sql() -> str:
    """One statement that empties every application table and copies the freshly built rows in.

    A single DO block, so the switch is one round trip and the tables are locked only for that moment.
    Columns are named explicitly: the live tables were built by migrations, so their column order can differ.
    """
    tables = Base.metadata.sorted_tables
    everything = ", ".join(f'public."{t.name}"' for t in tables)
    copies = "\n".join(
        f'  INSERT INTO public."{t.name}" ({cols}) SELECT {cols} FROM {BUILD_SCHEMA}."{t.name}";'  # noqa: S608 - names come from the app's own table metadata, never from input
        for t in tables
        for cols in [", ".join(f'"{c.name}"' for c in t.columns)]
    )
    return f"DO $reset$\nBEGIN\n  TRUNCATE {everything} RESTART IDENTITY CASCADE;\n{copies}\nEND\n$reset$"


def reset_and_seed(now: datetime | None = None) -> None:
    """Replace every table's contents with freshly generated synthetic data, all or nothing.

    Generating the data takes many small queries, which is slow against a remote database such as Neon.
    So it is built first in a private schema while the application keeps working normally, and only then
    swapped into the live tables in one short step. Everything runs in one transaction: if anything fails,
    the live data is untouched and the private schema disappears with the rollback.
    """
    if get_settings().is_production:
        raise RuntimeError("Refusing to load synthetic data in production.")
    with get_engine().connect() as connection, connection.begin():
        connection.exec_driver_sql(f"DROP SCHEMA IF EXISTS {BUILD_SCHEMA} CASCADE")
        connection.exec_driver_sql(f"CREATE SCHEMA {BUILD_SCHEMA}")
        # Every unqualified name now means the private schema, for the ORM and for the services alike.
        connection.exec_driver_sql(f"SET LOCAL search_path TO {BUILD_SCHEMA}")
        Base.metadata.create_all(connection, checkfirst=False)
        # The session joins this transaction through a savepoint, so seed()'s commit cannot end it early.
        with Session(bind=connection, autoflush=False, expire_on_commit=False, join_transaction_mode="create_savepoint") as db:
            seed(db, now)
        connection.exec_driver_sql("SET LOCAL search_path TO public")
        connection.exec_driver_sql(_swap_sql())
        connection.exec_driver_sql(f"DROP SCHEMA {BUILD_SCHEMA} CASCADE")


def main() -> None:
    settings = get_settings()
    if settings.is_production:
        sys.exit("Refusing to load synthetic data in production.")
    if "--reset" in sys.argv:
        reset_and_seed()
        print("Synthetic data loaded. Sign in with the demo accounts; the password is in app/seed_data.py.")
        return
    with session_factory()() as db:
        if db.scalar(select(Employee.id).limit(1)):
            sys.exit("Data already exists. Use --reset to erase it and load the synthetic data again.")
        seed(db)
    print("Synthetic data loaded. Sign in with the demo accounts; the password is in app/seed_data.py.")


if __name__ == "__main__":
    main()

