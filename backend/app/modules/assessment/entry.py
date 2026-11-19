"""Whether, and how, an employee can enter a post-training assessment from My Trainings (BR §4.1, §5, §6.3).

This describes eligibility for display only. Starting is still decided by service.start_attempt, and the gate
still closes the workspace on the server; nothing here can open an assessment early.

entry_state:
  OPEN          due now and can start; the gate takes the employee through the usual confirmations
  IN_PROGRESS   an attempt is running; resuming keeps its server deadline
  NOT_YET_OPEN  scheduled for later; the employee may wait on a countdown, which creates nothing
  UNAVAILABLE   no action; entry_reason and entry_message say why
"""
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.enums import AssessmentType, ObligationStatus, ResultStatus, TrainingStatus
from app.models import AssessmentObligation

MESSAGES = {
    "AWAITING_COMPLETION": "Awaiting training completion. Your assessment is created when L&D records that you completed the training.",
    "AWAITING_SCHEDULING": "Your training completion is recorded. L&D is scheduling your assessment.",
    "REFRESHER_REQUIRED": "Review and acknowledge the refresher material. L&D then approves your re-attempt.",
    "AWAITING_APPROVAL": "Waiting for L&D to approve your re-attempt.",
    "AWAITING_RETRAINING": "You have used all attempts. Waiting for L&D approval of your re-training.",
    "QUESTION_POOL_INSUFFICIENT": "This assessment cannot start yet because its question pool is incomplete. L&D has been notified, and you can keep using TrainCheck until it is ready.",
    "TRAINING_ARCHIVED": "This training has been archived, so its assessment is no longer available.",
    "WAIVED": "L&D waived this assessment. No action is needed.",
    "CANCELLED": "L&D cancelled this assessment. No action is needed.",
    "COMPLETED": "This assessment is finished.",
    "FEEDBACK_REQUIRED": "Give your feedback on this assessment on its result page.",
    "NOT_A_POST_TEST": "Pre-tests are opened from My Trainings before your training is completed.",
}


def unavailable(reason: str, message_key: str | None = None) -> dict:
    return {"entry_state": "UNAVAILABLE", "entry_reason": reason, "entry_message": MESSAGES[message_key or reason]}


def available(state: str) -> dict:
    return {"entry_state": state, "entry_reason": None, "entry_message": None}


def before_assessment(completed: bool) -> dict:
    """No post-test exists yet. Completion recorded by L&D is the only trigger (BR §4.1)."""
    return unavailable("AWAITING_SCHEDULING" if completed else "AWAITING_COMPLETION")


def obligation_entry(db: Session, obligation: AssessmentObligation, now: datetime, cache: dict) -> dict:
    """Entry state of one obligation, using the same rules as the gate and start_attempt."""
    from app.modules.assessment.gate import obligation_startable

    status = obligation.status
    if obligation.assessment_type != AssessmentType.POST_TEST:
        return unavailable("NOT_A_POST_TEST")
    if status == ObligationStatus.COMPLETED:
        return unavailable("AWAITING_APPROVAL", "AWAITING_RETRAINING") if obligation.retraining_flag == "NEEDS_RETRAINING" else unavailable("COMPLETED")
    if status in (ObligationStatus.WAIVED, ObligationStatus.CANCELLED):
        return unavailable(str(status))
    if obligation.training.status == TrainingStatus.ARCHIVED:
        return unavailable("TRAINING_ARCHIVED")
    if status == ObligationStatus.IN_PROGRESS:
        return available("IN_PROGRESS")
    if status == ObligationStatus.RETAKE_PENDING:
        return unavailable("AWAITING_APPROVAL") if obligation.refresher_acknowledged_at else unavailable("REFRESHER_REQUIRED")
    if obligation.due_at is None:
        return unavailable("AWAITING_SCHEDULING")
    if obligation.due_at > now:
        return available("NOT_YET_OPEN")
    if not obligation_startable(db, obligation, cache):
        return unavailable("QUESTION_POOL_INSUFFICIENT")
    return available("OPEN")


def pending_group(entry: dict, result: str, feedback_owed: bool) -> str:
    """DUE (take or resume now), UPCOMING (opens later), UNFINISHED (waits on something), FINISHED (nothing left).

    Only a passed assessment with its feedback given, or one L&D waived or cancelled, is finished: a retake,
    owed feedback or re-training is not."""
    state, reason = entry["entry_state"], entry["entry_reason"]
    if state in ("OPEN", "IN_PROGRESS"):
        return "DUE"
    if state == "NOT_YET_OPEN":
        return "UPCOMING"
    if feedback_owed:
        return "UNFINISHED"
    if reason in ("WAIVED", "CANCELLED") or (reason == "COMPLETED" and result == ResultStatus.PASSED):
        return "FINISHED"
    return "UNFINISHED"


GROUP_ORDER = {"DUE": 0, "UPCOMING": 1, "UNFINISHED": 2, "FINISHED": 3}
# Within UNFINISHED, what the employee can act on comes before what waits on L&D or on completion.
REASON_ORDER = {
    "FEEDBACK_REQUIRED": 0,
    "REFRESHER_REQUIRED": 1,
    "QUESTION_POOL_INSUFFICIENT": 2,
    "AWAITING_APPROVAL": 3,
    "AWAITING_SCHEDULING": 4,
    "AWAITING_COMPLETION": 5,
    "TRAINING_ARCHIVED": 6,
}


def order_cards(cards: list[dict]) -> list[dict]:
    """Pending first, deterministically: due and running, then upcoming (earliest opening first), then unfinished,
    then finished. Ties fall back to the title and then the enrolment ID."""

    def key(card: dict) -> tuple:
        group = card["pending_group"]
        tail = ((card.get("title") or "").casefold(), card.get("enrolment_id") or "")
        if group == "DUE":
            return (0, 0 if card["entry_state"] == "IN_PROGRESS" else 1, card.get("due_at") or "", *tail)
        if group == "UPCOMING":
            return (1, 0, card.get("due_at") or "", *tail)
        if group == "UNFINISHED":
            return (2, REASON_ORDER.get(card.get("entry_reason") or "", len(REASON_ORDER)), card.get("planned_at") or card.get("due_at") or "~", *tail)
        return (GROUP_ORDER.get(group, 3), 0, "", *tail)

    return sorted(cards, key=key)
