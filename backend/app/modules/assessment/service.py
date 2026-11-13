"""Backend-controlled examination engine: selection, timing, saving, scoring and retakes.

The browser never decides eligibility, time, marks or pass/fail.
"""
import random
import uuid
from datetime import datetime, timedelta
from decimal import ROUND_DOWN, Decimal
from fractions import Fraction

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.deps import current_manager_id
from app.core.enums import (
    VIOLATION_EVENT_TYPES,
    AssessmentType,
    AttemptStatus,
    Difficulty,
    ObligationStatus,
    QuestionStatus,
    ResultStatus,
    RetrainingFlag,
    SecurityEventType,
    SubmissionReason,
)
from app.core.errors import ApiError, conflict, not_found, validation
from app.core.responses import display_percent
from app.models import (
    AssessmentAttempt,
    AssessmentConfig,
    AssessmentObligation,
    AttemptAnswer,
    AttemptQuestion,
    AttemptSecurityEvent,
    Question,
    QuestionAnswerKey,
    QuestionTrainingTag,
    RefresherAcknowledgement,
)
from app.modules.assessment.scheduling import load_calendar
from app.modules.notifications.service import notify_employee, notify_roles

# Signals within this window, or while the employee has not returned, are one incident (SC-2L-106).
INCIDENT_MERGE_SECONDS = 2


# ---------- Question pool ----------

def eligible_questions(db: Session, training_id: uuid.UUID) -> list[Question]:
    return list(
        db.scalars(
            select(Question)
            .join(QuestionTrainingTag, QuestionTrainingTag.question_id == Question.id)
            .options(selectinload(Question.options), selectinload(Question.competency))
            .where(QuestionTrainingTag.training_id == training_id, Question.status == QuestionStatus.ACTIVE)
        )
    )


def answer_keys(db: Session, question_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
    keys: dict[uuid.UUID, list[str]] = {}
    for question_id, option_id in db.execute(
        select(QuestionAnswerKey.question_id, QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id.in_(question_ids))
    ):
        keys.setdefault(question_id, []).append(str(option_id))
    return keys


# Suggested questions per attempt for a new configuration: min(this, eligible questions).
SUGGESTED_QUESTIONS_PER_ATTEMPT = 10
EXAMPLE_CODES = 5


def pool_report(db: Session, training_id: uuid.UUID, question_count: int | None = None, difficulty_mix: dict[str, int] | None = None) -> dict:
    """Describes a training's question pool and, given a configuration, whether it can run (BR §7, §20.4).

    Eligible means: linked to this training, Active, has an answer key and has at least two options.
    The same rule decides what start_attempt may draw, so this report and the engine always agree.
    """
    linked = list(
        db.scalars(
            select(Question)
            .join(QuestionTrainingTag, QuestionTrainingTag.question_id == Question.id)
            .options(selectinload(Question.options))
            .where(QuestionTrainingTag.training_id == training_id)
            .order_by(Question.question_code)
        )
    )
    active = [q for q in linked if q.status == QuestionStatus.ACTIVE]
    keys = answer_keys(db, [q.id for q in active]) if active else {}
    missing_key = [q for q in active if not keys.get(q.id)]
    few_options = [q for q in active if len(q.options) < 2]
    eligible = [q for q in active if keys.get(q.id) and len(q.options) >= 2]
    by_difficulty = {level.value: sum(1 for q in eligible if q.difficulty == level) for level in Difficulty}

    report: dict = {
        "training_id": str(training_id),
        "linked_total": len(linked),
        "active": len(active),
        "inactive": len(linked) - len(active),
        "missing_answer_key": len(missing_key),
        "missing_answer_key_codes": [q.question_code for q in missing_key[:EXAMPLE_CODES]],
        "insufficient_options": len(few_options),
        "insufficient_options_codes": [q.question_code for q in few_options[:EXAMPLE_CODES]],
        "eligible": len(eligible),
        "eligible_by_difficulty": by_difficulty,
        "suggested_question_count": min(SUGGESTED_QUESTIONS_PER_ATTEMPT, len(eligible)),
        "required": None,
        "shortfall": None,
        "difficulty_mix": difficulty_mix or None,
        "mix_total": None,
        "difficulty_shortfalls": [],
        "reason": None,
        "ready": None,
    }
    if question_count is None:
        return report

    report["required"] = question_count
    report["shortfall"] = max(0, question_count - len(eligible))
    reasons = []
    if report["shortfall"]:
        reasons.append("INSUFFICIENT_POOL")
    if difficulty_mix:
        report["mix_total"] = sum(difficulty_mix.values())
        if report["mix_total"] != question_count:
            reasons.append("MIX_TOTAL")
        for level in Difficulty:
            wanted = difficulty_mix.get(level.value, 0)
            if wanted > by_difficulty[level.value]:
                report["difficulty_shortfalls"].append({"difficulty": level.value, "available": by_difficulty[level.value], "required": wanted, "shortfall": wanted - by_difficulty[level.value]})
        if report["difficulty_shortfalls"]:
            reasons.append("INSUFFICIENT_DIFFICULTY")
    report["reason"] = reasons[0] if reasons else None
    report["reasons"] = reasons
    report["ready"] = not reasons
    return report


def pool_message(report: dict, training_title: str) -> str:
    """A plain-language explanation for L&D of why a configuration cannot be saved or activated."""
    if report.get("reason") == "NOT_CONFIGURED":
        return f"{training_title} has no assessment configuration yet. Open Assessment Configuration and save one first."
    parts = []
    eligible, required = report["eligible"], report["required"]
    noun = "question" if eligible == 1 else "questions"
    if "INSUFFICIENT_POOL" in report.get("reasons", []):
        if eligible == 0:
            parts.append(f"{training_title} has no eligible active questions. Add or import questions for this training.")
        else:
            parts.append(f"{training_title} has {eligible} eligible active {noun}, but the assessment requires {required}. Add {report['shortfall']} more or reduce questions per attempt to {eligible}.")
    if "MIX_TOTAL" in report.get("reasons", []):
        parts.append(f"The difficulty counts total {report['mix_total']}, but questions per attempt is {required}.")
    for gap in report.get("difficulty_shortfalls", []):
        parts.append(f"{gap['difficulty'].title()}: {gap['available']} available, {gap['required']} required.")
    return " ".join(parts) or "The active question pool cannot satisfy this configuration."


def pool_problem(db: Session, config: AssessmentConfig) -> dict | None:
    """Explains why a configuration cannot run, or returns None when it can (BR §20.4)."""
    report = pool_report(db, config.training_id, config.question_count, config.difficulty_mix)
    return None if report["ready"] else report


def _select_questions(db: Session, config: AssessmentConfig, keys: dict[uuid.UUID, list[str]], rng: random.Random) -> list[Question]:
    pool = [q for q in eligible_questions(db, config.training_id) if keys.get(q.id) and len(q.options) >= 2]
    if config.difficulty_mix:
        chosen: list[Question] = []
        for level in Difficulty:
            candidates = [q for q in pool if q.difficulty == level]
            chosen.extend(rng.sample(candidates, config.difficulty_mix.get(level.value, 0)))
    else:
        chosen = rng.sample(pool, config.question_count)
    if config.shuffle_questions:
        rng.shuffle(chosen)
    else:
        chosen.sort(key=lambda q: q.question_code)
    return chosen


def _config_snapshot(config: AssessmentConfig) -> dict:
    return {
        "config_id": str(config.id),
        "version": config.version,
        "assessment_type": config.assessment_type,
        "question_count": config.question_count,
        "duration_seconds": config.duration_seconds,
        "pass_mark_percent": str(config.pass_mark_percent),
        "max_attempts": config.max_attempts,
        "show_explanations": config.show_explanations,
        "violation_limit": config.violation_limit,
        "require_fullscreen": config.require_fullscreen,
    }


# ---------- Starting ----------

def counted_attempts(obligation: AssessmentObligation) -> int:
    return sum(1 for a in obligation.attempts if a.status != AttemptStatus.CANCELLED)


def get_own_obligation(db: Session, obligation_id: uuid.UUID, employee_id: uuid.UUID) -> AssessmentObligation:
    obligation = db.get(AssessmentObligation, obligation_id)
    if obligation is None or obligation.employee_id != employee_id:
        raise not_found()
    return obligation


def start_attempt(db: Session, obligation: AssessmentObligation, acknowledged: bool, now: datetime | None = None, rng: random.Random | None = None) -> AssessmentAttempt:
    """Starts the one allowed attempt, or returns the attempt already running on any device."""
    now = now or utcnow()
    rng = rng or random.SystemRandom()
    db.execute(select(AssessmentObligation.id).where(AssessmentObligation.id == obligation.id).with_for_update())
    db.refresh(obligation)

    active = db.scalar(
        select(AssessmentAttempt).where(
            AssessmentAttempt.employee_id == obligation.employee_id,
            AssessmentAttempt.training_id == obligation.training_id,
            AssessmentAttempt.status == AttemptStatus.IN_PROGRESS,
        )
    )
    if active is not None:
        if active.expires_at > now:
            if active.obligation_id != obligation.id:
                raise conflict("ACTIVE_ATTEMPT_EXISTS", "Finish your other attempt for this training first.")
            return active
        finalise_attempt(db, active.id, now=now)
        db.flush()
        db.refresh(obligation)

    if obligation.assessment_type == AssessmentType.POST_TEST:
        if obligation.status in (ObligationStatus.COMPLETED, ObligationStatus.WAIVED, ObligationStatus.CANCELLED):
            raise conflict("ASSESSMENT_NOT_DUE", "This assessment is already finished.")
        if obligation.status == ObligationStatus.RETAKE_PENDING or obligation.due_at is None or obligation.due_at > now:
            raise conflict("ASSESSMENT_NOT_DUE", "This assessment is not open yet.")
        if obligation.attempts and obligation.refresher_acknowledged_at is None:
            raise conflict("REFRESHER_REQUIRED", "Review and acknowledge the refresher material before your retake.")
    elif obligation.status != ObligationStatus.DUE:
        raise conflict("ASSESSMENT_NOT_DUE", "This pre-test is not available.")

    config = obligation.config
    problem = pool_problem(db, config)
    if problem:
        # Never silently run a shorter or differently weighted assessment. An unavailable post-test
        # does not block the gate, and L&D is alerted when the employee's access is checked.
        raise ApiError(422, "QUESTION_POOL_INSUFFICIENT", "This assessment cannot start yet because its question pool is incomplete. L&D has been notified, and you can keep using TrainCheck until it is ready.", problem)

    if obligation.assessment_type == AssessmentType.POST_TEST:
        queue = _head_of_queue(db, obligation.employee_id, now)
        if queue and queue != obligation.id:
            raise conflict("ASSESSMENT_NOT_NEXT", "Complete your earlier assessment first.")

    if not acknowledged:
        raise validation("Confirm that you have read and understood the instructions.")

    if counted_attempts(obligation) >= config.max_attempts:
        raise conflict("MAX_ATTEMPTS_REACHED", "All attempts for this assessment have been used.")

    questions_keys = answer_keys(db, [q.id for q in eligible_questions(db, config.training_id)])
    chosen = _select_questions(db, config, questions_keys, rng)
    attempt = AssessmentAttempt(
        obligation_id=obligation.id,
        employee_id=obligation.employee_id,
        training_id=obligation.training_id,
        assessment_type=obligation.assessment_type,
        attempt_number=counted_attempts(obligation) + 1,
        status=AttemptStatus.IN_PROGRESS,
        started_at=now,
        expires_at=now + timedelta(seconds=config.duration_seconds),
        config_snapshot=_config_snapshot(config),
        acknowledged_at=now,
    )
    db.add(attempt)
    try:
        db.flush()
    except IntegrityError as exc:
        # The partial unique index caught a concurrent start. Report it; the client resumes.
        db.rollback()
        raise conflict("ACTIVE_ATTEMPT_EXISTS", "Your assessment is already open. Resume the current attempt.") from exc

    for order, question in enumerate(chosen, start=1):
        options = list(question.options)
        if config.shuffle_options and question.randomise_options:
            rng.shuffle(options)
        db.add(
            AttemptQuestion(
                attempt_id=attempt.id,
                question_id=question.id,
                question_version=question.version,
                display_order=order,
                question_text_snapshot=question.question_text,
                question_type_snapshot=question.question_type,
                topic_snapshot=question.topic,
                competency_snapshot=question.competency.name if question.competency else None,
                difficulty_snapshot=question.difficulty,
                language_snapshot=question.language,
                options_snapshot=[{"option_id": str(o.id), "label": chr(65 + i), "text": o.option_text} for i, o in enumerate(options)],
                marks_snapshot=question.marks,
                answer_key_snapshot=questions_keys[question.id],
                explanation_snapshot=question.explanation,
            )
        )
    obligation.status = ObligationStatus.IN_PROGRESS if obligation.assessment_type == AssessmentType.POST_TEST else obligation.status
    db.flush()
    return attempt


def _head_of_queue(db: Session, employee_id: uuid.UUID, now: datetime) -> uuid.UUID | None:
    from app.modules.assessment.gate import blocking_obligations

    queue = blocking_obligations(db, employee_id, now)
    return queue[0].id if queue else None


# ---------- During an attempt ----------

def get_own_attempt(db: Session, attempt_id: uuid.UUID, employee_id: uuid.UUID) -> AssessmentAttempt:
    attempt = db.get(AssessmentAttempt, attempt_id)
    if attempt is None or attempt.employee_id != employee_id:
        raise not_found()  # Same response whether it exists or not (SEC-001).
    return attempt


def require_open(db: Session, attempt: AssessmentAttempt, now: datetime) -> None:
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise conflict("ATTEMPT_ALREADY_SUBMITTED", "This attempt has been submitted. No more changes can be saved.", {"attempt_id": str(attempt.id)})
    if attempt.expires_at <= now:
        finalise_attempt(db, attempt.id, now=now)
        db.commit()
        raise conflict("ATTEMPT_ALREADY_SUBMITTED", "Time has expired. Your saved answers were submitted.", {"attempt_id": str(attempt.id)})


def save_answer(db: Session, attempt: AssessmentAttempt, attempt_question_id: uuid.UUID, selected: list[str], now: datetime | None = None) -> AttemptAnswer:
    """Idempotent: a retried save simply stores the same selection again."""
    now = now or utcnow()
    db.execute(select(AssessmentAttempt.id).where(AssessmentAttempt.id == attempt.id).with_for_update())
    db.refresh(attempt)
    require_open(db, attempt, now)
    question = db.get(AttemptQuestion, attempt_question_id)
    if question is None or question.attempt_id != attempt.id:
        raise not_found()
    allowed = {o["option_id"] for o in question.options_snapshot}
    clean = list(dict.fromkeys(selected))
    if any(option not in allowed for option in clean):
        raise validation("That answer does not belong to this question.")
    if question.question_type_snapshot != "MCQ_MULTIPLE" and len(clean) > 1:
        raise validation("Select one answer for this question.")
    answer = _answer_for(db, question.id)
    if answer is None:
        answer = AttemptAnswer(attempt_question_id=question.id, selected_option_ids=clean, saved_at=now)
        db.add(answer)
    else:
        answer.selected_option_ids = clean
        answer.saved_at = now
    db.flush()
    return answer


def _answer_for(db: Session, attempt_question_id: uuid.UUID) -> AttemptAnswer | None:
    return db.scalar(select(AttemptAnswer).where(AttemptAnswer.attempt_question_id == attempt_question_id))


def set_review_mark(db: Session, attempt: AssessmentAttempt, attempt_question_id: uuid.UUID, marked: bool, now: datetime | None = None) -> None:
    now = now or utcnow()
    require_open(db, attempt, now)
    question = db.get(AttemptQuestion, attempt_question_id)
    if question is None or question.attempt_id != attempt.id:
        raise not_found()
    answer = _answer_for(db, question.id)
    if answer is None:
        db.add(AttemptAnswer(attempt_question_id=question.id, selected_option_ids=[], marked_for_review=marked, saved_at=now))
    else:
        answer.marked_for_review = marked
    db.flush()


def record_security_event(db: Session, attempt: AssessmentAttempt, event_type: str, now: datetime | None = None) -> dict:
    """The server decides what counts. Duplicate signals from one incident are merged (TC-SEC-003)."""
    now = now or utcnow()
    db.execute(select(AssessmentAttempt.id).where(AssessmentAttempt.id == attempt.id).with_for_update())
    db.refresh(attempt)
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
        # A lost connection is an interruption and never affects the violation count (TC-SEC-004).
        db.add(AttemptSecurityEvent(attempt_id=attempt.id, event_type=event, signals=[event.value], occurred_at=now))
        db.flush()
        return summary(False)

    last = db.scalar(
        select(AttemptSecurityEvent)
        .where(AttemptSecurityEvent.attempt_id == attempt.id, AttemptSecurityEvent.violation_number.is_not(None))
        .order_by(AttemptSecurityEvent.occurred_at.desc())
        .limit(1)
    )
    if last is not None and (now - last.occurred_at).total_seconds() < INCIDENT_MERGE_SECONDS:
        if event.value not in last.signals:
            last.signals = [*last.signals, event.value]
        db.flush()
        return summary(False)

    attempt.violation_count += 1
    db.add(AttemptSecurityEvent(attempt_id=attempt.id, event_type=event, signals=[event.value], violation_number=attempt.violation_count, occurred_at=now))
    db.flush()
    if attempt.violation_count >= limit:
        finalise_attempt(db, attempt.id, reason=SubmissionReason.VIOLATION_LIMIT, now=now)
        return summary(True, final=True)
    return summary(True)


# ---------- Scoring ----------

def is_pass(earned: Decimal, total: Decimal, pass_mark: Decimal) -> bool:
    """Exact comparison with no floating point or display rounding: 69.9 fails, 70 passes (BR §8.3)."""
    return Fraction(earned) * 100 >= Fraction(pass_mark) * Fraction(total)


def truncate_percent(earned: Decimal, total: Decimal) -> Decimal:
    exact = Fraction(earned) * 100 / Fraction(total)
    return (Decimal(exact.numerator) / Decimal(exact.denominator)).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)


def finalise_attempt(db: Session, attempt_id: uuid.UUID, reason: SubmissionReason | None = None, now: datetime | None = None) -> AssessmentAttempt:
    """The only route to a result. Row-locked and idempotent: a repeat returns the same result."""
    now = now or utcnow()
    attempt = db.scalar(select(AssessmentAttempt).where(AssessmentAttempt.id == attempt_id).with_for_update())
    if attempt is None:
        raise not_found()
    if attempt.status != AttemptStatus.IN_PROGRESS:
        return attempt

    expired = now >= attempt.expires_at
    questions = db.scalars(select(AttemptQuestion).options(selectinload(AttemptQuestion.answer)).where(AttemptQuestion.attempt_id == attempt.id)).all()
    earned, total = Decimal(0), Decimal(0)
    for question in questions:
        total += question.marks_snapshot
        answer = question.answer
        selected = set(answer.selected_option_ids) if answer else set()
        correct = selected == set(question.answer_key_snapshot) and bool(selected)  # Exact-set match (MVP default).
        awarded = question.marks_snapshot if correct else Decimal(0)
        earned += awarded
        if answer is not None:
            answer.is_correct = correct
            answer.marks_awarded = awarded
    if total <= 0:
        raise ApiError(422, "QUESTION_POOL_INSUFFICIENT", "This attempt has no valid marks. Contact L&D.")

    passed = is_pass(earned, total, Decimal(attempt.config_snapshot["pass_mark_percent"]))
    attempt.status = AttemptStatus.TIMED_OUT if expired else AttemptStatus.SUBMITTED
    attempt.submitted_at = min(now, attempt.expires_at) if expired else now
    attempt.submission_reason = SubmissionReason.TIME_EXPIRED if expired else (reason or SubmissionReason.MANUAL)
    attempt.obtained_marks = earned
    attempt.total_marks = total
    attempt.score_percent = truncate_percent(earned, total)
    attempt.result_status = ResultStatus.PASSED if passed else ResultStatus.NOT_PASSED
    db.flush()
    _apply_outcome(db, attempt, passed, now)
    return attempt


def _apply_outcome(db: Session, attempt: AssessmentAttempt, passed: bool, now: datetime) -> None:
    obligation = db.get(AssessmentObligation, attempt.obligation_id)
    db.refresh(obligation, ["attempts"])
    if attempt.assessment_type == AssessmentType.PRE_TEST:
        obligation.status = ObligationStatus.COMPLETED
        obligation.completed_at = now
        obligation.outcome = attempt.result_status
        return
    title = obligation.training.title
    score = f"{display_percent(attempt.score_percent)}% (pass mark {display_percent(Decimal(attempt.config_snapshot['pass_mark_percent']))}%)"
    if passed:
        obligation.status = ObligationStatus.COMPLETED
        obligation.completed_at = now
        obligation.outcome = ResultStatus.PASSED
        if obligation.retraining_flag == RetrainingFlag.NEEDS_RETRAINING:
            obligation.retraining_flag = RetrainingFlag.RESOLVED
        notify_employee(db, attempt.employee_id, "ASSESSMENT_PASSED", f"Passed: {title}", f"You scored {score}.", f"/results/{attempt.id}", f"passed:{obligation.id}", now)
        return
    max_attempts = int(attempt.config_snapshot["max_attempts"])
    if counted_attempts(obligation) >= max_attempts:
        obligation.status = ObligationStatus.COMPLETED
        obligation.completed_at = now
        obligation.outcome = ResultStatus.NOT_PASSED
        obligation.retraining_flag = RetrainingFlag.NEEDS_RETRAINING
        _notify_final_failure(db, attempt, obligation, now)
        record_audit(db, None, "NEEDS_RETRAINING_FLAGGED", "assessment_obligation", obligation.id, after={"attempts": counted_attempts(obligation)})
    else:
        calendar = load_calendar(db)
        next_day = calendar.next_working_day(calendar.local_date(now))
        obligation.status = ObligationStatus.RETAKE_PENDING
        obligation.outcome = ResultStatus.NOT_PASSED
        obligation.refresher_acknowledged_at = None
        obligation.retake_eligible_at = calendar.start_of_day(next_day)
        used = counted_attempts(obligation)
        notify_employee(
            db,
            attempt.employee_id,
            "ASSESSMENT_NOT_PASSED",
            f"Not passed: {title}",
            f"You scored {score}. You have used {used} of {max_attempts} attempts. Review and acknowledge the refresher material; "
            "your retake opens at your next sign-in after that, or from the next working day.",
            f"/results/{attempt.id}",
            f"not-passed:{attempt.id}",
            now,
        )


def _notify_final_failure(db: Session, attempt: AssessmentAttempt, obligation: AssessmentObligation, now: datetime) -> None:
    employee = obligation.employee
    title = f"Needs Re-training: {employee.full_name}"
    message = (
        f"{employee.full_name} ({employee.employee_code}) used all {counted_attempts(obligation)} attempts for "
        f"{obligation.training.title}. Open the team or learning records for scores and next steps."
    )
    key = f"final-failure:{obligation.id}"
    manager_id = current_manager_id(db, employee.id)
    if manager_id:
        notify_employee(db, manager_id, "FINAL_FAILURE", title, message, "/manager/team", key, now)
    notify_roles(db, ("LD_ADMIN", "HR_READ_ONLY"), "FINAL_FAILURE", title, message, None, key, now)
    notify_employee(db, employee.id, "FINAL_FAILURE", f"{obligation.training.title}: Needs Re-training", "You have used all attempts. L&D will arrange your next learning step. This is a learning follow-up, not a disciplinary record.", "/employee/assessments", key, now)


# ---------- Retakes and exceptions ----------

def acknowledge_refresher(db: Session, obligation: AssessmentObligation, now: datetime | None = None) -> None:
    now = now or utcnow()
    if not obligation.attempts or obligation.status not in (ObligationStatus.RETAKE_PENDING, ObligationStatus.DUE):
        raise conflict("REFRESHER_NOT_REQUIRED", "No refresher acknowledgement is needed right now.")
    if obligation.refresher_acknowledged_at is None:
        obligation.refresher_acknowledged_at = now
        db.add(RefresherAcknowledgement(obligation_id=obligation.id, employee_id=obligation.employee_id, attempts_at_time=counted_attempts(obligation), acknowledged_at=now))


def first_and_best(db: Session, obligation_ids: list[uuid.UUID]) -> dict:
    """First, best and latest post-test scores for one or more cycles, kept separate (BR §9.7)."""
    attempts = db.scalars(
        select(AssessmentAttempt)
        .where(AssessmentAttempt.obligation_id.in_(obligation_ids), AssessmentAttempt.result_status.is_not(None))
        .order_by(AssessmentAttempt.submitted_at)
    ).all()
    if not attempts:
        return {"first": None, "best": None, "latest": None, "count": 0}
    return {
        "first": attempts[0].score_percent,
        "best": max(a.score_percent for a in attempts),
        "latest": attempts[-1].score_percent,
        "count": len(attempts),
    }


def active_config(db: Session, training_id: uuid.UUID, assessment_type: AssessmentType) -> AssessmentConfig | None:
    return db.scalar(
        select(AssessmentConfig).where(
            AssessmentConfig.training_id == training_id,
            AssessmentConfig.assessment_type == assessment_type,
            AssessmentConfig.is_active,
        )
    )


def next_config_version(db: Session, training_id: uuid.UUID, assessment_type: AssessmentType) -> int:
    current = db.scalar(
        select(func.max(AssessmentConfig.version)).where(AssessmentConfig.training_id == training_id, AssessmentConfig.assessment_type == assessment_type)
    )
    return (current or 0) + 1
