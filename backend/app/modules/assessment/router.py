"""Employee assessment APIs. Everything here is on the gate-exempt allowlist except the pre-test routes.

Pre-tests and post-training assessments run in the same secure environment: system check, full screen
(when the configuration requires it), acknowledged instructions and browser-level monitoring with violations.
"""
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear, require_session
from app.core.enums import AssessmentType, AttemptStatus, ObligationStatus, ResultStatus, SecurityEventType
from app.core.errors import conflict, not_found
from app.core.responses import display_percent, iso, num, ok
from app.models import AssessmentAttempt, AssessmentObligation, AttemptQuestion, Enrolment
from app.modules.assessment import service
from app.modules.assessment.gate import access_state, blocking_obligations, queue_item

router = APIRouter(tags=["Assessment"])


class StartAttemptIn(BaseModel):
    instructions_acknowledged: bool = False


class SaveAnswerIn(BaseModel):
    selected_option_ids: list[str] = Field(default_factory=list, max_length=20)


class MarkIn(BaseModel):
    marked: bool


class SecurityEventIn(BaseModel):
    event_type: SecurityEventType


# ---------- Safe serialisers. These are the only shapes an employee sees before submission. ----------

def attempt_question_view(question: AttemptQuestion) -> dict:
    answer = question.answer
    return {
        "attempt_question_id": str(question.id),
        "position": question.display_order,
        "question_text": question.question_text_snapshot,
        "question_type": question.question_type_snapshot,
        "topic": question.topic_snapshot,
        "language": question.language_snapshot,
        "marks": num(question.marks_snapshot),
        "options": question.options_snapshot,
        "selected_option_ids": answer.selected_option_ids if answer else [],
        "marked_for_review": answer.marked_for_review if answer else False,
        "saved_at": iso(answer.saved_at) if answer else None,
    }


def attempt_view(db: Session, attempt: AssessmentAttempt) -> dict:
    questions = db.scalars(
        select(AttemptQuestion).options(selectinload(AttemptQuestion.answer)).where(AttemptQuestion.attempt_id == attempt.id).order_by(AttemptQuestion.display_order)
    ).all()
    snapshot = attempt.config_snapshot
    now = utcnow()
    return {
        "attempt_id": str(attempt.id),
        "obligation_id": str(attempt.obligation_id),
        "assessment_type": attempt.assessment_type,
        "training_title": attempt.training.title,
        "attempt_number": attempt.attempt_number,
        "max_attempts": snapshot["max_attempts"],
        "status": attempt.status,
        "started_at": iso(attempt.started_at),
        "expires_at": iso(attempt.expires_at),
        "server_now": iso(now),
        "remaining_seconds": max(0, int((attempt.expires_at - now).total_seconds())),
        "violation_count": attempt.violation_count,
        "violation_limit": snapshot["violation_limit"],
        "require_fullscreen": bool(snapshot["require_fullscreen"]),
        "monitored": True,  # Pre-tests are monitored like post-training assessments.
        "questions": [attempt_question_view(q) for q in questions],
    }


def result_view(db: Session, attempt: AssessmentAttempt) -> dict:
    """Own result, available only after finalisation."""
    questions = db.scalars(
        select(AttemptQuestion).options(selectinload(AttemptQuestion.answer)).where(AttemptQuestion.attempt_id == attempt.id).order_by(AttemptQuestion.display_order)
    ).all()
    snapshot = attempt.config_snapshot
    obligation = attempt.obligation
    scores = service.first_and_best(db, [obligation.id])

    topics: dict[str, list[float]] = {}
    answered = correct = 0
    review = []
    for q in questions:
        selected = q.answer.selected_option_ids if q.answer else []
        is_right = bool(q.answer and q.answer.is_correct)
        answered += 1 if selected else 0
        correct += 1 if is_right else 0
        bucket = topics.setdefault(q.topic_snapshot, [0.0, 0.0])
        bucket[0] += float(q.answer.marks_awarded or 0) if q.answer else 0.0
        bucket[1] += float(q.marks_snapshot)
        if snapshot["show_explanations"]:
            text_of = {o["option_id"]: o["text"] for o in q.options_snapshot}
            review.append(
                {
                    "position": q.display_order,
                    "question_text": q.question_text_snapshot,
                    "your_answer": [text_of[s] for s in selected if s in text_of],
                    "correct_answer": [text_of[s] for s in q.answer_key_snapshot if s in text_of],
                    "is_correct": is_right,
                    "explanation": q.explanation_snapshot,
                }
            )

    attempts_used = service.counted_attempts(obligation)
    training = attempt.training
    return {
        "attempt_id": str(attempt.id),
        "obligation_id": str(obligation.id),
        "assessment_type": attempt.assessment_type,
        "training_title": training.title,
        "attempt_status": attempt.status,
        "attempt_number": attempt.attempt_number,
        "max_attempts": snapshot["max_attempts"],
        "attempts_remaining": max(0, int(snapshot["max_attempts"]) - attempts_used) if obligation.status == ObligationStatus.RETAKE_PENDING else 0,
        "score_percent": display_percent(attempt.score_percent),
        "result_status": attempt.result_status,
        "pass_mark_percent": float(snapshot["pass_mark_percent"]),
        "obtained_marks": num(attempt.obtained_marks),
        "total_marks": num(attempt.total_marks),
        "submitted_at": iso(attempt.submitted_at),
        "submission_reason": attempt.submission_reason,
        "time_taken_seconds": int((attempt.submitted_at - attempt.started_at).total_seconds()),
        "question_count": len(questions),
        "answered_count": answered,
        "correct_count": correct,
        "first_score": display_percent(scores["first"]),
        "best_score": display_percent(scores["best"]),
        "latest_score": display_percent(scores["latest"]),
        "topics": [{"name": name, "score": round(v[0] / v[1] * 100, 1) if v[1] else None} for name, v in topics.items()],
        "explanations_enabled": snapshot["show_explanations"],
        "answer_review": review,
        "needs_retraining": obligation.retraining_flag == "NEEDS_RETRAINING",
        "retake_pending": obligation.status == ObligationStatus.RETAKE_PENDING,
        "refresher": {
            "text": training.refresher_text,
            "url": training.refresher_url,
            "acknowledged": obligation.refresher_acknowledged_at is not None,
        }
        if attempt.result_status == ResultStatus.NOT_PASSED
        else None,
        "violations": [
            {"number": e.violation_number, "type": e.event_type, "signals": e.signals, "occurred_at": iso(e.occurred_at)}
            for e in attempt.security_events
            if e.violation_number is not None
        ],
        "interruptions": sum(1 for e in attempt.security_events if e.violation_number is None),
    }


# ---------- Gate-exempt: access state ----------

@router.get("/me/access-state")
def get_access_state(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    return ok(access_state(db, user.employee_id))


@router.get("/me/assessment-queue")
def get_queue(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    queue = blocking_obligations(db, user.employee_id)
    db.commit()
    return ok([queue_item(o, i + 1) for i, o in enumerate(queue)])


@router.get("/system/ping")
def ping() -> dict:
    """Used by the assessment system check. Returns the server clock and nothing else."""
    return ok({"ok": True, "server_now": iso(utcnow())})


# ---------- Gate-exempt: taking the assessment ----------

@router.get("/me/assessment-obligations/{obligation_id}")
def get_obligation(obligation_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    obligation = service.get_own_obligation(db, obligation_id, user.employee_id)
    active = next((a for a in obligation.attempts if a.status == AttemptStatus.IN_PROGRESS), None)
    item = queue_item(obligation, 1)
    item["status"] = obligation.status
    item["active_attempt_id"] = str(active.id) if active else None
    item["violation_limit"] = obligation.config.violation_limit
    item["require_fullscreen"] = obligation.config.require_fullscreen
    item["refresher"] = {"text": obligation.training.refresher_text, "url": obligation.training.refresher_url}
    item["total_marks_hint"] = None
    return ok(item)


@router.post("/assessment-obligations/{obligation_id}/attempts")
def start_attempt(obligation_id: uuid.UUID, body: StartAttemptIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    obligation = service.get_own_obligation(db, obligation_id, user.employee_id)
    if obligation.assessment_type != AssessmentType.POST_TEST:
        raise not_found()
    attempt = service.start_attempt(db, obligation, body.instructions_acknowledged)
    db.commit()
    return ok(attempt_view(db, attempt))


def _own_enrolment(db: Session, enrolment_id: uuid.UUID, employee_id: uuid.UUID) -> Enrolment:
    enrolment = db.get(Enrolment, enrolment_id)
    if enrolment is None or enrolment.employee_id != employee_id:
        raise not_found()
    return enrolment


@router.get("/me/pre-tests/{enrolment_id}")
def get_pre_test(enrolment_id: uuid.UUID, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """The pre-test's rules, shown before it starts (system check, full screen, instructions), and any attempt
    already running so a refresh or second tab resumes it."""
    enrolment = _own_enrolment(db, enrolment_id, user.employee_id)
    training = enrolment.training
    config = service.active_config(db, enrolment.training_id, AssessmentType.PRE_TEST)
    obligation = db.scalar(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == AssessmentType.PRE_TEST))
    active = next((a for a in obligation.attempts if a.status == AttemptStatus.IN_PROGRESS), None) if obligation else None
    taken = obligation is not None and obligation.status == ObligationStatus.COMPLETED
    available = bool(training.pretest_enabled and config is not None and not taken and (enrolment.completion is None or active is not None))
    return ok(
        {
            "enrolment_id": str(enrolment.id),
            "training_title": training.title,
            "training_description": training.description,
            "available": available,
            "question_count": config.question_count if config else None,
            "duration_seconds": config.duration_seconds if config else None,
            "violation_limit": config.violation_limit if config else None,
            "require_fullscreen": config.require_fullscreen if config else True,
            "active_attempt_id": str(active.id) if active else None,
        }
    )


@router.post("/me/pre-tests/{enrolment_id}/attempts")
def start_pre_test(enrolment_id: uuid.UUID, body: StartAttemptIn, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    enrolment = _own_enrolment(db, enrolment_id, user.employee_id)
    if enrolment.completion is not None or not enrolment.training.pretest_enabled:
        raise conflict("PRE_TEST_UNAVAILABLE", "The pre-test can only be taken before training completion, when it is enabled.")
    config = service.active_config(db, enrolment.training_id, AssessmentType.PRE_TEST)
    if config is None:
        raise conflict("PRE_TEST_UNAVAILABLE", "This training has no pre-test configured.")
    obligation = db.scalar(select(AssessmentObligation).where(AssessmentObligation.enrolment_id == enrolment.id, AssessmentObligation.assessment_type == AssessmentType.PRE_TEST))
    if obligation is None:
        obligation = AssessmentObligation(
            enrolment_id=enrolment.id,
            employee_id=enrolment.employee_id,
            training_id=enrolment.training_id,
            config_id=config.id,
            assessment_type=AssessmentType.PRE_TEST,
            status=ObligationStatus.DUE,
            due_at=utcnow(),
        )
        db.add(obligation)
        db.flush()
    elif obligation.status == ObligationStatus.COMPLETED:
        raise conflict("PRE_TEST_UNAVAILABLE", "You have already taken this pre-test.")
    attempt = service.start_attempt(db, obligation, body.instructions_acknowledged)
    db.commit()
    return ok(attempt_view(db, attempt))


@router.get("/attempts/{attempt_id}")
def get_attempt(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    if attempt.status == AttemptStatus.IN_PROGRESS and attempt.expires_at <= utcnow():
        service.finalise_attempt(db, attempt.id)
        db.commit()
    return ok(attempt_view(db, attempt))


@router.put("/attempts/{attempt_id}/questions/{attempt_question_id}/answer")
def save_answer(attempt_id: uuid.UUID, attempt_question_id: uuid.UUID, body: SaveAnswerIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    answer = service.save_answer(db, attempt, attempt_question_id, body.selected_option_ids)
    db.commit()
    return ok({"saved_at": iso(answer.saved_at), "selected_option_ids": answer.selected_option_ids})


@router.post("/attempts/{attempt_id}/questions/{attempt_question_id}/mark")
def mark_question(attempt_id: uuid.UUID, attempt_question_id: uuid.UUID, body: MarkIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    service.set_review_mark(db, attempt, attempt_question_id, body.marked)
    db.commit()
    return ok({"marked": body.marked})


@router.post("/attempts/{attempt_id}/security-events")
def security_event(attempt_id: uuid.UUID, body: SecurityEventIn, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    result = service.record_security_event(db, attempt, body.event_type)
    db.commit()
    return ok(result)


@router.post("/attempts/{attempt_id}/submit")
def submit(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    """Takes no score, marks or time from the client. A repeat returns the stored result."""
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    attempt = service.finalise_attempt(db, attempt.id)
    db.commit()
    return ok({**result_view(db, attempt), "access_state": access_state(db, user.employee_id)})


@router.get("/attempts/{attempt_id}/result")
def result(attempt_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    attempt = service.get_own_attempt(db, attempt_id, user.employee_id)
    if attempt.status == AttemptStatus.IN_PROGRESS and attempt.expires_at <= utcnow():
        attempt = service.finalise_attempt(db, attempt.id)
        db.commit()
    if attempt.result_status is None:
        raise conflict("RESULT_NOT_READY", "This attempt has not been submitted yet.")
    return ok(result_view(db, attempt))


@router.post("/assessment-obligations/{obligation_id}/refresher-acknowledgement")
def refresher_acknowledgement(obligation_id: uuid.UUID, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    obligation = service.get_own_obligation(db, obligation_id, user.employee_id)
    service.acknowledge_refresher(db, obligation)
    record_audit(db, user.id, "REFRESHER_ACKNOWLEDGED", "assessment_obligation", obligation.id)
    db.commit()
    return ok({"acknowledged": True, "note": "This records that you reviewed the guidance. It is not proof of learning."})
