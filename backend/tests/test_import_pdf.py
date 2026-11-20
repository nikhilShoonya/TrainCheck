"""Question imports from PDF files in TrainCheck's labelled-block layout. Synthetic data only."""
import io

import pytest
from pypdf import PdfWriter
from reportlab.pdfgen import canvas
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.models import Question, QuestionTrainingTag
from app.modules.imports import pdf_blocks


def make_pdf(pages: list[list[str]]) -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    for lines in pages:
        y = 800
        for line in lines:
            pdf.drawString(40, y, line)
            y -= 15
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def block(code: str, **changes) -> list[str]:
    fields = {"ID": code, "Topic": "Topic", "Competency": "Applies the documented process", "Type": "single", "Question": f"{code}?", "A": "Right", "B": "Wrong", "Correct": "A", "Difficulty": "Easy", "Marks": "1", "Level": "L2", "Language": "English", "Status": "Active"}
    fields.update(changes)
    return [f"{label}: {value}" for label, value in fields.items()] + ["---"]


def upload(client, training, content: bytes, name="questions.pdf", test_type="PRE_TEST", import_type="QUESTIONS"):
    data = {"import_type": import_type}
    if import_type == "QUESTIONS":
        data.update(training_id=str(training.id), test_type=test_type)
    return client.post("/admin/imports", files={"file": (name, content, "application/pdf")}, data=data)


def test_the_pdf_template_downloads_and_imports_cleanly(world, db, client_for):
    training = world.training("PDFT", questions=0, count=1)
    admin = client_for(world.admin)
    template = admin.get("/admin/imports/templates/QUESTIONS?format=pdf")
    assert template.status_code == 200 and template.headers["content-type"] == "application/pdf"
    assert template.content.startswith(b"%PDF-") and 'filename="traincheck-questions-template.pdf"' in template.headers["content-disposition"]
    job = upload(admin, training, template.content).json()["data"]
    assert (job["accepted_rows"], job["rejected_rows"], job["test_type"]) == (1, 0, "PRE_TEST"), job["rows"]
    assert job["rows"][0]["row"] == 1  # Question 1, not spreadsheet row 2.
    assert admin.post(f"/admin/imports/{job['id']}/commit").json()["data"]["status"] == "COMPLETED"
    db.expire_all()
    assert db.execute(select(QuestionTrainingTag.training_id, QuestionTrainingTag.test_type)).all() == [(training.id, "PRE_TEST")]


def test_pdf_blocks_follow_every_csv_rule(world, db, client_for):
    training = world.training("PDFR", questions=1, count=1)
    existing = db.scalar(select(Question))
    admin = client_for(world.admin)
    long_question = "A customer uploads an expired address proof together with a covering letter. What should you do"
    # A title before the first block; PDF-1's question wraps onto the next page (the continuation has no label);
    # PDF-3 writes its options as "A) ...".
    lines = [line for line in block("PDF-1") if line != "---" and not line.startswith("Question:")]
    first_page = ["Quarterly question bank", "Prepared by L&D", *lines, f"Question: {long_question[:60]}"]
    second_page = ["   " + long_question[60:] + "?", "---", *block("PDF-2", Correct="Z"), *block(existing.question_code), "ID: PDF-3", "Topic: Topic", "Competency: Applies the documented process", "Type: single", "Question: PDF-3?", "A) Right", "B) Wrong", "Correct: A", "Difficulty: Easy", "Marks: 1", "Level: L2", "Language: English", "Status: Active"]
    job = upload(admin, training, make_pdf([first_page, second_page]), test_type="POST_TEST").json()["data"]
    rows = {r["row"]: r for r in job["rows"]}
    assert [rows[n]["status"] for n in (1, 2, 3, 4)] == ["VALID", "INVALID", "DUPLICATE", "VALID"], job["rows"]
    assert rows[2]["errors"][0]["field"] == "correct"
    assert "already exists in the Question Bank" in rows[3]["errors"][0]["message"]
    admin.post(f"/admin/imports/{job['id']}/commit")
    db.expire_all()
    imported = db.scalar(select(Question).where(Question.question_code == "PDF-1"))
    assert imported.question_text == long_question + "?"  # Wrapped text is joined back together.
    assert db.scalar(select(func.count()).select_from(Question)) == 3  # The existing question plus PDF-1 and PDF-3.


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"not a pdf at all", "does not look like a PDF"),
        (b"%PDF-1.7 broken", "could not be read"),
    ],
)
def test_unreadable_pdfs_are_rejected(world, client_for, content, message):
    training = world.training("PDFX", questions=0, count=1)
    response = upload(client_for(world.admin), training, content)
    assert response.status_code == 400 and response.json()["error"]["code"] == "INVALID_FILE"
    assert message in response.json()["error"]["message"]


def test_scanned_or_free_form_pdfs_are_explained(world, client_for):
    training = world.training("PDFF", questions=0, count=1)
    response = upload(client_for(world.admin), training, make_pdf([["1. What is KYC?", "a) Know your customer", "b) Keep your cash"]]))
    assert response.status_code == 400 and "No questions were found" in response.json()["error"]["message"]


def test_password_protected_pdfs_are_rejected(world, client_for):
    training = world.training("PDFP", questions=0, count=1)
    writer = PdfWriter(clone_from=io.BytesIO(make_pdf([block("ENC-1")])))
    writer.encrypt("secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    response = upload(client_for(world.admin), training, buffer.getvalue())
    assert response.status_code == 400 and "Password-protected" in response.json()["error"]["message"]


def test_a_repeated_label_in_one_question_is_refused(world, db, client_for):
    training = world.training("PDFD", questions=0, count=1)
    response = upload(client_for(world.admin), training, make_pdf([block("REP-1") + ["ID: REP-2", "Correct: A", "Correct: B"]]))
    assert response.status_code == 400 and 'label "Correct" twice' in response.json()["error"]["message"]
    assert db.scalar(select(func.count()).select_from(Question)) == 0


def test_page_limit(world, client_for, monkeypatch):
    monkeypatch.setattr(pdf_blocks, "MAX_PAGES", 1)
    training = world.training("PDFL", questions=0, count=1)
    response = upload(client_for(world.admin), training, make_pdf([block("P-1"), block("P-2")]))
    assert response.status_code == 400 and "more than 1 pages" in response.json()["error"]["message"]


def test_completion_imports_do_not_take_pdfs(world, client_for):
    response = upload(client_for(world.admin), None, make_pdf([["employee: E1"]]), name="c.pdf", import_type="COMPLETIONS")
    assert response.status_code == 400 and response.json()["error"]["message"] == "Choose a CSV or XLSX file."


def test_an_import_can_be_replaced_by_a_pdf(world, client_for):
    training = world.training("PDFE", questions=0, count=1)
    admin = client_for(world.admin)
    job = upload(admin, training, make_pdf([block("E-1", Correct="Z")])).json()["data"]
    assert job["accepted_rows"] == 0
    fixed = admin.post(f"/admin/imports/{job['id']}/replace", files={"file": ("fixed.pdf", make_pdf([block("E-1")]), "application/pdf")}, data={"training_id": str(training.id), "test_type": "PRE_TEST"}).json()["data"]
    assert (fixed["id"], fixed["file_name"], fixed["accepted_rows"]) == (job["id"], "fixed.pdf", 1)


def test_pdf_import_and_template_are_for_ld_only(world, client_for):
    training = world.training("PDFP2", questions=0, count=1)
    for person in (world.hr, world.employee):
        client = client_for(person)
        assert client.get("/admin/imports/templates/QUESTIONS?format=pdf").status_code == 403
        assert upload(client, training, make_pdf([block("X-1")])).status_code == 403


def test_block_parsing_rules():
    rows = pdf_blocks.parse_blocks("Title line\nCorrect: ignored before the first ID\nID: B-1\nQuestion: First part\n  second part?\nA) One\nB: Two\nMore options: Three | Four\nNote: kept as text\n---\nID: B-2\nTopic: T")
    assert rows.first_data_row == 1 and rows[0] == pdf_blocks.COLUMNS
    first = dict(zip(rows[0], rows[1], strict=True))
    assert (first["id"], first["question"], first["option_a"], first["option_b"]) == ("B-1", "First part second part?", "One", "Two")
    assert first["options_extra"] == "Three | Four Note: kept as text"  # An unknown label continues the previous value.
    assert first["correct"] == ""  # The line before the first ID was not used.
    assert dict(zip(rows[0], rows[2], strict=True))["topic"] == "T"
    with pytest.raises(ApiError):
        pdf_blocks.parse_blocks("No blocks here")
