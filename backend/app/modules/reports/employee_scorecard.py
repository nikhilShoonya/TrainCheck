"""Employee Scorecard: one employee's complete learning record, opened from an employee row in Reports & Analytics.

Everything comes from the shared report rows (data.load_rows), so the rules match the other reports exactly:
- One row per live assignment (enrolment). Several attempts never add a training.
- First, Latest, Result and Assessment Timing are the existing Row / assessment_timing rules.
- Highest Score is the best submitted post-test score across every retained attempt and training cycle.
  Pre-tests and attempts without a result (running, cancelled) are never part of it.
- Learning gain pairs the pre-test with the FIRST post-test (scorecard.gain_values), never the highest score.
- Feedback is read for this employee's own assessments only.
- The date filter is the training-completion date in the organisation calendar, as in every other report.
"""
import io
import uuid
from datetime import date, datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.display import display_date, display_datetime
from app.core.enums import AssessmentType, AttemptStatus, EnrolmentStatus
from app.core.errors import not_found, validation
from app.core.responses import display_percent, iso
from app.models import AssessmentAttempt, AssessmentFeedback, Employee, Enrolment, Training
from app.modules.assessment.gate import feedback_exempt
from app.modules.feedback.router import ratings_of
from app.modules.organisation.people import RESERVED_ADMIN_CODE
from app.modules.reports.catalogue import SUBMISSION_LABELS
from app.modules.reports.data import ReportFilters, Row, assessment_timing, load_rows, summary
from app.modules.reports.scorecard import gain_values

DATE_BASIS = "Dates filter by the training completion date (India time). Trainings not completed in the range are left out."
DEFINITIONS = [
    "Training completion and assessment outcomes are tracked separately: Completed means training completion was recorded, not that the assessment was passed.",
    "Highest Score % is the best submitted post-test score across every retained attempt, including earlier training cycles. Pre-tests are not included.",
    "Attempts counts the submitted post-test attempts across every training cycle, the same post-test attempts listed in the attempt history.",
    "Learning gain compares the pre-test with the first post-test, in percentage points. It is shown only when both exist.",
    "Missing scores are shown as —. They are never treated as zero.",
    DATE_BASIS,
]
RESULT_LABELS = {"PASSED": "Passed", "NOT_PASSED": "Not Passed", "NEEDS_RETRAINING": "Needs Re-training", "PENDING": "Pending", "BASELINE": "Baseline (not pass/fail)"}
TYPE_LABELS = {AssessmentType.PRE_TEST.value: "Pre-test", AssessmentType.POST_TEST.value: "Post-test"}
FEEDBACK_LABELS = {"relevance": "Relevance", "clarity": "Clarity", "alignment": "Assessment match", "fairness": "Fairness", "confidence": "Confidence"}


def load_employee(db: Session, employee_id: uuid.UUID) -> Employee:
    """A learner the reports cover. The designated L&D Admin sign-in record is never reported, so it is not found."""
    employee = db.scalar(
        select(Employee).options(selectinload(Employee.department), selectinload(Employee.location)).where(Employee.id == employee_id)
    )
    if employee is None or employee.employee_code.upper() == RESERVED_ADMIN_CODE:
        raise not_found("This employee was not found.")
    return employee


def training_options(db: Session, employee: Employee) -> list[dict]:
    """The employee's live trainings, for the Training filter (never another employee's)."""
    rows = db.execute(
        select(Training.id, Training.title)
        .join(Enrolment, Enrolment.training_id == Training.id)
        .where(Enrolment.employee_id == employee.id, Enrolment.enrolment_status != EnrolmentStatus.CANCELLED)
        .distinct()
    ).all()
    return [{"id": str(i), "name": title} for i, title in sorted(rows, key=lambda r: (r[1].lower(), str(r[0])))]


def employee_filters(training_id: uuid.UUID | None, date_from: date | None, date_to: date | None, options: list[dict]) -> ReportFilters:
    """Only the training and the completion-date range apply here; the employee is fixed by the path."""
    if date_from and date_to and date_from > date_to:
        raise validation("The start date is after the end date. Choose a start date on or before the end date.")
    if training_id and str(training_id) not in {o["id"] for o in options}:
        raise validation("This training is not assigned to this employee.")
    return ReportFilters(date_from=date_from, date_to=date_to, training_id=training_id)


def _scored(attempts: list[AssessmentAttempt]) -> list[AssessmentAttempt]:
    """Submitted attempts with a result and a score: the attempts that count and are listed."""
    return [a for a in attempts if a.result_status is not None and a.score_percent is not None and a.status not in (AttemptStatus.CANCELLED, AttemptStatus.IN_PROGRESS)]


def highest_post_score(row: Row) -> float | None:
    """The maximum valid post-test score across every retained attempt and training cycle (never the latest)."""
    scores = [a.score_percent for a in _scored(row.post_attempts)]
    return display_percent(max(scores)) if scores else None


def _pre_attempts(row: Row) -> list[AssessmentAttempt]:
    return _scored([a for o in row.enrolment.obligations if o.assessment_type == AssessmentType.PRE_TEST for a in o.attempts])


def _cycle_of(attempt: AssessmentAttempt) -> int:
    return attempt.obligation.training_cycle if attempt.obligation is not None else 1


def _training_record(row: Row, now: datetime) -> dict:
    e = row.enrolment
    return {
        "enrolment_id": str(e.id),
        "training_id": str(e.training_id),
        "training": e.training.title,
        "assigned_at": iso(e.assigned_at),
        "completed_at": iso(e.completion.completed_at) if e.completion else None,
        "first_score": display_percent(row.first),
        "latest_score": display_percent(row.latest),
        "highest_score": highest_post_score(row),
        "attempts": len(_scored(row.post_attempts)),
        "assessment_timing": assessment_timing(row, now),
        "result": row.result,
        "training_cycle": e.training_cycle,
    }


def _learning_gain(row: Row) -> dict:
    pre = float(row.pre_attempt.score_percent) if row.pre_attempt and row.pre_attempt.score_percent is not None else None
    post = float(row.first) if row.first is not None else None
    gain, _normalised, _ = gain_values(pre, post)
    if pre is None and not row.enrolment.training.pretest_enabled:
        note = "No pre-test is set up for this training."
    elif pre is None:
        note = "No pre-test score."
    elif post is None:
        note = "No post-test score yet."
    else:
        note = None
    return {
        "training_id": str(row.enrolment.training_id),
        "training": row.enrolment.training.title,
        "pre_test": display_percent(pre),
        "first_post_test": display_percent(post),
        "gain": gain,
        "comparable": gain is not None,
        "note": note,
    }


def _feedback(db: Session, employee: Employee, rows: list[Row]) -> list[dict]:
    """One entry per post-test assessment (training cycle) that has a result: its feedback, or why there is none."""
    assessed = [(r, o) for r in rows for o in r.enrolment.obligations if o.assessment_type == AssessmentType.POST_TEST and _scored(o.attempts)]
    if not assessed:
        return []
    obligation_ids = [o.id for _, o in assessed]
    # Both conditions, so a record can never belong to another employee even if an obligation were shared.
    given = {
        f.obligation_id: f
        for f in db.scalars(select(AssessmentFeedback).where(AssessmentFeedback.employee_id == employee.id, AssessmentFeedback.obligation_id.in_(obligation_ids)))
    }
    cycles_per_training: dict[uuid.UUID, int] = {}
    for r, _ in assessed:
        cycles_per_training[r.enrolment.id] = cycles_per_training.get(r.enrolment.id, 0) + 1
    items = []
    for r, o in assessed:
        feedback = given.get(o.id)
        base = {
            "training_id": str(r.enrolment.training_id),
            "training": r.enrolment.training.title,
            "training_cycle": o.training_cycle,
            "show_cycle": cycles_per_training[r.enrolment.id] > 1 or o.training_cycle > 1,
        }
        if feedback is None:
            # Same rule as the feedback form: results from before feedback began are never asked.
            items.append({**base, "status": "NOT_REQUIRED" if feedback_exempt(db, o.id) else "NOT_SUBMITTED", "ratings": None, "overall": None, "comment": None, "submitted_at": None})
            continue
        ratings = ratings_of(feedback)
        items.append(
            {
                **base,
                "status": "SUBMITTED",
                "ratings": ratings,
                # The existing overall: the plain mean of the five ratings, two decimals (as on Training Feedback).
                "overall": round(sum(ratings.values()) / len(ratings), 2),
                "comment": feedback.comment_text,
                "submitted_at": iso(feedback.submitted_at),
            }
        )
    # Submitted feedback, newest first, then the assessments still without feedback (by training).
    submitted = sorted((i for i in items if i["submitted_at"]), key=lambda i: i["submitted_at"], reverse=True)
    waiting = sorted((i for i in items if not i["submitted_at"]), key=lambda i: (i["training"].lower(), i["training_cycle"]))
    return submitted + waiting


def _attempt_history(rows: list[Row]) -> list[dict]:
    items = []
    for r in rows:
        title = r.enrolment.training.title
        post = _scored(r.post_attempts)
        cycles = {_cycle_of(a) for a in post} | {r.enrolment.training_cycle}
        for kind, attempts in ((AssessmentType.PRE_TEST.value, _pre_attempts(r)), (AssessmentType.POST_TEST.value, post)):
            for a in attempts:
                items.append(
                    {
                        "id": str(a.id),
                        "training_id": str(r.enrolment.training_id),
                        "training": title,
                        "assessment_type": kind,
                        "attempt_number": a.attempt_number,
                        "training_cycle": _cycle_of(a),
                        # Attempt numbers start again in each re-training cycle: say which cycle when there is more than one.
                        "show_cycle": kind == AssessmentType.POST_TEST.value and len(cycles) > 1,
                        "score": display_percent(a.score_percent),
                        "result": "BASELINE" if kind == AssessmentType.PRE_TEST.value else a.result_status,
                        "submitted_at": iso(a.submitted_at),
                        "submission": SUBMISSION_LABELS.get(a.submission_reason or "", "Not recorded"),
                    }
                )
    items.sort(key=lambda i: (i["submitted_at"] or "", i["id"]), reverse=True)  # Newest submission first.
    return items


def build_employee_scorecard(db: Session, employee: Employee, rows: list[Row], options: list[dict], filters: ReportFilters, now: datetime) -> dict:
    # Most recently assigned first, then by title, so the first five rows are the newest work.
    rows = sorted(rows, key=lambda r: r.enrolment.training.title.lower())
    rows.sort(key=lambda r: r.enrolment.assigned_at, reverse=True)
    totals = summary(rows)
    trainings = [_training_record(r, now) for r in rows]
    return {
        "employee": {
            "id": str(employee.id),
            "name": employee.full_name,
            "employee_code": employee.employee_code,
            "department": employee.department.name if employee.department else None,
            "location": employee.location.name if employee.location else None,
            "grade": employee.grade or None,
            "joining_date": employee.joining_date.isoformat() if employee.joining_date else None,
            "email": employee.work_email or None,
        },
        "filters": {k: v for k, v in filters.stored().items() if k in ("training_id", "date_from", "date_to")},
        "date_basis": DATE_BASIS,
        "training_options": options,
        "summary": {
            "assigned": totals["assignments"],
            "completed": totals["completed"],
            "passed": totals["passed"],
            "overdue": sum(1 for t in trainings if t["assessment_timing"] == "Overdue"),
        },
        "trainings": trainings,
        "learning_gain": [_learning_gain(r) for r in rows],
        "feedback": _feedback(db, employee, rows),
        "attempts": _attempt_history(rows),
        "definitions": DEFINITIONS,
        "generated_at": iso(now),
    }


def scorecard_for(db: Session, employee: Employee, training_id: uuid.UUID | None, date_from: date | None, date_to: date | None, now: datetime) -> dict:
    """The scorecard of one employee, read only through that employee's own rows."""
    options = training_options(db, employee)
    filters = employee_filters(training_id, date_from, date_to, options)
    rows = load_rows(db, [employee.id], filters)
    return build_employee_scorecard(db, employee, rows, options, filters, now)


# ---------- PDF ----------

def _pct(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.2f}".rstrip("0").rstrip(".") + "%"


def _num(value: float | None) -> str:
    return "—" if value is None else f"{value:.2f}".rstrip("0").rstrip(".")


def _day(value: str | None, missing: str = "—") -> str:
    return display_date(datetime.fromisoformat(value)) if value else missing


def _moment(value: str | None, missing: str = "—") -> str:
    return display_datetime(datetime.fromisoformat(value)) if value else missing


def filter_text(card: dict) -> str:
    filters = card["filters"]
    names = {o["id"]: o["name"] for o in card["training_options"]}
    training = names.get(filters.get("training_id", ""), "All trainings")
    start, end = filters.get("date_from"), filters.get("date_to")
    if start or end:
        dates = f"completed {display_date(date.fromisoformat(start)) if start else 'any time'} to {display_date(date.fromisoformat(end)) if end else 'today'}"
    else:
        dates = "all dates"
    return f"Training: {training} · Dates: {dates}"


def cycle_attempt(item: dict) -> str:
    return f"Cycle {item['training_cycle']} · Attempt {item['attempt_number']}" if item["show_cycle"] else str(item["attempt_number"])


def render_pdf(card: dict, generated_by: str) -> bytes:
    """Every matching record (not only the five rows shown on screen), with the same filters."""
    from app.modules.reports.exports import _xml

    buffer = io.BytesIO()
    employee = card["employee"]
    title = f"Employee Scorecard — {employee['name']}"
    document = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm, bottomMargin=12 * mm, title=title)
    styles = getSampleStyleSheet()
    body = styles["BodyText"].clone("esc-body", fontSize=8.5, leading=11)
    small = styles["BodyText"].clone("esc-small", fontSize=7.5, leading=9.5)
    header = styles["BodyText"].clone("esc-header", fontSize=7.5, leading=9.5, textColor=colors.white, fontName="Helvetica-Bold")
    heading = styles["Heading2"].clone("esc-h2", fontSize=12, leading=15, spaceBefore=8, spaceAfter=4)
    width = landscape(A4)[0] - 24 * mm
    missing = "Not recorded"

    def table(columns: list[str], rows: list[list[str]], empty: str, weights: list[float] | None = None) -> Table | Paragraph:
        if not rows:
            return Paragraph(_xml(empty), body)
        weights = weights or [1] * len(columns)
        unit = width / sum(weights)
        data = [[Paragraph(_xml(c), header) for c in columns]] + [[Paragraph(_xml(str(cell)), small) for cell in row] for row in rows]
        result = Table(data, colWidths=[w * unit for w in weights], repeatRows=1)
        result.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#004B3D")),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#DCE3E8")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F8FA")]),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        return result

    joining = _day(employee["joining_date"], missing) if employee["joining_date"] else missing
    profile = [
        ["Employee ID", employee["employee_code"] or missing, "Department", employee["department"] or missing, "Location", employee["location"] or missing],
        ["Grade", employee["grade"] or missing, "Joining date", joining, "Email", employee["email"] or missing],
    ]
    profile_table = Table([[Paragraph(_xml(str(c)), body) for c in row] for row in profile], colWidths=[width * w for w in (0.1, 0.2, 0.1, 0.2, 0.1, 0.3)])
    profile_table.setStyle(TableStyle([("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#46546C")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    s = card["summary"]
    story = [
        Paragraph(_xml(title), styles["Title"]),
        Paragraph(_xml(f"Generated {_moment(card['generated_at'])} · By {generated_by} · {filter_text(card)}"), body),
        Spacer(1, 3 * mm),
        profile_table,
        Spacer(1, 3 * mm),
        table(["Assigned trainings", "Completed trainings", "Passed assessments", "Overdue assessments"], [[s["assigned"], s["completed"], s["passed"], s["overdue"]]], ""),
        Paragraph(_xml("Training completion and assessment outcomes are tracked separately."), small),
        Paragraph(_xml(f"Training record ({len(card['trainings'])})"), heading),
        table(
            ["Training", "Assigned", "Completed", "First / Latest %", "Highest Score %", "Attempts", "Assessment Timing", "Result"],
            [
                [
                    t["training"],
                    _day(t["assigned_at"]),
                    _day(t["completed_at"], "Not completed"),
                    "—" if t["first_score"] is None else f"{_num(t['first_score'])} / {_num(t['latest_score'])}",
                    _pct(t["highest_score"]),
                    t["attempts"],
                    t["assessment_timing"],
                    RESULT_LABELS.get(t["result"], t["result"]),
                ]
                for t in card["trainings"]
            ],
            "No trainings match these filters.",
            [3, 1.2, 1.2, 1.3, 1.2, 0.9, 1.8, 1.4],
        ),
        Paragraph(_xml(f"Learning gain ({len(card['learning_gain'])})"), heading),
        table(
            ["Training", "Pre-test %", "First post-test %", "Gain (points)", "Note"],
            [[g["training"], _pct(g["pre_test"]), _pct(g["first_post_test"]), (f"{g['gain']:+.2f}".rstrip("0").rstrip(".") if g["comparable"] else "Not comparable"), g["note"] or ""] for g in card["learning_gain"]],
            "No trainings match these filters.",
            [3, 1.2, 1.4, 1.4, 3],
        ),
        Paragraph(_xml(f"Training feedback ({len(card['feedback'])})"), heading),
        table(
            ["Training", *FEEDBACK_LABELS.values(), "Overall /5", "Comment", "Submitted"],
            [
                [
                    f["training"] + (f" (cycle {f['training_cycle']})" if f["show_cycle"] else ""),
                    *([str(f["ratings"][k]) for k in FEEDBACK_LABELS] if f["ratings"] else ["—"] * len(FEEDBACK_LABELS)),
                    _num(f["overall"]),
                    f["comment"] or ("No comment" if f["status"] == "SUBMITTED" else ""),
                    _moment(f["submitted_at"], "Not submitted" if f["status"] == "NOT_SUBMITTED" else "Not required"),
                ]
                for f in card["feedback"]
            ],
            "No feedback for these filters. Feedback is asked after a post-test result.",
            [2.6, 0.9, 0.9, 1.1, 0.9, 1, 0.9, 3, 1.6],
        ),
        Paragraph(_xml(f"Assessment attempt history ({len(card['attempts'])})"), heading),
        table(
            ["Training", "Type", "Attempt", "Score", "Result", "Submitted", "Submission"],
            [[a["training"], TYPE_LABELS.get(a["assessment_type"], a["assessment_type"]), cycle_attempt(a), _pct(a["score"]), RESULT_LABELS.get(a["result"], a["result"]), _moment(a["submitted_at"]), a["submission"]] for a in card["attempts"]],
            "No submitted attempts for these filters.",
            [3, 1, 1.4, 0.9, 1.6, 1.6, 1.6],
        ),
        Spacer(1, 4 * mm),
    ]
    story.append(KeepTogether([Paragraph(_xml(d), small) for d in card["definitions"]]))
    document.build(story)
    return buffer.getvalue()


def pdf_file_name(employee: Employee, now: datetime) -> str:
    from app.core.display import filename_stamp

    code = "".join(c if c.isalnum() or c in "-_" else "-" for c in employee.employee_code) or "employee"
    return f"traincheck-employee-scorecard-{code}-{filename_stamp(now)}.pdf"
