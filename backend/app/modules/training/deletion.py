"""Permanent deletion of a training and of every record that belongs only to it.

Deleted, in one transaction (children before parents, so every foreign key is satisfied):
assignments (enrolments) and their completions, batches and sessions, assessment configurations, assessments
(obligations of every training cycle), attempts with their question snapshots, answers and security events,
refresher acknowledgements, feedback, behaviour follow-ups and the training's own behaviour questionnaires,
materials, department/function/competency links, question links, question-import records made for this training,
report exports and schedules filtered to this training (or one of its batches) with their files, and the
notifications about any of these records.

Never deleted: employees, user accounts and roles; departments, functions, locations, competencies, trainers and
other master data; other trainings and their records; every Question Bank question with its options, answer keys,
revisions and status (only this training's links to them go: a question with no link left is listed under
Unassigned Questions); completion imports (a file may cover several trainings); reports and schedules not filtered
to this training; audit history.

Concurrency: the training row is locked FOR UPDATE before anything is read; writers take FOR KEY SHARE on the same row
first (training.locks), so no writer can add a record to the training while it is being deleted, and none is left
half-written. Stored files are removed only after the commit; a file that cannot be removed then is listed in the
TRAINING_DELETED audit record and removed by the scheduler later (remove_leftover_files).
"""
import logging
import re
import uuid
from datetime import timedelta

from sqlalchemy import String, cast, delete, func, or_, select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.enums import ImportType
from app.core.errors import ApiError, conflict
from app.models import (
    AssessmentAttempt,
    AssessmentConfig,
    AssessmentFeedback,
    AssessmentObligation,
    AttemptAnswer,
    AttemptQuestion,
    AttemptSecurityEvent,
    AuditLog,
    BehaviourReview,
    BehaviourReviewCycle,
    BehaviourReviewResponse,
    BehaviourTemplate,
    BehaviourTemplateQuestion,
    Enrolment,
    FileArtifact,
    ImportJob,
    QuestionTrainingTag,
    RefresherAcknowledgement,
    ReportDelivery,
    ReportExport,
    ReportSchedule,
    Training,
    TrainingBatch,
    TrainingCompetency,
    TrainingCompletion,
    TrainingDepartment,
    TrainingFunction,
    TrainingMaterial,
    TrainingSession,
)

logger = logging.getLogger("traincheck.training_deletion")

AUDIT_ACTION = "TRAINING_DELETED"
STORAGE_KEY = re.compile(r"[0-9a-f]{32}")  # exports.store_file names every file uuid4().hex.
LOCK_TIMEOUT = text("SET LOCAL lock_timeout = '15s'")  # How long a deletion waits for requests still writing.
BUSY_SQLSTATES = {"55P03", "40P01", "40001"}  # lock_not_available, deadlock_detected, serialization_failure.
LEFTOVER_FILE_DAYS = 30


class _Scope:
    """The records of one training, as subqueries. Evaluated in the deleting transaction, children first, so the
    parents a subquery reads still exist when it runs."""

    def __init__(self, training_id: uuid.UUID) -> None:
        t = training_id
        self.training_id = t
        self.enrolments = select(Enrolment.id).where(Enrolment.training_id == t)
        self.obligations = select(AssessmentObligation.id).where(or_(AssessmentObligation.training_id == t, AssessmentObligation.enrolment_id.in_(self.enrolments)))
        self.attempts = select(AssessmentAttempt.id).where(or_(AssessmentAttempt.training_id == t, AssessmentAttempt.obligation_id.in_(self.obligations)))
        self.attempt_questions = select(AttemptQuestion.id).where(AttemptQuestion.attempt_id.in_(self.attempts))
        self.batches = select(TrainingBatch.id).where(TrainingBatch.training_id == t)
        self.cycles = select(BehaviourReviewCycle.id).where(or_(BehaviourReviewCycle.training_id == t, BehaviourReviewCycle.enrolment_id.in_(self.enrolments)))
        self.reviews = select(BehaviourReview.id).where(BehaviourReview.cycle_id.in_(self.cycles))
        self.templates = select(BehaviourTemplate.id).where(BehaviourTemplate.training_id == t)
        batch_text = select(cast(TrainingBatch.id, String)).where(TrainingBatch.training_id == t)
        # Exports and schedules filtered to this training, or to one of its batches, report on nothing else.
        self.exports = select(ReportExport.id).where(or_(ReportExport.filters["training_id"].as_string() == str(t), ReportExport.filters["batch_id"].as_string().in_(batch_text)))
        self.schedules = select(ReportSchedule.id).where(or_(ReportSchedule.filters["training_id"].as_string() == str(t), ReportSchedule.filters["batch_id"].as_string().in_(batch_text)))
        # Completion imports may name several trainings, so only question imports made for this training go.
        self.question_imports = select(ImportJob.id).where(ImportJob.training_id == t, ImportJob.import_type == ImportType.QUESTIONS)
        self.feedback = select(AssessmentFeedback.id).where(
            or_(AssessmentFeedback.training_id == t, AssessmentFeedback.obligation_id.in_(self.obligations), AssessmentFeedback.attempt_id.in_(self.attempts))
        )

    def related_ids(self, db: Session) -> list[str]:
        """Every ID a notification about this training can mention in its link or dedupe key."""
        ids = {self.training_id}
        for query in (self.enrolments, self.obligations, self.attempts, self.batches, self.cycles, self.reviews, self.exports, self.schedules):
            ids.update(db.scalars(query))
        return sorted(str(i) for i in ids)


def _count(db: Session, query) -> int:
    return db.scalar(select(func.count()).select_from(query.subquery())) or 0


# Notifications have no foreign key: they name their record in the link (/results/<attempt>, /lnd/completion/<training>)
# or the dedupe key (passed:<obligation>, retraining:<enrolment>:<cycle>, schedule:<schedule>:<time>, ...).
_NOTIFICATIONS = text(
    """
    SELECT DISTINCT n.id FROM notifications n
    CROSS JOIN LATERAL regexp_matches(
        lower(coalesce(n.link, '') || ' ' || coalesce(n.dedupe_key, '')),
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g'
    ) AS m(found)
    WHERE m.found[1] = ANY(CAST(:ids AS text[]))
    """
)


def _notification_ids(db: Session, related: list[str]) -> list[uuid.UUID]:
    return list(db.scalars(_NOTIFICATIONS, {"ids": related}))


def _questions_left_unassigned(training_id: uuid.UUID):
    """Questions linked to this training and to no other one: they become Unassigned Questions."""
    other = select(QuestionTrainingTag.question_id).where(QuestionTrainingTag.training_id != training_id)
    return select(QuestionTrainingTag.question_id).where(QuestionTrainingTag.training_id == training_id, QuestionTrainingTag.question_id.not_in(other))


def counts(db: Session, training_id: uuid.UUID) -> dict[str, int]:
    """What deleting the training removes (and how many questions become unassigned). Read-only."""
    s = _Scope(training_id)
    t = training_id
    return {
        "assignments": _count(db, s.enrolments),
        "completions": _count(db, select(TrainingCompletion.id).where(TrainingCompletion.enrolment_id.in_(s.enrolments))),
        "assessments": _count(db, s.obligations),
        "attempts": _count(db, s.attempts),
        "submitted_attempts": _count(db, select(AssessmentAttempt.id).where(AssessmentAttempt.id.in_(s.attempts), AssessmentAttempt.result_status.is_not(None))),
        "attempt_answers": _count(db, select(AttemptAnswer.id).where(AttemptAnswer.attempt_question_id.in_(s.attempt_questions))),
        "violations": _count(db, select(AttemptSecurityEvent.id).where(AttemptSecurityEvent.attempt_id.in_(s.attempts))),
        "feedback": _count(db, s.feedback),
        "assessment_configs": _count(db, select(AssessmentConfig.id).where(AssessmentConfig.training_id == t)),
        "batches": _count(db, s.batches),
        "sessions": _count(db, select(TrainingSession.id).where(TrainingSession.batch_id.in_(s.batches))),
        "materials": _count(db, select(TrainingMaterial.id).where(TrainingMaterial.training_id == t)),
        "behaviour_reviews": _count(db, s.reviews),
        "behaviour_questionnaires": _count(db, s.templates),
        "question_links": _count(db, select(QuestionTrainingTag.question_id).where(QuestionTrainingTag.training_id == t)),
        "questions_becoming_unassigned": _count(db, _questions_left_unassigned(t)),
        "question_imports": _count(db, s.question_imports),
        "report_exports": _count(db, s.exports),
        "report_schedules": _count(db, s.schedules),
        "notifications": len(_notification_ids(db, s.related_ids(db))),
    }


def lock_for_deletion(db: Session, training_id: uuid.UUID) -> Training | None:
    """FOR UPDATE on the training row. Waits at most 15 seconds for writers still holding the training (or, later,
    any of its rows); after that the deletion stops with TRAINING_BUSY and nothing is deleted."""
    db.execute(LOCK_TIMEOUT)
    return db.scalar(select(Training).where(Training.id == training_id).with_for_update().execution_options(populate_existing=True))


def busy_error() -> ApiError:
    return conflict("TRAINING_BUSY", "This training is being changed by requests that are still running (for example an employee submitting an assessment). Nothing was deleted. Try again in a moment.")


def is_busy(exc: OperationalError) -> bool:
    return getattr(exc.orig, "sqlstate", None) in BUSY_SQLSTATES


def delete_training(db: Session, training: Training, actor_user_id: uuid.UUID) -> tuple[dict[str, int], list[str]]:
    """Deletes the locked training and its records. Returns the counts and the stored files to remove after commit.
    The caller commits; on any error it rolls back and nothing is deleted."""
    t = training.id
    found = counts(db, t)
    s = _Scope(t)
    snapshot = {"code": training.training_code, "title": training.title, "status": training.status, "category": training.category}
    related = s.related_ids(db)  # Read before the records they name are deleted.

    def run(statement) -> int:
        return db.execute(statement.execution_options(synchronize_session=False)).rowcount or 0

    # Attempts: answers, security events and feedback, then the attempt's own question snapshots. The Question Bank
    # questions those snapshots were taken from are not touched.
    run(delete(AttemptAnswer).where(AttemptAnswer.attempt_question_id.in_(s.attempt_questions)))
    run(delete(AttemptSecurityEvent).where(AttemptSecurityEvent.attempt_id.in_(s.attempts)))
    run(delete(AssessmentFeedback).where(AssessmentFeedback.id.in_(s.feedback)))
    run(delete(AttemptQuestion).where(AttemptQuestion.attempt_id.in_(s.attempts)))
    run(delete(RefresherAcknowledgement).where(RefresherAcknowledgement.obligation_id.in_(s.obligations)))
    run(delete(AssessmentAttempt).where(AssessmentAttempt.id.in_(s.attempts)))
    run(delete(AssessmentObligation).where(AssessmentObligation.id.in_(s.obligations)))
    run(delete(AssessmentConfig).where(AssessmentConfig.training_id == t))

    # Behaviour follow-ups, then this training's own questionnaires (only its own cycles can use them).
    run(delete(BehaviourReviewResponse).where(BehaviourReviewResponse.review_id.in_(s.reviews)))
    run(delete(BehaviourReview).where(BehaviourReview.id.in_(s.reviews)))
    run(delete(BehaviourReviewCycle).where(BehaviourReviewCycle.id.in_(s.cycles)))
    still_used = select(BehaviourReviewCycle.template_id)
    # Defensive: a questionnaire that another training's follow-up somehow uses is kept, retired and detached.
    run(update(BehaviourTemplate).where(BehaviourTemplate.id.in_(s.templates), BehaviourTemplate.id.in_(still_used)).values(training_id=None, is_active=False))
    run(delete(BehaviourTemplateQuestion).where(BehaviourTemplateQuestion.template_id.in_(s.templates)))
    run(delete(BehaviourTemplate).where(BehaviourTemplate.id.in_(s.templates)))

    # Assignments.
    run(delete(TrainingCompletion).where(TrainingCompletion.enrolment_id.in_(s.enrolments)))
    run(delete(Enrolment).where(Enrolment.id.in_(s.enrolments)))
    run(delete(TrainingSession).where(TrainingSession.batch_id.in_(s.batches)))

    # Reports filtered to this training or its batches, with their deliveries. A delivery of a schedule that is kept
    # keeps its history row without the export.
    export_ids = list(db.scalars(s.exports))
    artifacts = list(db.execute(select(FileArtifact.id, FileArtifact.storage_key).join(ReportExport, ReportExport.artifact_id == FileArtifact.id).where(ReportExport.id.in_(export_ids))).all()) if export_ids else []
    if export_ids:
        run(update(ReportDelivery).where(ReportDelivery.export_id.in_(export_ids), ReportDelivery.schedule_id.not_in(s.schedules)).values(export_id=None))
    run(delete(ReportDelivery).where(ReportDelivery.schedule_id.in_(s.schedules)))
    run(delete(ReportSchedule).where(ReportSchedule.id.in_(s.schedules)))
    if export_ids:
        run(delete(ReportExport).where(ReportExport.id.in_(export_ids)))
    file_keys: list[str] = []
    for artifact_id, key in artifacts:
        if db.scalar(select(ReportExport.id).where(ReportExport.artifact_id == artifact_id).limit(1)) is None:  # Not shared.
            run(delete(FileArtifact).where(FileArtifact.id == artifact_id))
            file_keys.append(key)

    run(delete(TrainingBatch).where(TrainingBatch.training_id == t))
    run(delete(TrainingMaterial).where(TrainingMaterial.training_id == t))
    run(delete(TrainingDepartment).where(TrainingDepartment.training_id == t))
    run(delete(TrainingFunction).where(TrainingFunction.training_id == t))
    run(delete(TrainingCompetency).where(TrainingCompetency.training_id == t))
    # Links only: every question stays in the Question Bank with its content, answer key and revisions.
    run(delete(QuestionTrainingTag).where(QuestionTrainingTag.training_id == t))
    run(delete(ImportJob).where(ImportJob.id.in_(s.question_imports)))  # Its rows go with it (ON DELETE CASCADE).

    notification_ids = _notification_ids(db, related)
    if notification_ids:
        db.execute(text("DELETE FROM notifications WHERE id = ANY(:ids)"), {"ids": notification_ids})
    run(delete(Training).where(Training.id == t))

    after = {"counts": found}
    if file_keys:
        after["file_keys"] = file_keys  # Removed after commit; listed here so a failed removal can be retried.
    record_audit(db, actor_user_id, AUDIT_ACTION, "training", t, before=snapshot, after=after)
    db.flush()
    return found, file_keys


def remove_files(keys: list[str]) -> list[str]:
    """Removes stored files after the deletion committed. Returns the keys that could not be removed (yet)."""
    root = get_settings().storage_path
    failed = []
    for key in keys:
        if not STORAGE_KEY.fullmatch(key):
            continue
        try:
            (root / key).unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove stored file %s of a deleted training; the scheduler will retry", key)
            failed.append(key)
    return failed


def remove_leftover_files(db: Session) -> int:
    """Scheduler job: removes files listed by recent training deletions that are still on disk (a removal failed,
    or the process stopped between commit and removal). Only listed keys with no file record are touched."""
    since = utcnow() - timedelta(days=LEFTOVER_FILE_DAYS)
    keys: set[str] = set()
    for after in db.scalars(select(AuditLog.after_summary).where(AuditLog.action == AUDIT_ACTION, AuditLog.created_at >= since)):
        keys.update(k for k in (after or {}).get("file_keys", []) if isinstance(k, str) and STORAGE_KEY.fullmatch(k))
    if not keys:
        return 0
    in_use = set(db.scalars(select(FileArtifact.storage_key).where(FileArtifact.storage_key.in_(keys))))
    root = get_settings().storage_path
    leftover = [k for k in keys - in_use if (root / k).exists()]
    db.rollback()
    return len(leftover) - len(remove_files(leftover))
