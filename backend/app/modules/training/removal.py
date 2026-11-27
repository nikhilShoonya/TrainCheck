"""Removing employees who were assigned to a training by mistake, even after their completion was recorded.

Deleted, in one transaction, for the chosen assignments only (children before parents): their assessments (every
training cycle), attempts with question snapshots, answers and security events, refresher acknowledgements and
feedback; their behaviour follow-ups; their completions; the assignments themselves; and the notifications about
any of these records.

Never deleted: the employees, their accounts and every other assignment; the training and its configuration,
batches, materials and questions; completion imports; reports. Each removed assignment leaves a
TRAINING_ASSIGNMENT_REMOVED audit record with who it was, what it held and the reason.

Concurrency: the training row is locked FOR UPDATE first (deletion.lock_for_deletion), the lock every writer of the
training waits on, so nothing is added to these assignments while they are removed. An attempt in progress stops the
whole removal: nothing is removed.
"""
import uuid

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.enums import AttemptStatus
from app.core.errors import conflict, not_found
from app.models import (
    AssessmentAttempt,
    AssessmentFeedback,
    AssessmentObligation,
    AttemptAnswer,
    AttemptQuestion,
    AttemptSecurityEvent,
    BehaviourReview,
    BehaviourReviewCycle,
    BehaviourReviewResponse,
    Employee,
    Enrolment,
    RefresherAcknowledgement,
    Training,
    TrainingCompletion,
)
from app.modules.training import deletion

AUDIT_ACTION = "TRAINING_ASSIGNMENT_REMOVED"


def remove_assignments(db: Session, training: Training, enrolment_ids: list[uuid.UUID], actor_user_id: uuid.UUID, reason: str) -> dict:
    """Removes the given assignments of the locked training. The caller commits; on any error it rolls back and
    nothing is removed. Every ID must be an assignment of this training (else 404, nothing removed)."""
    ids = sorted(set(enrolment_ids))
    found = db.execute(
        select(Enrolment.id, Enrolment.enrolment_status, Enrolment.training_cycle, Employee.id, Employee.employee_code, Employee.full_name)
        .join(Employee, Employee.id == Enrolment.employee_id)
        .where(Enrolment.training_id == training.id, Enrolment.id.in_(ids))
    ).all()
    if len(found) != len(ids):
        raise not_found("One or more of these employees are no longer assigned to this training. Reload the list; nothing was removed.")

    obligations = select(AssessmentObligation.id).where(AssessmentObligation.enrolment_id.in_(ids))
    attempts = select(AssessmentAttempt.id).where(AssessmentAttempt.obligation_id.in_(obligations))
    attempt_questions = select(AttemptQuestion.id).where(AttemptQuestion.attempt_id.in_(attempts))
    cycles = select(BehaviourReviewCycle.id).where(BehaviourReviewCycle.enrolment_id.in_(ids))
    reviews = select(BehaviourReview.id).where(BehaviourReview.cycle_id.in_(cycles))
    feedback = select(AssessmentFeedback.id).where((AssessmentFeedback.obligation_id.in_(obligations)) | (AssessmentFeedback.attempt_id.in_(attempts)))

    running = db.scalar(select(func.count()).where(AssessmentAttempt.id.in_(attempts), AssessmentAttempt.status == AttemptStatus.IN_PROGRESS)) or 0
    if running:
        raise conflict("ATTEMPT_IN_PROGRESS", f"{running} of these employees {'is' if running == 1 else 'are'} taking this training's test right now. Nothing was removed. Try again when the test is finished.")

    # Per assignment, for the audit records: what it held when it was removed.
    def per_enrolment(query) -> dict[uuid.UUID, int]:
        return dict(db.execute(query).all())

    completions = per_enrolment(select(TrainingCompletion.enrolment_id, func.count()).where(TrainingCompletion.enrolment_id.in_(ids)).group_by(TrainingCompletion.enrolment_id))
    attempt_counts = per_enrolment(
        select(AssessmentObligation.enrolment_id, func.count(AssessmentAttempt.id))
        .join(AssessmentAttempt, AssessmentAttempt.obligation_id == AssessmentObligation.id)
        .where(AssessmentObligation.enrolment_id.in_(ids))
        .group_by(AssessmentObligation.enrolment_id)
    )
    feedback_counts = per_enrolment(
        select(AssessmentObligation.enrolment_id, func.count(AssessmentFeedback.id))
        .join(AssessmentFeedback, AssessmentFeedback.obligation_id == AssessmentObligation.id)
        .where(AssessmentObligation.enrolment_id.in_(ids))
        .group_by(AssessmentObligation.enrolment_id)
    )
    related = sorted({str(i) for query in (select(Enrolment.id).where(Enrolment.id.in_(ids)), obligations, attempts, cycles, reviews) for i in db.scalars(query)})

    def run(statement) -> int:
        return db.execute(statement.execution_options(synchronize_session=False)).rowcount or 0

    run(delete(AttemptAnswer).where(AttemptAnswer.attempt_question_id.in_(attempt_questions)))
    run(delete(AttemptSecurityEvent).where(AttemptSecurityEvent.attempt_id.in_(attempts)))
    run(delete(AssessmentFeedback).where(AssessmentFeedback.id.in_(feedback)))
    run(delete(AttemptQuestion).where(AttemptQuestion.attempt_id.in_(attempts)))
    run(delete(RefresherAcknowledgement).where(RefresherAcknowledgement.obligation_id.in_(obligations)))
    removed_attempts = run(delete(AssessmentAttempt).where(AssessmentAttempt.id.in_(attempts)))
    removed_assessments = run(delete(AssessmentObligation).where(AssessmentObligation.enrolment_id.in_(ids)))
    run(delete(BehaviourReviewResponse).where(BehaviourReviewResponse.review_id.in_(reviews)))
    run(delete(BehaviourReview).where(BehaviourReview.id.in_(reviews)))
    run(delete(BehaviourReviewCycle).where(BehaviourReviewCycle.enrolment_id.in_(ids)))
    removed_completions = run(delete(TrainingCompletion).where(TrainingCompletion.enrolment_id.in_(ids)))
    removed = run(delete(Enrolment).where(Enrolment.id.in_(ids)))
    notification_ids = deletion._notification_ids(db, related)
    if notification_ids:
        db.execute(text("DELETE FROM notifications WHERE id = ANY(:ids)"), {"ids": notification_ids})

    for enrolment_id, status, cycle, employee_id, code, name in found:
        record_audit(
            db,
            actor_user_id,
            AUDIT_ACTION,
            "enrolment",
            enrolment_id,
            before={
                "training_id": str(training.id),
                "training_code": training.training_code,
                "employee_id": str(employee_id),
                "employee_code": code,
                "employee_name": name,
                "status": status,
                "training_cycle": cycle,
                "completions": completions.get(enrolment_id, 0),
                "attempts": attempt_counts.get(enrolment_id, 0),
                "feedback": feedback_counts.get(enrolment_id, 0),
            },
            reason=reason,
        )
    db.flush()
    return {
        "removed": removed,
        "completions": removed_completions,
        "assessments": removed_assessments,
        "attempts": removed_attempts,
        "notifications": len(notification_ids),
    }
