"""Question-bank PDFs in TrainCheck's labelled-block layout (SECURITY_PRIVACY.md §11).

A PDF has no rows or columns, so question imports accept one predictable layout: every question is a block of
"Label: value" lines, starting with "ID:". Each block becomes one row with the same columns as the CSV template, and
then goes through exactly the same validation, duplicate and training/test-type rules. Only text is read: nothing in
the PDF is run, followed or rendered. Free-form question papers are not interpreted (that would need AI, which is
out of scope).
"""
import io
import re
import textwrap

from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError, PyPdfError

from app.core.errors import ApiError

MAX_PAGES = 300
MAX_TEXT_CHARS = 2_000_000

# Printed label -> template column. Order is the template's order.
LABELS: dict[str, str] = {
    "id": "id",
    "training": "training",
    "topic": "topic",
    "competency": "competency",
    "type": "type",
    "question": "question",
    "a": "option_a",
    "b": "option_b",
    "c": "option_c",
    "d": "option_d",
    "more options": "options_extra",
    "correct": "correct",
    "explanation": "explanation",
    "difficulty": "difficulty",
    "marks": "marks",
    "level": "level",
    "language": "language",
    "status": "active",
    "department": "department",
    "function": "function",
}
COLUMNS = list(LABELS.values())
_LABEL_LINE = re.compile(r"^(more options|[a-z]+)\s*:\s*(.*)$", re.IGNORECASE)
_OPTION_LINE = re.compile(r"^([a-d])\s*\)\s*(.*)$", re.IGNORECASE)  # "A) text" is accepted for options too.
_SEPARATOR = re.compile(r"^-{3,}$")


def _bad_file(message: str) -> ApiError:
    return ApiError(400, "INVALID_FILE", message)


class TableRows(list):
    """Rows with the number shown for the first data row: 2 for a spreadsheet (row 1 is the header), and 1 for a
    PDF, so that "Row 3" means the third question block."""

    first_data_row = 2


def read_pdf_text(content: bytes) -> str:
    if not content.startswith(b"%PDF-"):
        raise _bad_file("This does not look like a PDF file.")
    try:
        reader = PdfReader(io.BytesIO(content), strict=False)
        if reader.is_encrypted:
            raise _bad_file("Password-protected PDFs are not accepted. Save the PDF without a password and upload it again.")
        if len(reader.pages) > MAX_PAGES:
            raise _bad_file(f"This PDF has more than {MAX_PAGES} pages.")
        parts, size = [], 0
        for page in reader.pages:
            text = page.extract_text() or ""
            size += len(text)
            if size > MAX_TEXT_CHARS:
                raise _bad_file("This PDF contains more text than a question import allows.")
            parts.append(text)
    except ApiError:
        raise
    except FileNotDecryptedError as exc:
        raise _bad_file("Password-protected PDFs are not accepted. Save the PDF without a password and upload it again.") from exc
    except (PyPdfError, ValueError, KeyError, TypeError, AttributeError, IndexError, RecursionError, OSError) as exc:  # Malformed PDFs fail in many ways.
        raise _bad_file("This PDF could not be read.") from exc
    return "\n".join(parts)


def parse_blocks(text: str) -> TableRows:
    """Turns labelled blocks into template rows. Lines before the first "ID:" (a title or instructions) are ignored.
    A line without a known label continues the previous value, so wrapped text is joined back together."""
    blocks: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    last: str | None = None
    for raw in text.replace("\r", "\n").split("\n"):
        line = " ".join(raw.split())
        if not line:
            continue
        if _SEPARATOR.match(line):
            current, last = None, None
            continue
        match = _LABEL_LINE.match(line)
        column = LABELS.get(match.group(1).lower()) if match else None
        value = match.group(2).strip() if match else ""
        if column is None:
            option = _OPTION_LINE.match(line)
            if option:
                column, value = LABELS[option.group(1).lower()], option.group(2).strip()
        if column == "id":
            current = {"id": value}
            blocks.append(current)
            last = "id"
            continue
        if current is None:
            continue  # Title, instructions or anything else before the first question.
        if column is not None:
            if column in current:
                raise _bad_file(f"Question {len(blocks)} ({current.get('id') or 'no ID'}) has the label \"{line.split(':')[0].split(')')[0].strip()}\" twice. Each label can appear once per question.")
            current[column] = value
            last = column
        elif last is not None:
            current[last] = f"{current[last]} {line}".strip()
    if not blocks:
        raise _bad_file('No questions were found. Use the TrainCheck PDF template: each question starts with a line "ID: ...". Scanned (image-only) PDFs cannot be read.')
    rows = TableRows([COLUMNS])
    rows.first_data_row = 1
    rows.extend([block.get(c, "") for c in COLUMNS] for block in blocks)
    return rows


# ---------- Template ----------

INSTRUCTIONS = [
    "TrainCheck question import template (PDF)",
    "Write each question as a block of 'Label: value' lines, starting with 'ID:'. Separate questions with a line of ---.",
    "Required: ID, Topic, Competency, Type, Question, A, B, Correct, Difficulty, Marks, Level, Language, Status.",
    "Optional: Training (must match the training you select), C, D, More options (separated by |), Explanation,",
    "Department, Function. Type: single, multiple, boolean or scenario. Correct: option letters, e.g. B or A|C.",
    "Difficulty: Easy, Medium or Hard. Level: L2. Language: English, Hindi or Hinglish. Status: Active or Inactive.",
    "Long text may wrap onto the next lines. Problems are reported by question number (Row 1 = first question).",
]


def template_pdf(sample: dict[str, str]) -> bytes:
    """A PDF template in the block layout, with one sample question. Reading it back gives the sample row."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.setTitle("TrainCheck question import template")
    width, height = A4
    y = height - 50

    def write(text: str, font: str = "Helvetica", size: int = 10) -> None:
        nonlocal y
        if y < 50:
            pdf.showPage()
            y = height - 50
        pdf.setFont(font, size)
        pdf.drawString(45, y, text)
        y -= size + 5

    write(INSTRUCTIONS[0], "Helvetica-Bold", 13)
    for line in INSTRUCTIONS[1:]:
        write(line, size=9)
    y -= 10
    printed = {column: label for label, column in LABELS.items()}
    for column in COLUMNS:
        value = sample.get(column, "")
        if not value and column not in ("training", "option_c", "option_d", "explanation"):
            continue
        label = printed[column]
        label = label.upper() if len(label) == 1 or label == "id" else label.capitalize()
        lines = textwrap.wrap(f"{label}: {value}", 95) or [f"{label}:"]
        write(lines[0])
        for more in lines[1:]:
            write(f"    {more}")
    write("---")
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()
