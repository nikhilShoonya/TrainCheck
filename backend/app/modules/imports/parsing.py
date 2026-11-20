"""Safe reading of untrusted CSV, XLSX and (question imports only) PDF uploads (SECURITY_PRIVACY.md §11)."""
import csv
import io
import re
import zipfile
from datetime import date, datetime

from openpyxl import load_workbook

from app.core.errors import ApiError
from app.modules.imports.pdf_blocks import TableRows, parse_blocks, read_pdf_text

MAX_ROWS = 5000
MAX_CELL_CHARS = 8000
MAX_EXPANDED_BYTES = 50 * 1024 * 1024
ALLOWED_EXTENSIONS = (".csv", ".xlsx")
FORMULA_PREFIXES = ("=", "+", "@")


def _bad_file(message: str) -> ApiError:
    return ApiError(400, "INVALID_FILE", message)


def read_table(file_name: str, content: bytes, max_bytes: int, allow_pdf: bool = False, typed_cells: bool = False) -> list[list[str]]:
    """Returns rows of plain text. The file content decides the format as well as its name.

    `allow_pdf` is set for question imports: a PDF in the labelled-block layout becomes the same rows (pdf_blocks.py).
    `typed_cells` (employee imports) renders XLSX cells by their type instead of Python's str(): see _typed_text.
    """
    name = file_name.lower()
    allowed = ALLOWED_EXTENSIONS + ((".pdf",) if allow_pdf else ())
    if not name.endswith(allowed):
        raise _bad_file("Choose a CSV, XLSX or PDF file." if allow_pdf else "Choose a CSV or XLSX file.")
    if not content:
        raise _bad_file("This file is empty.")
    if len(content) > max_bytes:
        raise _bad_file(f"This file is larger than the {max_bytes // (1024 * 1024)} MB limit.")
    if name.endswith(".pdf"):
        rows: list[list[str]] = parse_blocks(read_pdf_text(content))
    else:
        rows = TableRows(_read_xlsx(content, typed_cells) if name.endswith(".xlsx") else _read_csv(content))
    if len(rows) > MAX_ROWS + 1:
        raise _bad_file(f"This file has more than {MAX_ROWS:,} data rows.")
    if not rows:
        raise _bad_file("This file has no rows.")
    return rows


def _read_csv(content: bytes) -> list[list[str]]:
    if content[:2] == b"PK" or b"\x00" in content[:4096]:
        raise _bad_file("This does not look like a CSV text file.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _bad_file("Save the CSV file as UTF-8 and upload it again.") from exc
    try:
        rows = [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]
    except csv.Error as exc:
        raise _bad_file("The CSV file could not be read. Check its quoting.") from exc
    return [row for row in rows if any(row)]


_ZERO_PAD_FORMAT = re.compile(r"^0+$")


def _typed_text(cell) -> str:
    """A cell as the person sees it in Excel, for files where the type matters:
    - date cells become YYYY-MM-DD (str() would add " 00:00:00");
    - whole numbers stored as decimals lose the ".0" (123.0 -> "123");
    - whole numbers shown with a zero-padding format such as 00000 keep their leading zeros (123 -> "00123").
    """
    value = cell.value
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int) and not isinstance(value, bool):
        text = str(value)
        number_format = getattr(cell, "number_format", "") or ""
        if value >= 0 and _ZERO_PAD_FORMAT.match(number_format):
            text = text.zfill(len(number_format))
        return text
    return str(value).strip()


def _read_xlsx(content: bytes, typed_cells: bool = False) -> list[list[str]]:
    if content[:2] != b"PK":
        raise _bad_file("This does not look like an Excel workbook.")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            parts = archive.infolist()
            if sum(p.file_size for p in parts) > MAX_EXPANDED_BYTES:
                raise _bad_file("This workbook expands to more than the allowed size.")
            names = {p.filename.lower() for p in parts}
            if any("vbaproject" in n for n in names):
                raise _bad_file("Workbooks containing macros are not accepted.")
            if any("externallink" in n for n in names):
                raise _bad_file("Workbooks with external links are not accepted.")
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
    except ApiError:
        raise
    except Exception as exc:  # A malformed workbook can raise many different errors.
        raise _bad_file("This Excel workbook could not be read.") from exc

    try:
        sheet = workbook.worksheets[0]
        rows: list[list[str]] = []
        for row in sheet.iter_rows():
            values = []
            for cell in row:
                if cell.data_type == "f":
                    raise _bad_file(f"Cell {cell.coordinate} contains a formula. Use plain values.")
                values.append("" if cell.value is None else _typed_text(cell) if typed_cells else str(cell.value).strip())
            if any(values):
                rows.append(values)
            if len(rows) > MAX_ROWS + 1:
                break
        return rows
    finally:
        workbook.close()


def has_formula(value: str) -> bool:
    return value.startswith(FORMULA_PREFIXES)


def clip(value: str) -> str:
    return value[:MAX_CELL_CHARS]
