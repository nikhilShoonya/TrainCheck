"""Question-bank PDFs in TrainCheck's labelled-block layout (SECURITY_PRIVACY.md §11).

A PDF has no rows or columns, so question imports accept one documented layout: every question is a block of
"field: value" lines using the same seven field names as the CSV and Excel templates. Each block starts with its
"question:" line; blocks are separated by a line of ---. Each block becomes one row and then goes through exactly the
same validation and duplicate rules, for the training and test type selected on the import screen. Only text is read: nothing in the PDF is run, followed or
rendered. Word documents, scanned papers and free-form question papers are not interpreted (that would need AI,
which is out of scope).
"""
import io
import re
import textwrap

from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError, PyPdfError

from app.core.errors import ApiError
from app.modules.imports.question_format import FIELDS, RULES

MAX_PAGES = 300
MAX_TEXT_CHARS = 2_000_000

COLUMNS = list(FIELDS)
BLOCK_START = "question"
# Labels of earlier PDF templates. Finding one means the file was made from an old template.
OLD_LABELS = {"id", "training", "department", "competency", "type", "options_extra", "explanation", "difficulty", "marks", "level", "language", "status", "active", "function", "a", "b", "c", "d", "more options"}
_LABEL_LINE = re.compile(r"^(more options|[a-z][a-z_]*)\s*:\s*(.*)$", re.IGNORECASE)
_SEPARATOR = re.compile(r"^-{3,}$")
UNSUPPORTED = (
    "Use the TrainCheck PDF template: each question is a block of \"field: value\" lines that starts with \"question:\", with blocks separated by ---. "
    "Scanned (image-only) PDFs and question papers in any other layout cannot be imported."
)


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
    """Turns labelled blocks into template rows. A "question:" line starts a question; a --- line ends one.
    Text before the first question (a title or instructions) is ignored. A line that does not start with a field
    label continues the previous value, so wrapped text is joined back together."""
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
        label = match.group(1).lower() if match else None
        if label in OLD_LABELS:
            raise _bad_file(f'This PDF uses an old question template (it has the label "{match.group(1)}:"). Download the new PDF template: each question has only question, option_a, option_b, option_c, option_d, correct and topic.')
        column = label if label in COLUMNS else None
        value = match.group(2).strip() if match else ""
        if column == BLOCK_START:
            current = {BLOCK_START: value}
            blocks.append(current)
            last = column
            continue
        if current is None:
            if column is not None:
                where = f"after question {len(blocks)}" if blocks else "before the first question"
                raise _bad_file(f'Found "{match.group(1)}:" {where} without a "question:" line. Every question block must start with "question:". {UNSUPPORTED}')
            continue  # Title, instructions or anything else outside a question.
        if column is not None:
            if column in current:
                raise _bad_file(f'Question {len(blocks)} has the label "{match.group(1)}:" twice. Each label can appear once per question.')
            current[column] = value
            last = column
        elif last is not None:
            current[last] = f"{current[last]} {line}".strip()
    if not blocks:
        raise _bad_file(f"No questions were found. {UNSUPPORTED}")
    rows = TableRows([COLUMNS])
    rows.first_data_row = 1
    rows.extend([block.get(c, "") for c in COLUMNS] for block in blocks)
    return rows


# ---------- Template ----------

INSTRUCTIONS = [
    "TrainCheck question import template (PDF)",
    "Write each question as a block of lines in the form   field: value   using the field names shown in the samples.",
    "Every question block starts with its question line. Separate the blocks with a line of three dashes (---).",
    *RULES,
    "Long text may wrap onto the next lines. Problems are reported by question number (Row 1 = first question).",
    "Only text PDFs laid out like this template can be read. Scanned or free-form question papers cannot be imported.",
]


def template_pdf(samples: list[dict[str, str]]) -> bytes:
    """A PDF template in the block layout, with sample questions. Reading it back gives the sample rows."""
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
        for part in textwrap.wrap(line, 112):
            write(part, size=9)
    for sample in samples:
        y -= 10
        for column in COLUMNS:
            lines = textwrap.wrap(f"{column}: {sample.get(column, '')}", 95) or [f"{column}:"]
            write(lines[0])
            for more in lines[1:]:
                write(f"    {more}")
        write("---")
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()
