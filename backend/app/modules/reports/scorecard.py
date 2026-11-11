"""Training Learning & Behaviour Scorecard (SC-2L-101). Two sections, no combined score."""
from collections import defaultdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.enums import AssessmentType, DataState, ObligationStatus, ResultStatus, ReviewerType
from app.core.responses import display_percent
from app.models import AttemptQuestion, BehaviourReview, BehaviourTemplate, Training
from app.modules.assessment.service import active_config
from app.modules.reports.data import Row, behaviour_reviews, mean, rate


def gain_values(pre: float | None, post: float | None) -> tuple[float | None, float | None, str | None]:
    """Absolute gain and normalised gain. Unavailable values carry a reason instead of a zero."""
    if pre is None or post is None:
        return None, None, "Not collected"
    absolute = round(post - pre, 2)
    if pre >= 100:
        return absolute, None, "Not applicable: pre-test was 100%"
    return absolute, round((post - pre) / (100 - pre) * 100, 2), None


def learning_state(db: Session, training: Training, rows: list[Row], now: datetime) -> str:
    if active_config(db, training.id, AssessmentType.POST_TEST) is None:
        return DataState.NOT_CONFIGURED
    if not rows:
        return DataState.NOT_COLLECTED
    obligations = [r.obligation for r in rows if r.obligation]
    due = [o for o in obligations if o.status != ObligationStatus.WAIVED and o.due_at and o.due_at <= now]
    assessed = [r for r in rows if r.post_attempts]
    if not assessed:
        return DataState.NOT_COLLECTED if due else DataState.NOT_YET_DUE
    return DataState.AVAILABLE if len(assessed) >= len(due) else DataState.INCOMPLETE


def pretest_state(training: Training, rows: list[Row]) -> str:
    if not training.pretest_enabled:
        return DataState.NOT_CONFIGURED
    taken = [r for r in rows if r.pre_attempt]
    if not taken:
        return DataState.NOT_COLLECTED
    return DataState.AVAILABLE if len(taken) == len(rows) else DataState.INCOMPLETE


def behaviour_state(db: Session, training: Training, reviews: list[BehaviourReview], now: datetime) -> str:
    if not training.behaviour_enabled:
        return DataState.NOT_CONFIGURED
    if not reviews:
        has_template = db.scalar(select(BehaviourTemplate.id).where(BehaviourTemplate.is_active, (BehaviourTemplate.training_id == training.id) | (BehaviourTemplate.training_id.is_(None))).limit(1))
        return DataState.NOT_YET_DUE if has_template else DataState.NOT_CONFIGURED
    due = [r for r in reviews if r.cycle.due_at <= now]
    if not due:
        return DataState.NOT_YET_DUE
    submitted = [r for r in due if r.submitted_at]
    if not submitted:
        return DataState.NOT_COLLECTED
    return DataState.AVAILABLE if len(submitted) == len(due) else DataState.INCOMPLETE


def improvement_label(first: float | None, last: float | None, periods: int) -> str:
    """A description of movement in manager ratings, never an employment judgement."""
    if first is None or last is None or periods < 2:
        return "Not enough follow-ups"
    if last > first:
        return "Improving"
    if last < first:
        return "Declining"
    return "Stable"


def question_performance(db: Session, rows: list[Row]) -> tuple[list[dict], list[dict]]:
    attempt_ids = [a.id for r in rows for a in r.post_attempts]
    if not attempt_ids:
        return [], []
    questions = db.scalars(select(AttemptQuestion).options(selectinload(AttemptQuestion.answer)).where(AttemptQuestion.attempt_id.in_(attempt_ids))).all()
    topics: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    items: dict[tuple, dict] = {}
    for q in questions:
        awarded = float(q.answer.marks_awarded or 0) if q.answer else 0.0
        topics[q.topic_snapshot][0] += awarded
        topics[q.topic_snapshot][1] += float(q.marks_snapshot)
        if q.answer and q.answer.selected_option_ids:
            item = items.setdefault((q.question_id, q.question_version), {"question": q.question_text_snapshot, "topic": q.topic_snapshot, "responses": 0, "correct": 0})
            item["responses"] += 1
            item["correct"] += 1 if q.answer.is_correct else 0
    topic_rows = [{"topic": name, "score": round(v[0] / v[1] * 100, 1) if v[1] else None} for name, v in sorted(topics.items())]
    item_rows = sorted(({**i, "correct_percent": rate(i["correct"], i["responses"])} for i in items.values()), key=lambda i: i["correct_percent"] or 0)
    return topic_rows, item_rows[:10]


def build_scorecard(db: Session, training: Training, rows: list[Row]) -> dict:
    now = utcnow()
    reviews = behaviour_reviews(db, [r.enrolment.id for r in rows])
    assessed = [r for r in rows if r.post_attempts]
    passed = [r for r in assessed if r.result == ResultStatus.PASSED]
    pairs = [(float(r.pre_attempt.score_percent), float(r.first)) for r in rows if r.pre_attempt and r.first is not None]
    gains = [gain_values(pre, post) for pre, post in pairs]
    topics, items = question_performance(db, rows)

    learning = {
        "state": learning_state(db, training, rows, now),
        "assigned": len(rows),
        "completed": sum(1 for r in rows if r.enrolment.completion),
        "assessed": len(assessed),
        "pre_test_state": pretest_state(training, rows),
        "pre_test_mean": display_percent(mean([r.pre_attempt.score_percent for r in rows if r.pre_attempt])),
        "post_test_mean": display_percent(mean([r.latest for r in assessed])),
        "first_attempt_mean": display_percent(mean([r.first for r in assessed])),
        "best_score_mean": display_percent(mean([r.best for r in assessed])),
        "pass_rate": rate(len(passed), len(assessed)),
        "failed_attempts": sum(1 for r in assessed for a in r.post_attempts if a.result_status == ResultStatus.NOT_PASSED),
        "needs_retraining": sum(1 for r in rows if r.result == "NEEDS_RETRAINING"),
        "matched_pairs": len(pairs),
        "learning_gain_mean": mean([g[0] for g in gains]),
        "normalised_gain_mean": mean([g[1] for g in gains]),
        "topics": topics,
        "questions": items,
    }

    periods: dict[int, dict] = {}
    for review in reviews:
        period = periods.setdefault(review.cycle.period_days, {"period_days": review.cycle.period_days, "self": [], "manager": [], "self_submitted": 0, "manager_submitted": 0, "total": 0, "overdue": 0, "not_due": 0})
        period["total"] += 1
        if review.submitted_at:
            is_self = review.reviewer_type == ReviewerType.SELF
            period["self" if is_self else "manager"] += [x.rating for x in review.responses]
            period["self_submitted" if is_self else "manager_submitted"] += 1
        elif review.cycle.due_at > now:
            period["not_due"] += 1
        elif (now - review.cycle.due_at).days >= 1:
            period["overdue"] += 1
    period_rows = [
        {
            "period_days": p["period_days"],
            "self_mean": mean(p["self"]),
            "manager_mean": mean(p["manager"]),
            "self_submitted": p["self_submitted"],
            "manager_submitted": p["manager_submitted"],
            "reviews_total": p["total"],
            "overdue": p["overdue"],
            "not_due": p["not_due"],
        }
        for _, p in sorted(periods.items())
    ]

    competencies: dict[str, dict] = {}
    for review in reviews:
        for response in review.responses:
            entry = competencies.setdefault(response.competency.name, {"competency": response.competency.name, "self": [], "manager": []})
            entry["self" if review.reviewer_type == ReviewerType.SELF else "manager"].append(response.rating)
    competency_rows = []
    for entry in sorted(competencies.values(), key=lambda c: c["competency"]):
        self_mean, manager_mean = mean(entry["self"]), mean(entry["manager"])
        competency_rows.append(
            {
                "competency": entry["competency"],
                "self_mean": self_mean,
                "manager_mean": manager_mean,
                "gap": round(manager_mean - self_mean, 2) if self_mean is not None and manager_mean is not None else None,
            }
        )
    manager_periods = [p for p in period_rows if p["manager_mean"] is not None]
    behaviour = {
        "state": behaviour_state(db, training, reviews, now),
        "self_mean": mean([x.rating for r in reviews if r.reviewer_type == ReviewerType.SELF for x in r.responses]),
        "manager_mean": mean([x.rating for r in reviews if r.reviewer_type == ReviewerType.MANAGER for x in r.responses]),
        "self_manager_gap": None,
        "periods": period_rows,
        "competencies": competency_rows,
        "overdue": sum(p["overdue"] for p in period_rows),
        "improvement_status": improvement_label(
            manager_periods[0]["manager_mean"] if manager_periods else None,
            manager_periods[-1]["manager_mean"] if manager_periods else None,
            len(manager_periods),
        ),
    }
    if behaviour["self_mean"] is not None and behaviour["manager_mean"] is not None:
        behaviour["self_manager_gap"] = round(behaviour["manager_mean"] - behaviour["self_mean"], 2)

    return {
        "training": {
            "id": str(training.id),
            "code": training.training_code,
            "title": training.title,
            "category": training.category,
            "trainer": training.trainer.name if training.trainer else None,
            "owner": training.owner.full_name if training.owner else None,
            "batches": sorted({r.enrolment.batch.name for r in rows if r.enrolment.batch}),
            "followup_days": training.followup_days,
        },
        "generated_at": now.isoformat(),
        "learning": learning,
        "behaviour": behaviour,
        "interpretation": "A passed assessment is evidence of learning, not proof of behaviour change. Ratings are observations, not objective measures. Missing evidence is never treated as zero.",
    }

