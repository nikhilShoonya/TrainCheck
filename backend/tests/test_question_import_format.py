"""The simplified MCQ import format (CSV, XLSX and PDF: question, option_a-d, correct, topic), backend defaults,
generated IDs, and content-based duplicate and conflict handling. All data is synthetic; the database is the
disposable test PostgreSQL."""
import csv
import io
import json
import re
import threading
import time

import pytest
from openpyxl import Workbook
from reportlab.pdfgen import canvas
from sqlalchemy import func, select

from app.core.enums import ImportStatus, ImportType
from app.models import Competency, ImportJob, ImportJobRow, Question, QuestionAnswerKey, QuestionOption, QuestionRevision, QuestionTrainingTag, UserAccount
from app.modules.imports import question_format as qf
from app.modules.imports import service
from app.modules.imports.question_format import FIELDS
from tests.conftest import NOW, start, take

CODE = re.compile(r"^Q-[0-9A-F]{10}$")


def row(question: str, /, **changes) -> dict[str, str]:
    values = {"question": question, "option_a": "Right", "option_b": "Wrong", "option_c": "Maybe", "option_d": "Never", "correct": "A", "topic": "Topic"}
    values.update(changes)
    return values


def csv_file(rows: list[dict[str, str]], header: list[str] | None = None) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    header = header or FIELDS
    writer.writerow(header)
    for values in rows:
        writer.writerow([values.get(h, "") for h in header])
    return buffer.getvalue().encode()


def xlsx_file(rows: list[list]) -> bytes:
    workbook = Workbook()
    for values in rows:
        workbook.active.append(values)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def pdf_file(rows: list[dict[str, str]]) -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    y = 800
    for values in rows:
        for line in [f"{f}: {values[f]}" for f in FIELDS] + ["---"]:
            if y < 50:
                pdf.showPage()
                y = 800
            pdf.drawString(40, y, line)
            y -= 15
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def validate(client, training, content: bytes, name="q.csv", test_type="POST_TEST"):
    return client.post("/admin/imports", files={"file": (name, content)}, data={"import_type": "QUESTIONS", "training_id": str(training.id), "test_type": test_type})


def validated(client, training, content: bytes, name="q.csv", test_type="POST_TEST") -> dict:
    response = validate(client, training, content, name, test_type)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def commit(client, job: dict) -> dict:
    response = client.post(f"/admin/imports/{job['id']}/commit")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def imported(client, training, rows: list[dict[str, str]], test_type="POST_TEST") -> dict:
    job = validated(client, training, csv_file(rows), test_type=test_type)
    assert job["accepted_rows"] == len(rows), job["rows"]
    return commit(client, job)


def statuses(job: dict) -> list[str]:
    return [r["status"] for r in job["rows"]]


def messages(job: dict, index: int) -> str:
    return " ".join(e["message"] for e in job["rows"][index]["errors"])


# ---------- One format, three file types ----------

EQUIVALENT = [
    row("Which, if any, of these documents is acceptable?", option_a="A current bill", option_b="An expired passport", option_c="A blank form, unsigned", option_d="None of these", correct="a", topic="Identity checks"),
    row("How many days does a customer have to respond?", option_a="10", option_b="20", option_c="30", option_d="40", correct="C", topic="Timelines"),
    row("Is a photocopy enough on its own?", option_a="True", option_b="False", option_c="Only when certified", option_d="Only for existing customers", correct=" c ", topic="Identity checks"),
]


def test_csv_xlsx_and_pdf_files_normalise_to_the_same_questions(world, db, client_for):
    admin = client_for(world.admin)
    trainings = {fmt: world.training(f"EQ-{fmt.upper()}", questions=0, count=1) for fmt in ("csv", "xlsx", "pdf")}
    for fmt, training in trainings.items():
        if fmt == "csv":
            content = csv_file(EQUIVALENT)
        elif fmt == "xlsx":
            # Typed cells, as Excel stores them: numbers stay numbers and True/False become booleans.
            typed = {"10": 10, "20": 20, "30": 30, "40": 40, "True": True, "False": False}
            content = xlsx_file([FIELDS, *[[typed.get(r[f], r[f]) for f in FIELDS] for r in EQUIVALENT]])
        else:
            content = pdf_file(EQUIVALENT)
        job = validated(admin, training, content, name=f"q.{fmt}")
        assert (job["accepted_rows"], job["rejected_rows"]) == (3, 0), job["rows"]
        assert commit(admin, job)["status"] == "COMPLETED"
    db.expire_all()

    def stored(training) -> list[tuple]:
        questions = db.scalars(select(Question).join(QuestionTrainingTag).where(QuestionTrainingTag.training_id == training.id).order_by(Question.question_text)).all()
        keys = set(db.scalars(select(QuestionAnswerKey.option_id)))
        return [(q.question_text, q.topic, tuple(o.option_text for o in q.options), tuple(o.option_text for o in q.options if o.id in keys), q.question_type, q.marks, q.difficulty, q.competency_id, q.explanation, q.department_id, q.language, q.status) for q in questions]

    csv_questions = stored(trainings["csv"])
    assert csv_questions == stored(trainings["xlsx"]) == stored(trainings["pdf"])
    by_text = {q[0]: q for q in csv_questions}
    assert by_text["How many days does a customer have to respond?"][2:4] == (("10", "20", "30", "40"), ("30",))
    assert by_text["Is a photocopy enough on its own?"][2:4] == (("True", "False", "Only when certified", "Only for existing customers"), ("Only when certified",))
    assert by_text["Which, if any, of these documents is acceptable?"][3] == ("A current bill",)  # "a" is A.


def test_csv_quoting_line_breaks_and_text_kept_as_supplied(world, db, client_for):
    training = world.training("CSVQ", questions=0, count=1)
    admin = client_for(world.admin)
    content = csv_file([row("First line, with a comma\nSecond line?", option_a='Say "yes", politely')])
    job = validated(admin, training, content)
    assert job["accepted_rows"] == 1, job["rows"]
    commit(admin, job)
    db.expire_all()
    question = db.scalar(select(Question))
    assert question.question_text == "First line, with a comma\nSecond line?"  # Stored as supplied.
    assert [o.option_text for o in question.options] == ['Say "yes", politely', "Wrong", "Maybe", "Never"]

    # The same question from a PDF (where the line break cannot be kept) is the same question.
    again = validated(admin, training, pdf_file([row("First line, with a comma Second line?", option_a='Say "yes", politely')]), name="q.pdf")
    assert statuses(again) == ["DUPLICATE"]


def test_formulas_in_spreadsheet_cells_are_refused(world, client_for):
    training = world.training("XF", questions=0, count=1)
    values = row("Q?")
    content = xlsx_file([FIELDS, ["=1+1"] + [values[f] for f in FIELDS[1:]]])
    response = validate(client_for(world.admin), training, content, name="q.xlsx")
    assert response.status_code == 400 and "formula" in response.json()["error"]["message"]


# ---------- Headers ----------

PREVIOUS_TEMPLATE = ["training", "department", "topic", "competency", "question", "option_a", "option_b", "option_c", "option_d", "options_extra", "correct", "explanation", "difficulty", "marks"]


@pytest.mark.parametrize(
    ("header", "message"),
    [
        (["training", *FIELDS], "old question template (column training)"),
        ([*FIELDS, "difficulty", "marks"], "old question template (columns difficulty, marks)"),
        ([*FIELDS, "competency"], "old question template (column competency)"),
        (["id", *FIELDS], "old question template (column id)"),
        (PREVIOUS_TEMPLATE, "old question template (columns training, department, competency, options_extra, explanation, difficulty, marks)"),
        ([*FIELDS, "notes"], "Unknown columns: notes"),
        ([f for f in FIELDS if f != "topic"], "Missing columns: topic"),
        ([*FIELDS, "question"], "more than once: question"),
    ],
)
def test_headers_must_be_the_new_template(world, db, client_for, header, message):
    training = world.training("HDR", questions=0, count=1)
    response = validate(client_for(world.admin), training, csv_file([row("Q?")], header))
    assert response.status_code == 400 and response.json()["error"]["code"] == "INVALID_HEADERS"
    assert message in response.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_headers_ignore_case_and_order(world, client_for):
    training = world.training("ORDER", questions=0, count=1)
    header = [h.upper() for h in reversed(FIELDS)]
    content = csv_file([{h.upper(): v for h, v in row("Any order?").items()}], header)
    assert validated(client_for(world.admin), training, content)["accepted_rows"] == 1


# ---------- Field validation ----------

@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"question": ""}, "question", "Required."),
        ({"topic": ""}, "topic", "Required."),
        ({"option_c": ""}, "option_c", "Required."),
        ({"option_d": ""}, "option_d", "Required."),
        ({"correct": ""}, "correct", "Required."),
        ({"question": "Hi"}, "question", "at least 3 characters"),
        ({"question": "Q" * 4001}, "question", "at most 4,000 characters"),
        ({"topic": "T" * 161}, "topic", "at most 160 characters"),
        ({"option_d": " right "}, "option_d", "same as option_a"),
        ({"option_c": "WRONG"}, "option_c", "same as option_b"),
        ({"correct": "E"}, "correct", "one letter: A, B, C or D"),
        ({"correct": "AB"}, "correct", "one letter: A, B, C or D"),
        ({"correct": "1"}, "correct", "one letter: A, B, C or D"),
        ({"correct": "A|C"}, "correct", "exactly one correct letter"),
        ({"correct": "A, B"}, "correct", "exactly one correct letter"),
        ({"option_b": "=cmd()"}, "option_b", "not formulas"),
        ({"question": "=HYPERLINK(\"x\")"}, "question", "not formulas"),
    ],
)
def test_invalid_fields_are_reported_per_row(world, db, client_for, changes, field, message):
    training = world.training("VAL", questions=0, count=1)
    job = validated(client_for(world.admin), training, csv_file([row("Valid question?", **changes)]))
    assert statuses(job) == ["INVALID"]
    problems = {e["field"]: e["message"] for e in job["rows"][0]["errors"]}
    assert field in problems and message in problems[field], problems
    assert db.scalar(select(func.count()).select_from(Question)) == 0


# ---------- Backend-managed fields ----------

def test_defaults_ids_status_and_language_are_set_by_traincheck(world, db, client_for):
    training = world.training("MANAGED", questions=0, count=1)
    admin = client_for(world.admin)
    competencies_before = db.scalar(select(func.count()).select_from(Competency))
    hindi = "ग्राहक का पता प्रमाण पुराना है। आप क्या करेंगे?"
    done = imported(admin, training, [row(hindi), row("Plain English?", correct="D")])
    assert done["status"] == "COMPLETED" and done["counts"]["IMPORTED"] == 2
    assert all(CODE.match(r["record"].split(" · ")[0]) for r in done["rows"])  # The generated ID is shown after import.
    db.expire_all()
    questions = {q.question_text: q for q in db.scalars(select(Question))}
    assert questions[hindi].question_text == hindi  # Never translated.
    for question in questions.values():
        assert CODE.match(question.question_code)
        assert (question.question_type, question.marks, question.difficulty, question.language, question.status) == ("MCQ_SINGLE", 1, "EASY", "English", "ACTIVE")
        assert (question.competency_id, question.explanation, question.department_id, question.function_id) == (None, None, None, None)
        assert len(question.options) == 4
    assert db.scalar(select(func.count()).select_from(Competency)) == competencies_before  # No competency invented.
    assert db.scalar(select(func.count()).select_from(QuestionRevision)) == 2  # Version 1 of each, as before.
    shown = admin.get(f"/admin/questions/{questions[hindi].id}").json()["data"]
    assert (shown["competency"], shown["explanation"], shown["marks"]) == (None, None, 1)

    # L&D adjusts the question through the existing Question Bank edit: Scenario, Hindi, Hard, 2 marks, a competency
    # and an explanation. Re-importing the department's unchanged row is still the same question: a duplicate.
    question = questions[hindi]
    full = admin.get(f"/admin/questions/{question.id}").json()["data"]
    body = {k: full[k] for k in ("question_code", "topic", "question_text", "status", "randomise_options")}
    body["expected_version"] = full["version"]
    body.update(question_type="SCENARIO", language="Hindi", difficulty="HARD", marks=2, explanation="Because.", competency_id=str(world.competency.id), options=[o["text"] for o in full["options"]], correct_option_indexes=[i for i, o in enumerate(full["options"]) if o["is_correct"]], training_ids=[str(training.id)])
    edited = admin.patch(f"/admin/questions/{question.id}", json=body)
    assert edited.status_code == 200, edited.text
    data = edited.json()["data"]
    assert (data["language"], data["question_type"], data["difficulty"], data["version"]) == ("Hindi", "SCENARIO", "HARD", 2)
    assert {t["test_type"] for t in data["trainings"]} == {"POST_TEST"}  # The import's classification is kept.
    again = validated(admin, training, csv_file([row(hindi)]))
    assert statuses(again) == ["DUPLICATE"]


def test_generated_ids_are_unique(world, db, client_for):
    training = world.training("IDS", questions=0, count=1)
    admin = client_for(world.admin)
    imported(admin, training, [row(f"Question number {i}?") for i in range(60)])
    codes = list(db.scalars(select(Question.question_code)))
    assert len(codes) == len(set(codes)) == 60 and all(CODE.match(c) for c in codes)


def test_a_generated_id_already_in_use_is_never_reused(world, db, client_for, monkeypatch):
    training = world.training("IDC", questions=0, count=1)
    taken = world.question(training, "Q-AAAAAAAAAA")
    db.commit()
    # The random part first repeats an existing ID: TrainCheck checks and draws another.
    draws = iter(["aaaaaaaaaa", "bbbbbbbbbb"])
    monkeypatch.setattr(qf.secrets, "token_hex", lambda n: next(draws))
    imported(client_for(world.admin), training, [row("Fresh?")])
    db.expire_all()
    assert db.scalar(select(Question.question_code).where(Question.question_text == "Fresh?")) == "Q-BBBBBBBBBB"
    assert db.get(Question, taken.id).question_text == "Question Q-AAAAAAAAAA?"


def test_an_id_taken_by_a_concurrent_insert_is_retried(world, db, client_for, monkeypatch):
    training = world.training("IDR", questions=0, count=1)
    world.question(training, "Q-CCCCCCCCCC")
    db.commit()
    real = qf.new_code
    calls = []

    def racing(session, taken):
        calls.append(1)
        return "Q-CCCCCCCCCC" if len(calls) == 1 else real(session, taken)  # As if another request inserted it meanwhile.

    monkeypatch.setattr(qf, "new_code", racing)
    done = imported(client_for(world.admin), training, [row("Raced?")])
    assert done["counts"]["IMPORTED"] == 1 and len(calls) == 2
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 2


# ---------- Duplicates and conflicts ----------

def test_repeated_uploads_skip_unchanged_content(world, db, client_for):
    training = world.training("REPEAT", questions=0, count=1)
    admin = client_for(world.admin)
    content = csv_file([row(f"Repeat {i}?") for i in range(5)])
    commit(admin, validated(admin, training, content))
    again = validated(admin, training, content)
    assert statuses(again) == ["DUPLICATE"] * 5 and again["counts"]["DUPLICATE"] == 5
    assert "already in this training's Post-test pool as Q-" in messages(again, 0)
    done = commit(admin, again)
    assert (done["accepted_rows"], done["status"]) == (0, "COMPLETED_WITH_ERRORS")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 5


def test_normalisation_is_conservative(world, db, client_for):
    training = world.training("NORM", questions=0, count=1)
    admin = client_for(world.admin)
    imported(admin, training, [row("Is the customer's file complete?", option_a="Yes, it is", option_b="No")])
    rows = [
        row("  is THE customer’s   file\ncomplete?  ", option_a="YES,  it is", option_b="no"),  # Case, spaces, curly quote.
        row("Is the customer's file complete", option_a="Yes, it is", option_b="No"),  # Punctuation differs: another question.
        row("Is the customer's file complete?", option_a="No", option_b="Yes, it is", correct="B"),  # Same options, reordered.
    ]
    job = validated(admin, training, csv_file(rows))
    assert statuses(job) == ["DUPLICATE", "VALID", "DUPLICATE"], job["rows"]


@pytest.mark.parametrize(
    ("changes", "difference"),
    [
        ({"correct": "B"}, "correct answer"),
        ({"option_b": "Wrong again"}, "answer options"),
        ({"topic": "Another topic"}, "topic"),
    ],
)
def test_changed_content_is_a_conflict_and_never_overwrites(world, db, client_for, changes, difference):
    training = world.training("CONF", questions=0, count=1)
    admin = client_for(world.admin)
    imported(admin, training, [row("Stable question?")])
    db.expire_all()
    existing = db.scalar(select(Question))
    before = (existing.version, existing.topic, [o.option_text for o in existing.options], set(db.scalars(select(QuestionAnswerKey.option_id))))
    job = validated(admin, training, csv_file([row("Stable question?", **changes)]))
    assert statuses(job) == ["CONFLICT"] and job["counts"]["CONFLICT"] == 1
    message = messages(job, 0)
    assert difference in message and f"edit {existing.question_code} in the Question Bank" in message
    assert "Which of the following is correct?" in message  # The generic-stem explanation.
    assert commit(admin, job)["counts"]["CONFLICT"] == 1
    db.expire_all()
    existing = db.get(Question, existing.id)
    assert (existing.version, existing.topic, [o.option_text for o in existing.options], set(db.scalars(select(QuestionAnswerKey.option_id)))) == before
    assert db.scalar(select(func.count()).select_from(Question)) == 1


def test_conflicts_within_one_file_import_neither_row(world, db, client_for):
    training = world.training("INFILE", questions=0, count=1)
    admin = client_for(world.admin)
    rows = [row("Which of the following is correct?", option_a="One", option_b="Two"), row("Which of the following is correct?", option_a="Three", option_b="Four"), row("Distinct?")]
    job = validated(admin, training, csv_file(rows))
    assert statuses(job) == ["CONFLICT", "CONFLICT", "VALID"]
    assert "Rows 2, 3 have the same question text but different answer options" in messages(job, 0)
    assert "reword the question text" in messages(job, 1)
    commit(admin, job)
    db.expire_all()
    assert list(db.scalars(select(Question.question_text))) == ["Distinct?"]


def test_duplicates_include_legacy_links_inactive_and_older_questions(world, db, client_for):
    """Questions created before this change (file-supplied IDs, unclassified links, competencies, explanations,
    other types) are matched on the content a department file supplies."""
    training = world.training("HIST", questions=0, count=1)
    legacy = world.question(training, "OLD-ID-7", marks=2, difficulty="HARD")  # Unclassified link, other marks.
    scenario = world.question(training, "SCN-1", question_type="SCENARIO")
    multiple = world.question(training, "MUL-1", question_type="MCQ_MULTIPLE", correct=2)
    inactive = world.question(training, "INA-3")
    inactive.status = "INACTIVE"
    db.commit()

    def same(question) -> dict[str, str]:
        code = question.question_code
        return row(question.question_text, topic=question.topic, option_a=f"{code} option 0", option_b=f"{code} option 1", option_c=f"{code} option 2", option_d=f"{code} option 3")

    admin = client_for(world.admin)
    for test_type in ("PRE_TEST", "POST_TEST"):
        job = validated(admin, training, csv_file([same(legacy), same(scenario), same(inactive), same(multiple)]), test_type=test_type)
        assert statuses(job) == ["DUPLICATE", "DUPLICATE", "DUPLICATE", "CONFLICT"], job["rows"]
        assert "as OLD-ID-7" in messages(job, 0) and "It is Inactive" in messages(job, 2)
        assert "single or multiple answer" in messages(job, 3) and "MUL-1" in messages(job, 3)
    changed = validated(admin, training, csv_file([{**same(legacy), "correct": "B"}]))
    assert statuses(changed) == ["CONFLICT"] and "OLD-ID-7" in messages(changed, 0)
    db.expire_all()
    assert db.get(Question, inactive.id).status == "INACTIVE"  # Activation stays with L&D Admin.
    assert db.get(Question, legacy.id).marks == 2  # Never overwritten with the import default.


def test_the_other_test_type_and_other_trainings_are_kept_apart(world, db, client_for):
    training = world.training("APART", questions=0, count=1)
    other = world.training("ELSEWHERE", questions=0, count=1)
    admin = client_for(world.admin)
    imported(admin, training, [row("Shared wording?")], test_type="PRE_TEST")
    post = validated(admin, training, csv_file([row("Shared wording?")]), test_type="POST_TEST")
    assert statuses(post) == ["VALID"] and "creates a separate Post-test question" in messages(post, 0)
    done = commit(admin, post)
    assert "creates a separate Post-test question" in messages(done, 0)  # The note stays after import.
    elsewhere = validated(admin, other, csv_file([row("Shared wording?")]))
    assert statuses(elsewhere) == ["VALID"] and elsewhere["rows"][0]["errors"] == []
    commit(admin, elsewhere)
    db.expire_all()
    links = db.execute(select(QuestionTrainingTag.question_id, QuestionTrainingTag.training_id, QuestionTrainingTag.test_type)).all()
    assert sorted((t, tt) for _, t, tt in links) == sorted([(training.id, "PRE_TEST"), (training.id, "POST_TEST"), (other.id, "POST_TEST")])
    assert len({q for q, _, _ in links}) == 3  # Three separate questions; no existing link was changed.


def test_concurrent_confirmations_of_the_same_file_import_once(world, db, client_for, monkeypatch):
    """Two previews of the same file, confirmed at the same moment by two admin sessions, import each question once."""
    training = world.training("RACE", questions=0, count=1)
    first, second = client_for(world.admin), client_for(world.admin)
    content = csv_file([row(f"Race {i}?") for i in range(4)])
    jobs = [validated(first, training, content), validated(second, training, content)]

    # Both requests reach the lock together, and each holds its pool a moment before inserting: without the
    # training lock, both would see an empty pool and import every question twice.
    barrier = threading.Barrier(2)
    real_lock, real_pool = service.lock_training_imports, qf.Pool

    def lock(session, training_id):
        barrier.wait(timeout=10)
        real_lock(session, training_id)

    def slow_pool(*args):
        pool = real_pool(*args)
        time.sleep(0.3)
        return pool

    monkeypatch.setattr(service, "lock_training_imports", lock)
    monkeypatch.setattr(qf, "Pool", slow_pool)
    results: list = [None, None]

    def confirm(index, client):
        results[index] = client.post(f"/admin/imports/{jobs[index]['id']}/commit")

    threads = [threading.Thread(target=confirm, args=(i, c)) for i, c in enumerate((first, second))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert all(r is not None and r.status_code == 200 for r in results), results
    imported_counts = sorted(r.json()["data"]["counts"]["IMPORTED"] for r in results)
    assert imported_counts == [0, 4]
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Question)) == 4


def test_a_double_confirmation_of_one_preview_is_refused(world, db, client_for):
    training = world.training("TWICE", questions=0, count=1)
    admin = client_for(world.admin)
    job = validated(admin, training, csv_file([row("Once?")]))
    commit(admin, job)
    again = admin.post(f"/admin/imports/{job['id']}/commit")
    assert again.status_code == 409 and again.json()["error"]["code"] == "IMPORT_ALREADY_PROCESSED"
    assert db.scalar(select(func.count()).select_from(Question)) == 1


# ---------- Old previews and history ----------

def _admin_account(db, world):
    return db.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.admin.id))


@pytest.mark.parametrize("payload_format", [None, 2])
def test_older_pending_previews_must_be_revalidated_and_history_stays_viewable(world, db, client_for, payload_format):
    """Previews validated with the ID-based template (no format) or the 14-field template (format 2)."""
    training = world.training("LEGACYP", questions=0, count=1)
    admin = client_for(world.admin)
    account = _admin_account(db, world)
    old_payload = {"training_id": str(training.id), "test_type": "POST_TEST", "topic": "T", "competency": "C", "question_type": "MCQ_SINGLE", "question_text": "Old?", "options": ["A", "B"], "correct": [0], "explanation": None, "difficulty": "MEDIUM", "marks": "2", "department_id": None}
    if payload_format:
        old_payload["format"] = payload_format
    else:
        old_payload.update(question_code="OLD-9", language="English", status="ACTIVE", function_id=None)
    pending = ImportJob(import_type=ImportType.QUESTIONS, uploaded_by=account, file_name="old.csv", status=ImportStatus.READY, total_rows=1, accepted_rows=1, rejected_rows=0, created_at=NOW, training_id=training.id, test_type="POST_TEST")
    done = ImportJob(import_type=ImportType.QUESTIONS, uploaded_by=account, file_name="done.csv", status=ImportStatus.COMPLETED, total_rows=1, accepted_rows=1, rejected_rows=0, created_at=NOW, completed_at=NOW, training_id=training.id, test_type="POST_TEST")
    db.add_all([pending, done])
    db.flush()
    db.add_all([
        ImportJobRow(import_job_id=pending.id, row_number=2, row_status="VALID", record_label="Old?", errors=[], payload=old_payload),
        ImportJobRow(import_job_id=done.id, row_number=2, row_status="IMPORTED", record_label="OLD-8", errors=[], payload=old_payload),
    ])
    db.commit()

    preview = admin.get(f"/admin/imports/{pending.id}").json()["data"]
    assert preview["needs_revalidation"] is True
    refused = admin.post(f"/admin/imports/{pending.id}/commit")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "IMPORT_NEEDS_REVALIDATION"
    assert "old question template" in refused.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(Question)) == 0

    history = admin.get(f"/admin/imports/{done.id}").json()["data"]
    assert (history["status"], history["needs_revalidation"], history["rows"][0]["record"]) == ("COMPLETED", False, "OLD-8")
    assert admin.get(f"/admin/imports/{done.id}/error-report").status_code == 200
    assert admin.delete(f"/admin/imports/{done.id}").json()["data"] == {"deleted": True}
    db.expire_all()
    assert db.get(ImportJob, done.id).deleted_at is not None  # The source record is retained.
    assert admin.get(f"/admin/imports/{done.id}").status_code == 404
    assert str(done.id) not in {j["id"] for j in admin.get("/admin/imports").json()["data"]}

    edited = admin.post(f"/admin/imports/{pending.id}/replace", files={"file": ("new.csv", csv_file([row("New format?")]))}, data={"training_id": str(training.id), "test_type": "POST_TEST"}).json()["data"]
    assert edited["needs_revalidation"] is False and commit(admin, edited)["counts"]["IMPORTED"] == 1


# ---------- Difficulty mix ----------

def test_a_difficulty_mix_needing_medium_or_hard_is_reported(world, db, client_for):
    """Imported questions are Easy. A configured mix that needs Medium or Hard questions is reported in the preview
    and after import, and readiness keeps blocking until L&D changes difficulties."""
    training = world.training("MIXED", questions=0, count=4, mix={"EASY": 2, "MEDIUM": 1, "HARD": 1})
    admin = client_for(world.admin)
    content = csv_file([row(f"Mixed {i}?") for i in range(4)])
    job = validated(admin, training, content)
    notice = job["difficulty_notice"]
    assert "Post-test configuration requires 1 Medium, 1 Hard questions; available after this import: 0 Medium, 0 Hard" in notice
    assert "Imported questions are Easy" in notice and "Question Bank" in notice
    done = commit(admin, job)
    assert "available now: 0 Medium, 0 Hard" in done["difficulty_notice"]

    pool = admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "POST_TEST", "question_count": 4, "easy": 2, "medium": 1, "hard": 1}).json()["data"]
    assert pool["ready"] is False and {s["difficulty"] for s in pool["difficulty_shortfalls"]} == {"MEDIUM", "HARD"}

    # L&D sets difficulties in the Question Bank: the notice clears and the pool becomes ready.
    db.expire_all()
    questions = db.scalars(select(Question).order_by(Question.question_text)).all()
    questions[0].difficulty, questions[1].difficulty = "MEDIUM", "HARD"
    db.commit()
    assert admin.get(f"/admin/imports/{job['id']}").json()["data"]["difficulty_notice"] is None
    pool = admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "POST_TEST", "question_count": 4, "easy": 2, "medium": 1, "hard": 1}).json()["data"]
    assert pool["ready"] is True


def test_no_difficulty_notice_without_a_mix_or_when_easy_is_enough(world, client_for):
    admin = client_for(world.admin)
    plain = world.training("NOMIX", questions=0, count=2)
    assert validated(admin, plain, csv_file([row("Plain?")]))["difficulty_notice"] is None
    easy = world.training("EASYMIX", questions=0, count=2, mix={"EASY": 2})
    assert validated(admin, easy, csv_file([row("Easy one?"), row("Easy two?")]))["difficulty_notice"] is None
    short = validated(admin, easy, csv_file([row("Only one?")]))["difficulty_notice"]
    assert "requires 2 Easy questions; available after this import: 1 Easy" in short
    assert validated(admin, plain, csv_file([row("Pre?")]), test_type="PRE_TEST")["difficulty_notice"] is None  # No pre-test configuration.


# ---------- Downstream: readiness, selection, scoring, answer keys ----------

def test_imported_questions_make_the_test_ready_and_score_correctly(world, db, client_for):
    training = world.training("SCORED", questions=0, count=5)
    admin = client_for(world.admin)
    before = admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "POST_TEST", "question_count": 5}).json()["data"]
    assert before["ready"] is False
    imported(admin, training, [row(f"Scored {i}?", correct="ABCD"[i % 4]) for i in range(5)])
    after = admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "POST_TEST", "question_count": 5}).json()["data"]
    assert (after["eligible"], after["ready"], after["eligible_by_difficulty"]["EASY"]) == (5, True, 5)
    assert admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "PRE_TEST"}).json()["data"]["eligible"] == 0

    employee = client_for(world.employee)
    obligation = world.complete(world.employee, training)
    attempt = start(employee, obligation.id)
    shown = json.dumps(attempt)
    assert "is_correct" not in shown and "answer_key" not in shown  # No key before submission.
    assert {q["question_type"] for q in attempt["questions"]} == {"MCQ_SINGLE"}
    assert all(len(q["options"]) == 4 for q in attempt["questions"])
    employee.post(f"/attempts/{attempt['attempt_id']}/submit")

    # Deactivating one imported question takes it out of the pool, through the existing control.
    question = db.scalar(select(Question).where(Question.question_text == "Scored 3?"))
    assert admin.post(f"/admin/questions/{question.id}/status", json={"status": "INACTIVE"}).status_code == 200
    assert admin.get(f"/admin/trainings/{training.id}/question-pool", params={"assessment_type": "POST_TEST", "question_count": 5}).json()["data"]["ready"] is False


def test_a_full_score_on_imported_questions(world, db, client_for):
    training = world.training("FULL", questions=0, count=3)
    admin = client_for(world.admin)
    imported(admin, training, [row("One?"), row("Two?", correct="C"), row("Three?", correct="D")])
    obligation = world.complete(world.employee, training)
    result = take(db, client_for(world.employee), obligation.id, 3)
    assert float(result["score_percent"]) == 100.0, result


# ---------- Access ----------

def test_only_ld_admin_can_import_or_download_and_csrf_is_required(world, db, client_for):
    training = world.training("ACCESS", questions=0, count=1)
    content = csv_file([row("Protected?")])
    for person in (world.hr, world.employee, world.manager):
        client = client_for(person)
        assert client.get("/admin/imports/templates/QUESTIONS?format=pdf").status_code == 403
        assert validate(client, training, content).status_code == 403
    admin = client_for(world.admin)
    job = validated(admin, training, content)
    admin.csrf = "wrong"
    refused = admin.post(f"/admin/imports/{job['id']}/commit")
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "CSRF_FAILED"
    assert validate(admin, training, content).status_code == 403
    assert db.scalar(select(func.count()).select_from(Question)) == 0
    assert db.scalar(select(QuestionOption.id)) is None
