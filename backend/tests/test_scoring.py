"""Scoring boundaries. TC-SCORE-*, Business Rules §8.3 and §20.1."""
import json
from decimal import Decimal

import pytest

from app.modules.assessment.service import is_pass, truncate_percent
from tests.conftest import answer_with_score, start, submit, take


@pytest.mark.parametrize(
    ("earned", "total", "pass_mark", "expected"),
    [
        ("69", "100", "70", False),
        ("69.9", "100", "70", False),
        ("70", "100", "70", True),
        ("70.1", "100", "70", True),
        ("84.5", "100", "70", True),
        ("69.9", "100", "65", True),
        ("64.9", "100", "65", False),
        ("699", "1000", "70", False),
        ("7", "10", "70", True),
        ("6.99", "9.99", "70", False),  # 69.97% would display as 70.0 if rounded up.
    ],
)
def test_pass_decision_table(earned, total, pass_mark, expected):
    assert is_pass(Decimal(earned), Decimal(total), Decimal(pass_mark)) is expected


def test_recurring_decimal_at_threshold_is_exact():
    """2/3 of the marks is not 66.67 at a threshold of 66.67: the exact value is below it."""
    assert is_pass(Decimal("2"), Decimal("3"), Decimal("66.67")) is False
    assert is_pass(Decimal("2"), Decimal("3"), Decimal("66.66")) is True


def test_stored_score_is_truncated_not_rounded_up():
    assert truncate_percent(Decimal("6.99"), Decimal("9.99")) == Decimal("69.969969")
    assert truncate_percent(Decimal("2"), Decimal("3")) == Decimal("66.666666")


def test_exactly_seventy_percent_passes(world, client_for, db):  # TC-SCORE-001
    obligation = world.complete(world.employee, world.training())
    result = take(db, client_for(world.employee), obligation.id, 7)
    assert result["score_percent"] == 70.0
    assert result["result_status"] == "PASSED"


def test_just_below_threshold_fails_through_the_api(world, client_for, db):  # TC-SCORE-002
    # 699 of 1000 marks gives exactly 69.9%.
    training = world.training(questions=0, count=2)
    world.question(training, "A", marks=Decimal("69.9"))
    world.question(training, "B", marks=Decimal("30.1"))
    db.commit()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    from app.models import AttemptQuestion

    for question in attempt["questions"]:
        row = db.get(AttemptQuestion, question["attempt_question_id"])
        wrong = [o["option_id"] for o in question["options"] if o["option_id"] not in row.answer_key_snapshot]
        selected = row.answer_key_snapshot if float(row.marks_snapshot) == 69.9 else [wrong[0]]
        client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": selected})
    result = submit(client, attempt["attempt_id"])
    assert result["score_percent"] == 69.9
    assert result["result_status"] == "NOT_PASSED"


def test_configured_threshold_is_used(world, client_for, db):  # TC-SCORE-004
    obligation = world.complete(world.employee, world.training(pass_mark=Decimal("65")))
    assert take(db, client_for(world.employee), obligation.id, 7)["result_status"] == "PASSED"


def test_weighted_marks(world, client_for, db):  # TC-SCORE-005
    training = world.training(questions=0, count=2)
    world.question(training, "HEAVY", marks=Decimal("3"))
    world.question(training, "LIGHT", marks=Decimal("1"))
    db.commit()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    from app.models import AttemptQuestion

    for question in attempt["questions"]:
        row = db.get(AttemptQuestion, question["attempt_question_id"])
        wrong = [o["option_id"] for o in question["options"] if o["option_id"] not in row.answer_key_snapshot]
        selected = row.answer_key_snapshot if float(row.marks_snapshot) == 3 else [wrong[0]]
        client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": selected})
    result = submit(client, attempt["attempt_id"])
    assert result["obtained_marks"] == 3 and result["total_marks"] == 4 and result["score_percent"] == 75.0


def test_multiple_select_needs_exact_set(world, client_for, db):  # TC-SCORE-006
    training = world.training(questions=0, count=1)
    world.question(training, "MULTI", question_type="MCQ_MULTIPLE", correct=2)
    db.commit()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    question = attempt["questions"][0]
    from app.models import AttemptQuestion

    key = db.get(AttemptQuestion, question["attempt_question_id"]).answer_key_snapshot
    client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": key[:1]})
    assert submit(client, attempt["attempt_id"])["score_percent"] == 0.0  # No partial credit.


def test_unanswered_scores_zero_marks(world, client_for, db):  # TC-SCORE-007
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    result = submit(client, attempt["attempt_id"])
    assert result["score_percent"] == 0.0 and result["answered_count"] == 0


def forbidden_key_terms(text: str) -> list[str]:
    return [t for t in ("is_correct", "answer_key", "correct_option", "explanation", "correct_answer", "marks_awarded") if t in text]


def test_answer_key_never_leaves_before_submission(world, client_for, db):  # TC-SCORE-008, SEC-005
    obligation = world.complete(world.employee, world.training(show_explanations=True))
    client = client_for(world.employee)
    bodies = [client.get("/me/access-state").text, client.get(f"/me/assessment-obligations/{obligation.id}").text]
    started = client.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True})
    bodies.append(started.text)
    attempt = started.json()["data"]
    bodies.append(client.get(f"/attempts/{attempt['attempt_id']}").text)
    question = attempt["questions"][0]
    bodies.append(client.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": [question["options"][0]["option_id"]]}).text)
    for body in bodies:
        assert forbidden_key_terms(body) == [], body[:300]
    # The explanation text itself must not appear either.
    assert "Explanation for" not in " ".join(bodies)
    # The result endpoint refuses to answer before submission.
    assert client.get(f"/attempts/{attempt['attempt_id']}/result").status_code == 409


def test_explanations_hidden_when_disabled(world, client_for, db):  # TC-SCORE-009
    obligation = world.complete(world.employee, world.training(show_explanations=False))
    result = take(db, client_for(world.employee), obligation.id, 10)
    assert result["answer_review"] == [] and result["explanations_enabled"] is False


def test_explanations_shown_after_submission_when_enabled(world, client_for, db):  # TC-SCORE-010
    obligation = world.complete(world.employee, world.training(show_explanations=True))
    result = take(db, client_for(world.employee), obligation.id, 10)
    assert result["answer_review"][0]["explanation"].startswith("Explanation for")
    assert result["answer_review"][0]["correct_answer"]


def test_question_edit_does_not_change_running_attempt(world, client_for, db):  # TC-SCORE-011
    from sqlalchemy import select

    from app.models import AttemptQuestion, Question, QuestionAnswerKey

    training = world.training()
    obligation = world.complete(world.employee, training)
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    before = attempt["questions"][0]
    row = db.get(AttemptQuestion, before["attempt_question_id"])
    key = list(row.answer_key_snapshot)

    question = db.get(Question, row.question_id)
    question.question_text = "EDITED AFTER START"
    question.status = "INACTIVE"
    db.execute(QuestionAnswerKey.__table__.delete().where(QuestionAnswerKey.question_id == question.id))
    db.commit()

    after = client.get(f"/attempts/{attempt['attempt_id']}").json()["data"]["questions"][0]
    assert after["question_text"] == before["question_text"] != "EDITED AFTER START"
    client.put(f"/attempts/{attempt['attempt_id']}/questions/{before['attempt_question_id']}/answer", json={"selected_option_ids": key})
    assert submit(client, attempt["attempt_id"])["correct_count"] == 1
    assert db.scalar(select(Question.status).where(Question.id == question.id)) == "INACTIVE"


def test_client_supplied_score_is_ignored(world, client_for, db):  # TC-SCORE-012, SEC-006
    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    attempt = start(client, obligation.id)
    answer_with_score(db, client, attempt, 1)
    response = client.post(f"/attempts/{attempt['attempt_id']}/submit", json={"score_percent": 100, "result_status": "PASSED", "obtained_marks": 10})
    data = response.json()["data"]
    assert data["score_percent"] == 10.0 and data["result_status"] == "NOT_PASSED"
    assert "100" not in json.dumps(data.get("score_percent"))
