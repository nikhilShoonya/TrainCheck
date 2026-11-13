"""The seven active report categories (SC-2L-102). Each returns a title, columns, rows and definitions."""
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.enums import AttemptStatus, ReportCode, ReviewerType
from app.core.responses import display_percent
from app.models import AttemptQuestion, Training
from app.modules.behaviour.service import review_status
from app.modules.reports.data import Row, assessment_timing, behaviour_reviews, mean
from app.modules.reports.scorecard import behaviour_state, gain_values, learning_state

MISSING = "Not collected"
INTERPRETATION = "Missing data is not zero. A passed assessment is not proof of behaviour change. Ratings are observations."


@dataclass
class Report:
    code: str
    title: str
    description: str
    columns: list[str]
    rows: list[list] = field(default_factory=list)
    definitions: list[str] = field(default_factory=list)


TITLES = {
    ReportCode.COMPLIANCE: ("Training Completion and Compliance", "Assignment, completion and assessment timing as separate facts."),
    ReportCode.PASS_FAIL: ("Pass/Fail and Red-Flag Employees", "Result, first and best scores, attempts and Needs Re-training flags."),
    ReportCode.LEARNING_GAIN: ("Pre-Test vs Post-Test Learning Gain", "Matched pre-test and first post-test scores."),
    ReportCode.BEHAVIOUR: ("Behaviour Change Tracker", "Self and manager ratings by competency and follow-up period."),
    ReportCode.QUESTION_ANALYTICS: ("Question Analytics", "How each question version performed, with sample sizes."),
    ReportCode.EMPLOYEE_HISTORY: ("Employee Training History", "Every submitted attempt, kept separately."),
    ReportCode.SCORECARD: ("Training Learning & Behaviour Scorecard", "Learning and Behaviour evidence for each training."),
}


def _date(value) -> str:
    return value.strftime("%Y-%m-%d") if value else ""


def _percent(value) -> float | str:
    shown = display_percent(value)
    return MISSING if shown is None else shown


def _name(item) -> str:
    return item.name if item else "Unassigned"


def compliance(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.COMPLIANCE, *TITLES[ReportCode.COMPLIANCE], ["Employee", "Employee ID", "Department", "Location", "Training", "Trainer", "Batch", "Assigned", "Completed", "Assessment Timing", "Result"])
    now = utcnow()
    for r in rows:
        e, t = r.enrolment.employee, r.enrolment.training
        report.rows.append([e.full_name, e.employee_code, _name(e.department), _name(e.location), t.title, _name(t.trainer), r.enrolment.batch.name if r.enrolment.batch else "Unassigned", _date(r.enrolment.assigned_at), _date(r.enrolment.completion.completed_at) if r.enrolment.completion else "Not completed", assessment_timing(r, now), r.result])
    report.definitions = ["Completed means training completion was recorded; it does not mean the assessment was passed.", "Overdue means the assessment has been due for at least one day with no submission.", "Date filters select the training-completion cohort."]
    return report


def pass_fail(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.PASS_FAIL, *TITLES[ReportCode.PASS_FAIL], ["Employee", "Employee ID", "Department", "Training", "Batch", "Result", "First Score %", "Best Score %", "Latest Score %", "Attempts", "Max Attempts", "Completion Date", "Red Flag"])
    for r in rows:
        e = r.enrolment.employee
        config = r.obligation.config if r.obligation else None
        red = r.result in ("NOT_PASSED", "NEEDS_RETRAINING")
        report.rows.append([e.full_name, e.employee_code, _name(e.department), r.enrolment.training.title, r.enrolment.batch.name if r.enrolment.batch else "Unassigned", r.result, _percent(r.first), _percent(r.best), _percent(r.latest), len(r.post_attempts), config.max_attempts if config else "Not configured", _date(r.enrolment.completion.completed_at) if r.enrolment.completion else "Not completed", "Yes" if red else "No"])
    report.definitions = ["First and best scores are retained separately; a later attempt never overwrites an earlier one.", "Passed is decided from the unrounded score. Displayed scores are rounded down.", "A red flag means the latest outcome is Not Passed or Needs Re-training. It is a learning follow-up, not a disciplinary record."]
    return report


def learning_gain(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.LEARNING_GAIN, *TITLES[ReportCode.LEARNING_GAIN], ["Employee", "Training", "Batch", "Pre-Test %", "First Post-Test %", "Gain (points)", "Normalised Gain %", "Note"])
    for r in rows:
        pre = float(r.pre_attempt.score_percent) if r.pre_attempt else None
        post = float(r.first) if r.first is not None else None
        absolute, normalised, note = gain_values(pre, post)
        if pre is None and not r.enrolment.training.pretest_enabled:
            note = "Pre-test not configured"
        report.rows.append([r.enrolment.employee.full_name, r.enrolment.training.title, r.enrolment.batch.name if r.enrolment.batch else "Unassigned", _percent(pre), _percent(post), absolute if absolute is not None else "Not comparable", normalised if normalised is not None else "Not comparable", note or ""])
    report.definitions = ["Gain = first post-test percentage minus pre-test percentage, in percentage points.", "Normalised gain = (post − pre) / (100 − pre) × 100. It is unavailable when the pre-test was 100%. The formula awaits analytics approval.", "A missing pre-test is never treated as zero."]
    return report


def behaviour(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.BEHAVIOUR, *TITLES[ReportCode.BEHAVIOUR], ["Employee", "Training", "Period (days)", "Competency", "Self /5", "Manager /5", "Gap (manager − self)", "Status", "Self Example", "Manager Example"])
    now = utcnow()
    grouped: dict[tuple, dict] = {}
    for review in behaviour_reviews(db, [r.enrolment.id for r in rows]):
        cycle = review.cycle
        for question in cycle.template.questions:
            key = (cycle.employee.full_name, cycle.training.title, cycle.period_days, question.competency.name, str(cycle.id))
            entry = grouped.setdefault(key, {"self": None, "manager": None, "self_example": None, "manager_example": None, "status": []})
            answer = next((x for x in review.responses if x.template_question_id == question.id), None)
            kind = "self" if review.reviewer_type == ReviewerType.SELF else "manager"
            if answer:
                entry[kind], entry[f"{kind}_example"] = answer.rating, answer.example_text
            entry["status"].append(review_status(review, now))
    for key in sorted(grouped, key=lambda k: k[:4]):
        v = grouped[key]
        gap = v["manager"] - v["self"] if v["self"] is not None and v["manager"] is not None else "Not comparable"
        statuses = set(v["status"])
        state = "Not yet due" if statuses == {"NOT_DUE"} else "Complete" if statuses == {"SUBMITTED"} else "Overdue" if "OVERDUE" in statuses else "Pending"
        report.rows.append([key[0], key[1], key[2], key[3], v["self"] if v["self"] is not None else MISSING, v["manager"] if v["manager"] is not None else MISSING, gap, state, v["self_example"] or MISSING, v["manager_example"] or MISSING])
    report.definitions = ["Ratings are compared only for the same employee, competency and follow-up period.", "The gap is a descriptive difference, not a performance judgement.", "Self and manager ratings are never averaged together."]
    return report


def question_analytics(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.QUESTION_ANALYTICS, *TITLES[ReportCode.QUESTION_ANALYTICS], ["Training", "Question ID", "Version", "Topic", "Difficulty", "Responses", "Correct %", "Incorrect %", "Minimum Sample", "Review Flag"])
    attempts = {a.id: r.enrolment.training for r in rows for a in r.post_attempts if a.status != AttemptStatus.CANCELLED}
    if not attempts:
        return report
    questions = db.scalars(select(AttemptQuestion).options(selectinload(AttemptQuestion.answer)).where(AttemptQuestion.attempt_id.in_(list(attempts)))).all()
    from app.models import Question

    codes = {q.id: q.question_code for q in db.scalars(select(Question).where(Question.id.in_({x.question_id for x in questions})))}
    groups: dict[tuple, dict] = defaultdict(lambda: {"total": 0, "correct": 0})
    for q in questions:
        if not q.answer or not q.answer.selected_option_ids:
            continue  # Unanswered timed-out questions are excluded (BR §15.3).
        training: Training = attempts[q.attempt_id]
        group = groups[(training.title, codes[q.question_id], q.question_version, q.topic_snapshot, q.difficulty_snapshot, training.item_minimum_sample)]
        group["total"] += 1
        group["correct"] += 1 if q.answer.is_correct else 0
    for key in sorted(groups):
        g = groups[key]
        correct = round(g["correct"] / g["total"] * 100, 1)
        incorrect = round(100 - correct, 1)
        flag = "Insufficient sample" if g["total"] < key[5] else "Review required" if incorrect > 70 else "No flag"
        report.rows.append([key[0], key[1], key[2], key[3], key[4].title(), g["total"], correct, incorrect, key[5], flag])
    report.definitions = ["Correct % is the item difficulty index: correct responses divided by answered responses.", "A question is flagged when more than 70% answered incorrectly and the minimum sample is met. A flag prompts review; it does not delete a question.", "Blank answers are excluded."]
    return report


def employee_history(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.EMPLOYEE_HISTORY, *TITLES[ReportCode.EMPLOYEE_HISTORY], ["Employee", "Employee ID", "Training", "Batch", "Type", "Attempt", "Score %", "Result", "Submitted (UTC)", "Submission"])
    labels = {"MANUAL": "By employee", "TIME_EXPIRED": "Time expired", "VIOLATION_LIMIT": "Violation limit"}
    for r in rows:
        e, t = r.enrolment.employee, r.enrolment.training
        batch = r.enrolment.batch.name if r.enrolment.batch else "Unassigned"
        if r.pre_attempt:
            a = r.pre_attempt
            report.rows.append([e.full_name, e.employee_code, t.title, batch, "Pre-test", 1, _percent(a.score_percent), a.result_status, a.submitted_at.strftime("%Y-%m-%d %H:%M"), labels.get(a.submission_reason, "")])
        if not r.post_attempts:
            report.rows.append([e.full_name, e.employee_code, t.title, batch, "Post-test", "Not submitted", MISSING, r.result, "Not submitted", ""])
        for a in r.post_attempts:
            report.rows.append([e.full_name, e.employee_code, t.title, batch, "Post-test", a.attempt_number, _percent(a.score_percent), a.result_status, a.submitted_at.strftime("%Y-%m-%d %H:%M"), labels.get(a.submission_reason, "")])
    report.definitions = ["Every submitted attempt is listed. Earlier attempts are never deleted or replaced."]
    return report


def scorecard_summary(db: Session, rows: list[Row]) -> Report:
    report = Report(ReportCode.SCORECARD, *TITLES[ReportCode.SCORECARD], ["Training", "Cohorts", "Assignments", "Learning State", "Mean Pre-Test %", "Mean First %", "Mean Best %", "Mean Gain (points)", "Pass Rate %", "Behaviour State", "Self Mean /5", "Manager Mean /5", "Self-Manager Gap"])
    by_training: dict[uuid.UUID, list[Row]] = defaultdict(list)
    for r in rows:
        by_training[r.enrolment.training_id].append(r)
    now = utcnow()
    for group in sorted(by_training.values(), key=lambda g: g[0].enrolment.training.title):
        training = group[0].enrolment.training
        reviews = behaviour_reviews(db, [r.enrolment.id for r in group])
        assessed = [r for r in group if r.post_attempts]
        pairs = [gain_values(float(r.pre_attempt.score_percent), float(r.first))[0] for r in group if r.pre_attempt and r.first is not None]
        passed = sum(1 for r in assessed if r.result == "PASSED")
        self_mean = mean([x.rating for v in reviews if v.reviewer_type == ReviewerType.SELF for x in v.responses])
        manager_mean = mean([x.rating for v in reviews if v.reviewer_type == ReviewerType.MANAGER for x in v.responses])
        report.rows.append([
            training.title,
            "; ".join(sorted({r.enrolment.batch.name for r in group if r.enrolment.batch})) or "Unassigned",
            len(group),
            str(learning_state(db, training, group, now).value),
            _percent(mean([r.pre_attempt.score_percent for r in group if r.pre_attempt])),
            _percent(mean([r.first for r in assessed])),
            _percent(mean([r.best for r in assessed])),
            mean(pairs) if pairs else "Not comparable",
            round(passed / len(assessed) * 100, 1) if assessed else MISSING,
            str(behaviour_state(db, training, reviews, now).value),
            self_mean if self_mean is not None else MISSING,
            manager_mean if manager_mean is not None else MISSING,
            round(manager_mean - self_mean, 2) if self_mean is not None and manager_mean is not None else "Not comparable",
        ])
    report.definitions = ["Learning and Behaviour stay separate. There is no combined effectiveness score.", INTERPRETATION]
    return report


BUILDERS = {
    ReportCode.COMPLIANCE: compliance,
    ReportCode.PASS_FAIL: pass_fail,
    ReportCode.LEARNING_GAIN: learning_gain,
    ReportCode.BEHAVIOUR: behaviour,
    ReportCode.QUESTION_ANALYTICS: question_analytics,
    ReportCode.EMPLOYEE_HISTORY: employee_history,
    ReportCode.SCORECARD: scorecard_summary,
}
