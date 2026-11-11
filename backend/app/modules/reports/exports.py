"""CSV, XLSX and PDF rendering. Files go to private storage and are never publicly served."""
import csv
import io
import uuid
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import ExportFormat
from app.models import FileArtifact
from app.modules.reports.catalogue import Report

CONTENT_TYPES = {
    ExportFormat.CSV: "text/csv; charset=utf-8",
    ExportFormat.XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ExportFormat.PDF: "application/pdf",
}
LABELS = {"PASSED": "Passed", "NOT_PASSED": "Not Passed", "NEEDS_RETRAINING": "Needs Re-training", "PENDING": "Pending"}


def safe_text(value: object) -> object:
    """Neutralises spreadsheet formulas in employee or admin text (SECURITY_PRIVACY.md §12)."""
    if isinstance(value, str):
        value = LABELS.get(value, value)
        if value[:1] in ("=", "+", "-", "@", "\t", "\r"):
            return "'" + value
    return value


def _preamble(report: Report, filters: dict, generated_at: datetime, scope: str) -> list[list[str]]:
    return [
        [report.title],
        ["Generated (UTC)", generated_at.strftime("%Y-%m-%d %H:%M")],
        ["Scope", scope],
        ["Filters", "; ".join(f"{k}={v}" for k, v in filters.items()) or "None"],
        ["Rows", str(len(report.rows))],
        [],
    ]


def render_csv(report: Report, filters: dict, generated_at: datetime, scope: str) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerows(_preamble(report, filters, generated_at, scope))
    writer.writerow(report.columns)
    writer.writerows([safe_text(cell) for cell in row] for row in report.rows)
    writer.writerow([])
    for definition in report.definitions:
        writer.writerow([definition])
    return ("﻿" + buffer.getvalue()).encode("utf-8")


def render_xlsx(report: Report, filters: dict, generated_at: datetime, scope: str) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Report"
    for row in _preamble(report, filters, generated_at, scope):
        sheet.append(row)
    sheet.append(report.columns)
    header_row = sheet.max_row
    for cell in sheet[header_row]:
        cell.font = Font(bold=True)
    sheet["A1"].font = Font(bold=True, size=14)
    for row in report.rows:
        sheet.append([safe_text(cell) for cell in row])
    sheet.append([])
    for definition in report.definitions:
        sheet.append([definition])
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def render_pdf(report: Report, filters: dict, generated_at: datetime, scope: str) -> bytes:
    buffer = io.BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm, bottomMargin=12 * mm, title=report.title)
    styles = getSampleStyleSheet()
    small = styles["BodyText"].clone("small", fontSize=7, leading=8.5)
    header = styles["BodyText"].clone("header", fontSize=7, leading=8.5, textColor=colors.white, fontName="Helvetica-Bold")
    story = [
        Paragraph(_xml(report.title), styles["Title"]),
        Paragraph(_xml(f"Generated {generated_at.strftime('%Y-%m-%d %H:%M')} UTC · Scope: {scope} · Rows: {len(report.rows)}"), styles["BodyText"]),
        Paragraph(_xml("Filters: " + ("; ".join(f"{k}={v}" for k, v in filters.items()) or "None")), styles["BodyText"]),
        Spacer(1, 4 * mm),
    ]
    width = (landscape(A4)[0] - 24 * mm) / max(len(report.columns), 1)
    data = [[Paragraph(_xml(c), header) for c in report.columns]]
    data += [[Paragraph(_xml(str(LABELS.get(cell, cell))), small) for cell in row] for row in report.rows]
    table = Table(data, colWidths=[width] * len(report.columns), repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#004B3D")),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#DCE3E8")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FA")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story += [table, Spacer(1, 4 * mm)]
    story += [Paragraph(_xml(d), small) for d in report.definitions]
    document.build(story)
    return buffer.getvalue()


def _xml(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


RENDERERS = {ExportFormat.CSV: render_csv, ExportFormat.XLSX: render_xlsx, ExportFormat.PDF: render_pdf}


def store_file(db: Session, owner_id: uuid.UUID, file_name: str, content: bytes, content_type: str, purpose: str) -> FileArtifact:
    root: Path = get_settings().storage_path
    root.mkdir(parents=True, exist_ok=True)
    key = uuid.uuid4().hex  # Non-guessable and contains no user-supplied text.
    (root / key).write_bytes(content)
    artifact = FileArtifact(owner_user_id=owner_id, storage_key=key, file_name=file_name, content_type=content_type, purpose=purpose)
    db.add(artifact)
    db.flush()
    return artifact


def read_file(artifact: FileArtifact) -> bytes:
    return (get_settings().storage_path / artifact.storage_key).read_bytes()
