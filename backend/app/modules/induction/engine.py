"""The induction assessment and feedback lifecycle, on the induction tables.

The rules are the Training engine's (app.modules.assessment.service): the server decides time, marks and
pass/fail; answers are saved with compare-and-set revisions; security events are merged per incident; finalisation is
row-locked and idempotent. Its scoring helpers are imported, not copied.

The one-time rule: an employee has at most one assignment, one attempt and one feedback row (unique employee_id in
each table). Starting locks the assignment row, so duplicate or concurrent starts return the same attempt. There is
no retake: a submitted, timed-out or violation-ended attempt is final.
"""
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.enums import (
    VIOLATION_EVENT_TYPES,
    AttemptStatus,
    InductionAssignmentStatus,
    InductionStatus,
    ResultStatus,
    SecurityEventType,
    SubmissionReason,
)
from app.core.errors import ApiError, conflict, not_found, validation
from app.core.responses import display_percent, iso, num
from app.models import (
    InductionAssignment,
    InductionAttempt,
    InductionAttemptAnswer,
    InductionAttemptQuestion,
    InductionAttemptSecurityEvent,
    InductionFeedback,
    InductionFeedbackForm,
)
from app.modules.assessment.service import INCIDENT_MERGE_SECONDS, is_pass, truncate_percent
from app.modules.induction import configuration
from app.modules.induction.common import batch_label

ASSESSMENT_TITLE = "Common Induction Assessment"
FINISHED = (AttemptStatus.SUBMITTED, AttemptStatus.TIMED_OUT)


# ---------- Lookups ----------

def own_assignment(db: Session, employee_id: uuid.UUID, lock: bool = False) -> InductionAssignment | None:
    query = select(InductionAssignment).where(InductionAssignment.employee_id == employee_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return db.scalar(query)


def attempt_of(db: Session, assignment_id: uuid.UUID) -> InductionAttempt | None:
    return db.scalar(select(InductionAttempt).where(InductionAttempt.assignment_id == assignment_id))


def get_own_attempt(db: Session, attempt_id: uuid.UUID, employee_id: uuid.UUID) -> InductionAttempt:
    attempt = db.get(InductionAttempt, attempt_id)
    if attempt is None or attempt.employee_id != employee_id:
        raise not_found()  # The same answer whether it exists or not.
    return attempt


def _lock_attempt(db: Session, attempt: InductionAttempt) -> None:
    db.execute(select(InductionAttempt.id).where(InductionAttempt.id == attempt.id).with_for_update())
    db.refresh(attempt)


# ---------- Starting ----------

def _snapshot(settings, question_count: int) -> dict:
    return {
        "settings_id": str(settings.id),
        "version": settings.version,
        "question_count": question_count,
        "duration_seconds": settings.duration_seconds,
        "pass_mark_percent": str(settings.pass_mark_percent),
        "max_attempts": 1,
        "show_explanations": False,
        "violation_limit": settings.violation_limit,
        "require_fullscreen": settings.require_fullscreen,
    }


def start_attempt(db: Session, employee_id: uuid.UUID, acknowledged: bool, now: datetime | None = None) -> InductionAttempt:
    """Starts the one allowed attempt, or returns the attempt already running on any device."""
    now = now or utcnow()
    assignment = own_assignment(db, employee_id, lock=True)  # Serialises every start for this employee.
    if assignment is None:
        raise not_found("No induction is assigned to you.")
    existing = attempt_of(db, assignment.id)
    if existing is not None:
        if existing.status == AttemptStatus.IN_PROGRESS:
            if existing.expires_at > now:
                return existing
            finalise_attempt(db, existing.id, now=now)
            db.commit()  # Keep the timed-out result: the error below ends the request's transaction.
        raise conflict("INDUCTION_ALREADY_TAKEN", "You have already taken the induction assessment. It can be taken only once.", {"attempt_id": str(existing.id)})
    if assignment.induction.status == InductionStatus.ARCHIVED:
        raise conflict("INDUCTION_ARCHIVED", "This induction has been archived, so its assessment is not available. Contact L&D.")
    ready = configuration.readiness(db)
    if not ready["ready"]:
        raise ApiError(422, "INDUCTION_NOT_READY", "The induction assessment is not ready yet. L&D has been notified. You can keep using TrainCheck until it is ready.")
    if not acknowledged:
        raise validation("Confirm that you have read and understood the instructions.")

    settings = configuration.current_settings(db)
    form = configuration.current_form(db)
    questions = configuration.active_questions(db)
    attempt = InductionAttempt(
        assignment_id=assignment.id,
        employee_id=employee_id,
        induction_id=assignment.induction_id,
        batch_id=assignment.batch_id,
        settings_id=settings.id,
        status=AttemptStatus.IN_PROGRESS,
        started_at=now,
        expires_at=now + timedelta(seconds=settings.duration_seconds),
        config_snapshot=_snapshot(settings, len(questions)),
        acknowledged_at=now,
    )
    db.add(attempt)
    try:
        db.flush()
    except IntegrityError as exc:  # Only possible without the row lock; reported, and the page resumes.
        db.rollback()
        raise conflict("ACTIVE_ATTEMPT_EXISTS", "Your induction assessment is already open. Resume the current attempt.") from exc
    for order, q in enumerate(questions, start=1):
        db.add(
            InductionAttemptQuestion(
                attempt_id=attempt.id,
                question_id=q.id,
                question_version=q.version,
                display_order=order,
                question_text_snapshot=q.question_text,
                question_type_snapshot=q.question_type,
                topic_snapshot=q.topic,
                # The configured order: the same paper for everyone (no shuffling).
                options_snapshot=[{"option_id": str(o.id), "label": chr(65 + i), "text": o.option_text} for i, o in enumerate(q.options)],
                marks_snapshot=q.marks,
                answer_key_snapshot=[str(o.id) for o in q.options if o.is_correct],
                explanation_snapshot=q.explanation,
            )
        )
    assignment.status = InductionAssignmentStatus.IN_PROGRESS
    assignment.feedback_form_id = form.id  # Frozen: later form edits never change what this employee is asked.
    db.flush()
    record_audit(db, None, "INDUCTION_ATTEMPT_STARTED", "induction_attempt", attempt.id, after={"assignment_id": str(assignment.id), "settings_version": settings.version, "feedback_form_version": form.version})
    return attempt


# ---------- During the attempt ----------

def require_open(db: Session, attempt: InductionAttempt, now: datetime) -> None:
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise conflict("ATTEMPT_ALREADY_SUBMITTED", "This attempt has been submitted. No more changes can be saved.", {"attempt_id": str(attempt.id)})
    if attempt.expires_at <= now:
        finalise_attempt(db, attempt.id, now=now)
        db.commit()
        raise conflict("ATTEMPT_ALREADY_SUBMITTED", "Time has expired. Your saved answers were submitted.", {"attempt_id": str(attempt.id)})


def _answer_for(db: Session, attempt_question_id: uuid.UUID) -> InductionAttemptAnswer | None:
    return db.scalar(select(InductionAttemptAnswer).where(InductionAttemptAnswer.attempt_question_id == attempt_question_id))


def _insert_answer(db: Session, answer: InductionAttemptAnswer) -> bool:
    try:
        with db.begin_nested():
            db.add(answer)
            db.flush()
        return True
    except IntegrityError:
        return False


def _own_question(db: Session, attempt: InductionAttempt, attempt_question_id: uuid.UUID) -> InductionAttemptQuestion:
    question = db.get(InductionAttemptQuestion, attempt_question_id)
    if question is None or question.attempt_id != attempt.id:
        raise not_found()
    return question


def save_answer(db: Session, attempt: InductionAttempt, attempt_question_id: uuid.UUID, selected: list[str], now: datetime | None = None, base_revision: int | None = None, op_id: str | None = None, _retried: bool = False) -> InductionAttemptAnswer:
    """Idempotent and compare-and-set, exactly as the Training engine's save_answer."""
    now = now or utcnow()
    _lock_attempt(db, attempt)
    require_open(db, attempt, now)
    question = _own_question(db, attempt, attempt_question_id)
    allowed = {o["option_id"] for o in question.options_snapshot}
    clean = list(dict.fromkeys(selected))
    if any(option not in allowed for option in clean):
        raise validation("That answer does not belong to this question.")
    if question.question_type_snapshot != "MCQ_MULTIPLE" and len(clean) > 1:
        raise validation("Select one answer for this question.")
    answer = _answer_for(db, question.id)
    current = list(answer.selected_option_ids) if answer else []
    revision = answer.revision if answer else 0
    if answer is not None and set(current) == set(clean):
        return answer
    if base_revision is not None and base_revision != revision:
        raise conflict(
            "ANSWER_CONFLICT",
            "This answer was changed in another window or on another device. The newer answer is kept.",
            {"selected_option_ids": current, "revision": revision, "op_id": answer.last_op_id if answer else None},
        )
    if answer is None:
        answer = InductionAttemptAnswer(attempt_question_id=question.id, selected_option_ids=clean, saved_at=now, revision=revision + 1, last_op_id=op_id)
        if not _insert_answer(db, answer):
            if _retried:
                raise conflict("ANSWER_CONFLICT", "This answer was changed at the same moment elsewhere. Please choose again.")
            return save_answer(db, attempt, attempt_question_id, selected, now, base_revision, op_id, _retried=True)
    else:
        answer.selected_option_ids = clean
        answer.saved_at = now
        answer.revision = revision + 1
        answer.last_op_id = op_id
    db.flush()
    return answer


def set_review_mark(db: Session, attempt: InductionAttempt, attempt_question_id: uuid.UUID, marked: bool, now: datetime | None = None) -> None:
    now = now or utcnow()
    _lock_attempt(db, attempt)
    require_open(db, attempt, now)
    question = _own_question(db, attempt, attempt_question_id)
    answer = _answer_for(db, question.id)
    if answer is None and _insert_answer(db, InductionAttemptAnswer(attempt_question_id=question.id, selected_option_ids=[], marked_for_review=marked, saved_at=now)):
        return
    answer = answer or _answer_for(db, question.id)
    answer.marked_for_review = marked
    db.flush()


def record_security_event(db: Session, attempt: InductionAttempt, event_type: str, now: datetime | None = None) -> dict:
    """The server decides what counts; signals within one incident are merged, as for Training assessments."""
    now = now or utcnow()
    _lock_attempt(db, attempt)
    limit = int(attempt.config_snapshot["violation_limit"])

    def summary(counted: bool, final: bool = False) -> dict:
        return {"counted": counted, "violation_count": attempt.violation_count, "violation_limit": limit, "auto_submitted": final, "status": attempt.status}

    if attempt.status != AttemptStatus.IN_PROGRESS:
        return summary(False)
    if attempt.expires_at <= now:
        finalise_attempt(db, attempt.id, now=now)
        return summary(False)
    event = SecurityEventType(event_type)
    if event not in VIOLATION_EVENT_TYPES:
        db.add(InductionAttemptSecurityEvent(attempt_id=attempt.id, event_type=event, signals=[event.value], occurred_at=now))
        db.flush()
        return summary(False)
    last = db.scalar(
        select(InductionAttemptSecurityEvent)
        .where(InductionAttemptSecurityEvent.attempt_id == attempt.id, InductionAttemptSecurityEvent.violation_number.is_not(None))
        .order_by(InductionAttemptSecurityEvent.occurred_at.desc())
        .limit(1)
    )
    if last is not None and (now - last.occurred_at).total_seconds() < INCIDENT_MERGE_SECONDS:
        if event.value not in last.signals:
            last.signals = [*last.signals, event.value]
        db.flush()
        return summary(False)
    attempt.violation_count += 1
    db.add(InductionAttemptSecurityEvent(attempt_id=attempt.id, event_type=event, signals=[event.value], violation_number=attempt.violation_count, occurred_at=now))
    db.flush()
    if attempt.violation_count >= limit:
        finalise_attempt(db, attempt.id, reason=SubmissionReason.VIOLATION_LIMIT, now=now)
        return summary(True, final=True)
    return summary(True)


# ---------- Finalising ----------

def finalise_attempt(db: Session, attempt_id: uuid.UUID, reason: SubmissionReason | None = None, now: datetime | None = None) -> InductionAttempt:
    """The only route to a result. Row-locked and idempotent: a repeat returns the same result."""
    now = now or utcnow()
    attempt = db.scalar(select(InductionAttempt).where(InductionAttempt.id == attempt_id).with_for_update().execution_options(populate_existing=True))
    if attempt is None:
        raise not_found()
    if attempt.status != AttemptStatus.IN_PROGRESS:
        return attempt
    expired = now >= attempt.expires_at
    questions = db.scalars(select(InductionAttemptQuestion).options(selectinload(InductionAttemptQuestion.answer)).where(InductionAttemptQuestion.attempt_id == attempt.id)).all()
    earned, total = Decimal(0), Decimal(0)
    for question in questions:
        total += question.marks_snapshot
        answer = question.answer
        selected = set(answer.selected_option_ids) if answer else set()
        correct = selected == set(question.answer_key_snapshot) and bool(selected)
        awarded = question.marks_snapshot if correct else Decimal(0)
        earned += awarded
        if answer is not None:
            answer.is_correct = correct
            answer.marks_awarded = awarded
    if total <= 0:
        raise ApiError(422, "INDUCTION_NOT_READY", "This attempt has no valid marks. Contact L&D.")
    passed = is_pass(earned, total, Decimal(attempt.config_snapshot["pass_mark_percent"]))
    attempt.status = AttemptStatus.TIMED_OUT if expired else AttemptStatus.SUBMITTED
    attempt.submitted_at = min(now, attempt.expires_at) if expired else now
    attempt.submission_reason = SubmissionReason.TIME_EXPIRED if expired else (reason or SubmissionReason.MANUAL)
    attempt.obtained_marks = earned
    attempt.total_marks = total
    attempt.score_percent = truncate_percent(earned, total)
    attempt.result_status = ResultStatus.PASSED if passed else ResultStatus.NOT_PASSED
    assignment = db.get(InductionAssignment, attempt.assignment_id)
    # Participation moves on whatever the score: the feedback form comes next. Pass/fail stays on the attempt.
    if assignment.status in (InductionAssignmentStatus.ASSIGNED, InductionAssignmentStatus.IN_PROGRESS):
        assignment.status = InductionAssignmentStatus.FEEDBACK_PENDING
    assignment.assessment_submitted_at = attempt.submitted_at
    db.flush()
    return attempt


def finalise_expired(db: Session, employee_id: uuid.UUID, now: datetime) -> None:
    """A deadline that passes with nobody connected still produces exactly one result."""
    import logging

    attempt = db.scalar(select(InductionAttempt).where(InductionAttempt.employee_id == employee_id, InductionAttempt.status == AttemptStatus.IN_PROGRESS, InductionAttempt.expires_at <= now))
    if attempt is None:
        return
    try:
        with db.begin_nested():
            finalise_attempt(db, attempt.id, now=now)
    except Exception:
        logging.getLogger("traincheck.induction").exception("Could not finalise expired induction attempt %s", attempt.id)


# ---------- Views (employee) ----------

def attempt_view(db: Session, attempt: InductionAttempt) -> dict:
    """The Training AttemptView shape, so the existing exam screen runs it unchanged. No answer key."""
    questions = db.scalars(
        select(InductionAttemptQuestion).options(selectinload(InductionAttemptQuestion.answer)).where(InductionAttemptQuestion.attempt_id == attempt.id).order_by(InductionAttemptQuestion.display_order)
    ).all()
    snapshot = attempt.config_snapshot
    now = utcnow()
    return {
        "attempt_id": str(attempt.id),
        "obligation_id": str(attempt.assignment_id),
        "assessment_type": "INDUCTION",
        "training_title": ASSESSMENT_TITLE,
        "attempt_number": 1,
        "max_attempts": 1,
        "status": attempt.status,
        "started_at": iso(attempt.started_at),
        "expires_at": iso(attempt.expires_at),
        "server_now": iso(now),
        "remaining_seconds": max(0, int((attempt.expires_at - now).total_seconds())),
        "violation_count": attempt.violation_count,
        "violation_limit": snapshot["violation_limit"],
        "require_fullscreen": bool(snapshot["require_fullscreen"]),
        "monitored": True,
        "questions": [
            {
                "attempt_question_id": str(q.id),
                "position": q.display_order,
                "question_text": q.question_text_snapshot,
                "question_type": q.question_type_snapshot,
                "topic": q.topic_snapshot,
                "language": "English",
                "marks": num(q.marks_snapshot),
                "options": q.options_snapshot,
                "selected_option_ids": q.answer.selected_option_ids if q.answer else [],
                "revision": q.answer.revision if q.answer else 0,
                "op_id": q.answer.last_op_id if q.answer else None,
                "marked_for_review": q.answer.marked_for_review if q.answer else False,
                "saved_at": iso(q.answer.saved_at) if q.answer else None,
            }
            for q in questions
        ],
    }


def result_facts(db: Session, attempt: InductionAttempt) -> dict:
    """The finalised outcome. Shared by the employee's result page and L&D's record detail."""
    questions = db.scalars(
        select(InductionAttemptQuestion).options(selectinload(InductionAttemptQuestion.answer)).where(InductionAttemptQuestion.attempt_id == attempt.id).order_by(InductionAttemptQuestion.display_order)
    ).all()
    topics: dict[str, list[float]] = {}
    answered = correct = 0
    for q in questions:
        selected = q.answer.selected_option_ids if q.answer else []
        answered += 1 if selected else 0
        correct += 1 if q.answer and q.answer.is_correct else 0
        bucket = topics.setdefault(q.topic_snapshot, [0.0, 0.0])
        bucket[0] += float(q.answer.marks_awarded or 0) if q.answer else 0.0
        bucket[1] += float(q.marks_snapshot)
    return {
        "attempt_id": str(attempt.id),
        "attempt_status": attempt.status,
        "score_percent": display_percent(attempt.score_percent),
        "result_status": attempt.result_status,
        "pass_mark_percent": float(attempt.config_snapshot["pass_mark_percent"]),
        "obtained_marks": num(attempt.obtained_marks),
        "total_marks": num(attempt.total_marks),
        "started_at": iso(attempt.started_at),
        "submitted_at": iso(attempt.submitted_at),
        "submission_reason": attempt.submission_reason,
        "time_taken_seconds": int((attempt.submitted_at - attempt.started_at).total_seconds()) if attempt.submitted_at else None,
        "question_count": len(questions),
        "answered_count": answered,
        "correct_count": correct,
        "settings_version": attempt.config_snapshot.get("version"),
        "topics": [{"name": name, "score": round(v[0] / v[1] * 100, 1) if v[1] else None} for name, v in topics.items()],
        "violations": [{"number": e.violation_number, "type": e.event_type, "signals": e.signals, "occurred_at": iso(e.occurred_at)} for e in attempt.security_events if e.violation_number is not None],
    }


def result_view(db: Session, attempt: InductionAttempt) -> dict:
    assignment = attempt.assignment
    feedback = db.scalar(select(InductionFeedback).where(InductionFeedback.assignment_id == assignment.id))
    return {
        **result_facts(db, attempt),
        "assessment_type": "INDUCTION",
        "training_title": ASSESSMENT_TITLE,
        "induction_name": assignment.induction.name,
        "batch_label": batch_label(assignment.batch),
        "attempt_number": 1,
        "max_attempts": 1,
        "explanations_enabled": False,
        "induction_status": assignment.status,
        "feedback_submitted": feedback is not None,
        "feedback_submitted_at": iso(feedback.submitted_at) if feedback else None,
        "completed_at": iso(assignment.completed_at),
    }


# ---------- Feedback ----------

class FeedbackIn(BaseModel):
    ratings: dict[str, int] = Field(max_length=configuration.MAX_FEEDBACK_QUESTIONS)
    comment: str | None = Field(default=None, max_length=configuration.MAX_COMMENT)


def _form_for(db: Session, assignment: InductionAssignment) -> InductionFeedbackForm | None:
    return db.get(InductionFeedbackForm, assignment.feedback_form_id) if assignment.feedback_form_id else None


def feedback_view(db: Session, assignment: InductionAssignment) -> dict:
    """What the employee's feedback dialog needs. Questions come from the version frozen at assessment start."""
    submitted = db.scalar(select(InductionFeedback).where(InductionFeedback.assignment_id == assignment.id))
    form = _form_for(db, assignment)
    snapshot = submitted.form_snapshot if submitted else ({"questions": form.questions, "comment_enabled": form.comment_enabled, "comment_label": form.comment_label} if form else None)
    return {
        "required": assignment.status == InductionAssignmentStatus.FEEDBACK_PENDING and form is not None,
        "submitted": submitted is not None,
        "submitted_at": iso(submitted.submitted_at) if submitted else None,
        "training_title": assignment.induction.name,
        "form_version": submitted.form_version if submitted else (form.version if form else None),
        "questions": configuration.form_questions_for_employee(snapshot["questions"]) if snapshot else [],
        "comment_enabled": bool(snapshot and snapshot["comment_enabled"]),
        "comment_label": (snapshot or {}).get("comment_label"),
    }


def submit_feedback(db: Session, employee_id: uuid.UUID, body: FeedbackIn, now: datetime | None = None) -> InductionAssignment:
    """Saved once. A retry after success returns the saved outcome without a second record; answers cannot be edited."""
    now = now or utcnow()
    assignment = own_assignment(db, employee_id, lock=True)
    if assignment is None:
        raise not_found("No induction is assigned to you.")
    if db.scalar(select(InductionFeedback.id).where(InductionFeedback.assignment_id == assignment.id)) is not None:
        return assignment  # Already saved (a retried request): the same outcome, nothing new.
    if assignment.status != InductionAssignmentStatus.FEEDBACK_PENDING:
        raise conflict("FEEDBACK_NOT_DUE", "The induction feedback form opens after you submit your induction assessment.")
    attempt = attempt_of(db, assignment.id)
    form = _form_for(db, assignment)
    if attempt is None or form is None:
        raise conflict("FEEDBACK_NOT_DUE", "The induction feedback form is not available yet.")
    keys = [q["key"] for q in form.questions]
    if set(body.ratings) != set(keys):
        raise validation(f"Please answer all {len(keys)} rating questions.")
    if any(not isinstance(v, int) or isinstance(v, bool) or v < 1 or v > 5 for v in body.ratings.values()):
        raise validation("Each rating must be between 1 and 5.")
    comment = (body.comment or "").strip() or None
    if comment and not form.comment_enabled:
        raise validation("This feedback form does not take comments.")
    feedback = InductionFeedback(
        employee_id=employee_id,
        assignment_id=assignment.id,
        attempt_id=attempt.id,
        induction_id=assignment.induction_id,
        batch_id=assignment.batch_id,
        form_id=form.id,
        form_version=form.version,
        form_snapshot={"questions": form.questions, "comment_enabled": form.comment_enabled, "comment_label": form.comment_label},
        ratings={k: body.ratings[k] for k in keys},
        comment_text=comment,
        submitted_at=now,
    )
    try:
        with db.begin_nested():  # Added inside the savepoint: begin_nested() flushes pending objects first.
            db.add(feedback)
            db.flush()
    except IntegrityError:
        return assignment  # Saved by a concurrent request: one record, the same outcome.
    assignment.status = InductionAssignmentStatus.COMPLETED
    assignment.completed_at = now
    db.flush()
    record_audit(db, None, "INDUCTION_FEEDBACK_SUBMITTED", "induction_feedback", feedback.id, after={"assignment_id": str(assignment.id), "form_version": form.version})
    return assignment
