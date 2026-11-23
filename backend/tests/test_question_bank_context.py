"""Question Bank by training and test: the card counts and the training/test-restricted question list.

GET /admin/questions?training_id=…&test_type=… lists what that training's pre-test or post-test may draw, by the
assessment engine's link rule: a link classified for that test, or an unclassified legacy link (both tests). The
summary counts each card exactly as that list, Active and Inactive. All data is synthetic.
"""
import uuid

import pytest
from sqlalchemy import func, select, update

from app.models import Question, QuestionTrainingTag


def classify(db, training, codes: list[str], test_type: str | None) -> None:
    """Sets the test type of these questions' links to this training (synthetic setup, as an import would)."""
    ids = list(db.scalars(select(Question.id).where(Question.question_code.in_(codes))))
    db.execute(update(QuestionTrainingTag).where(QuestionTrainingTag.training_id == training.id, QuestionTrainingTag.question_id.in_(ids)).values(test_type=test_type))
    db.commit()


def listed(admin, training, test_type, **params) -> list[str]:
    response = admin.get("/admin/questions", params={"training_id": str(training.id), "test_type": test_type, **params})
    assert response.status_code == 200, response.text
    return sorted(q["question_code"] for q in response.json()["data"])


def summary(admin) -> dict[tuple[str, str], dict]:
    response = admin.get("/admin/questions/summary")
    assert response.status_code == 200, response.text
    return {(c["code"], c["test_type"]): c for c in response.json()["data"]}


def setup_two_trainings(world, db):
    """ALPHA: Q01-Q02 pre-test, Q03-Q05 post-test, Q06 legacy (both). BETA: its own 2 post-test questions."""
    alpha = world.training("ALPHA", questions=6, count=1)
    beta = world.training("BETA", questions=2, count=1)
    classify(db, alpha, ["ALPHA-Q01", "ALPHA-Q02"], "PRE_TEST")
    classify(db, alpha, ["ALPHA-Q03", "ALPHA-Q04", "ALPHA-Q05"], "POST_TEST")
    classify(db, beta, ["BETA-Q01", "BETA-Q02"], "POST_TEST")
    return alpha, beta


def question_body(training_ids: list[str], text: str, **extra) -> dict:
    return {
        "topic": "Topic",
        "question_type": "MCQ_SINGLE",
        "question_text": text,
        "options": ["Right", "Wrong"],
        "correct_option_indexes": [0],
        "difficulty": "EASY",
        "marks": 1,
        "language": "English",
        "training_ids": training_ids,
        **extra,
    }


# ---------- Restricted list ----------

def test_pre_and_post_lists_are_separate_and_legacy_links_serve_both(world, db, client_for):
    alpha, _ = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    assert listed(admin, alpha, "PRE_TEST") == ["ALPHA-Q01", "ALPHA-Q02", "ALPHA-Q06"]
    assert listed(admin, alpha, "POST_TEST") == ["ALPHA-Q03", "ALPHA-Q04", "ALPHA-Q05", "ALPHA-Q06"]
    # Nothing was classified, relinked or removed by listing.
    assert db.scalar(select(func.count()).select_from(QuestionTrainingTag).where(QuestionTrainingTag.test_type.is_(None))) == 1


def test_no_question_leaks_from_another_training(world, db, client_for):
    alpha, beta = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    assert listed(admin, beta, "POST_TEST") == ["BETA-Q01", "BETA-Q02"]
    assert listed(admin, beta, "PRE_TEST") == []
    # A question shared by both trainings follows each training's own link, never the other's.
    shared = db.scalar(select(Question).where(Question.question_code == "BETA-Q01"))
    db.add(QuestionTrainingTag(question_id=shared.id, training_id=alpha.id, test_type="PRE_TEST"))
    db.commit()
    assert "BETA-Q01" in listed(admin, alpha, "PRE_TEST")
    assert "BETA-Q01" not in listed(admin, alpha, "POST_TEST")
    assert listed(admin, beta, "PRE_TEST") == []


def test_other_filters_narrow_within_the_training_and_test(world, db, client_for):
    alpha, _ = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    # world.training gives difficulty EASY, MEDIUM, HARD in turn: Q03 HARD, Q04 EASY, Q05 MEDIUM, Q06 HARD.
    assert listed(admin, alpha, "POST_TEST", difficulty="HARD") == ["ALPHA-Q03", "ALPHA-Q06"]
    assert listed(admin, alpha, "POST_TEST", search="ALPHA-Q04") == ["ALPHA-Q04"]
    assert listed(admin, alpha, "POST_TEST", search="BETA") == []  # A search never widens the selection.
    q05 = db.scalar(select(Question).where(Question.question_code == "ALPHA-Q05"))
    assert admin.post(f"/admin/questions/{q05.id}/status", json={"status": "INACTIVE"}).status_code == 200
    assert listed(admin, alpha, "POST_TEST", status="INACTIVE") == ["ALPHA-Q05"]
    assert listed(admin, alpha, "POST_TEST", status="ACTIVE") == ["ALPHA-Q03", "ALPHA-Q04", "ALPHA-Q06"]
    assert listed(admin, alpha, "POST_TEST") == ["ALPHA-Q03", "ALPHA-Q04", "ALPHA-Q05", "ALPHA-Q06"]  # Inactive still listed.


def test_a_test_type_needs_a_training_and_must_be_known(world, db, client_for):
    alpha, _ = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    assert admin.get("/admin/questions", params={"test_type": "PRE_TEST"}).status_code == 400
    assert admin.get("/admin/questions", params={"training_id": str(alpha.id), "test_type": "MID_TEST"}).status_code == 400
    # Without a test type the training filter behaves as before: every link of that training.
    response = admin.get("/admin/questions", params={"training_id": str(alpha.id)})
    assert len(response.json()["data"]) == 6


# ---------- Card counts ----------

def test_card_counts_match_the_lists_and_include_inactive(world, db, client_for):
    alpha, beta = setup_two_trainings(world, db)
    world.training("EMPTY", questions=0, count=1)
    admin = client_for(world.admin)
    q01 = db.scalar(select(Question).where(Question.question_code == "ALPHA-Q01"))
    assert admin.post(f"/admin/questions/{q01.id}/status", json={"status": "INACTIVE"}).status_code == 200

    cards = summary(admin)
    assert list(cards) == [("ALPHA", "PRE_TEST"), ("ALPHA", "POST_TEST"), ("BETA", "POST_TEST")]
    assert {k: v["question_count"] for k, v in cards.items()} == {
        ("ALPHA", "PRE_TEST"): 3, ("ALPHA", "POST_TEST"): 4,
        ("BETA", "POST_TEST"): 2,
    }
    assert (cards["ALPHA", "PRE_TEST"]["active"], cards["ALPHA", "PRE_TEST"]["inactive"], cards["ALPHA", "PRE_TEST"]["unclassified"]) == (2, 1, 1)
    for training in (alpha, beta):
        for test_type in ("PRE_TEST", "POST_TEST"):
            questions = listed(admin, training, test_type)
            key = training.training_code, test_type
            if questions:
                assert cards[key]["question_count"] == len(questions)
                assert cards[key]["training_id"] == str(training.id)
            else:
                assert key not in cards


def test_training_creation_alone_has_no_cards_and_linking_questions_adds_only_the_matching_test(world, db, client_for):
    admin = client_for(world.admin)
    response = admin.post("/admin/trainings", json={"title": "Empty training", "training_code": "EMPTY"})
    assert response.status_code == 200
    training_id = response.json()["data"]["id"]
    assert summary(admin) == {}

    pre = admin.post("/admin/questions", json=question_body([training_id], "A pre-test question?", training_test_types={training_id: "PRE_TEST"}))
    assert pre.status_code == 200
    assert list(summary(admin)) == [("EMPTY", "PRE_TEST")]
    assert summary(admin)["EMPTY", "PRE_TEST"]["question_count"] == 1

    # Inactive questions are still linked and remain available in the admin table.
    assert admin.post(f"/admin/questions/{pre.json()['data']['id']}/status", json={"status": "INACTIVE"}).status_code == 200
    assert summary(admin)["EMPTY", "PRE_TEST"]["inactive"] == 1
    assert ("EMPTY", "POST_TEST") not in summary(admin)

    post = admin.post("/admin/questions", json=question_body([training_id], "A post-test question?", training_test_types={training_id: "POST_TEST"}))
    assert post.status_code == 200
    assert list(summary(admin)) == [("EMPTY", "PRE_TEST"), ("EMPTY", "POST_TEST")]
    assert summary(admin)["EMPTY", "POST_TEST"]["question_count"] == 1


@pytest.mark.parametrize("test_type", ["PRE_TEST", "POST_TEST"])
def test_only_a_committed_question_import_creates_its_test_card(world, db, client_for, test_type):
    training = world.training("IMPORT", questions=0, count=1)
    admin = client_for(world.admin)
    content = b"question,option_a,option_b,option_c,option_d,correct,topic\nWhich action follows the process?,Follow the checklist,Skip verification,Guess,Ignore the request,A,Process\n"
    response = admin.post("/admin/imports", files={"file": ("questions.csv", content, "text/csv")}, data={"import_type": "QUESTIONS", "training_id": str(training.id), "test_type": test_type})
    assert response.status_code == 200, response.text
    job = response.json()["data"]
    assert job["accepted_rows"] == 1
    assert summary(admin) == {}  # Upload/validation is not a question assignment.
    commit = admin.post(f"/admin/imports/{job['id']}/commit")
    assert commit.status_code == 200, commit.text
    cards = summary(admin)
    assert list(cards) == [("IMPORT", test_type)]
    assert cards["IMPORT", test_type]["question_count"] == 1
    assert cards["IMPORT", test_type]["training_id"] == str(training.id)


# ---------- Adding in context ----------

def test_a_question_added_for_a_test_keeps_that_context(world, db, client_for):
    alpha, beta = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    body = question_body([str(alpha.id), str(beta.id)], "Added for the ALPHA pre-test?", training_test_types={str(alpha.id): "PRE_TEST"})
    response = admin.post("/admin/questions", json=body)
    assert response.status_code == 200, response.text
    created = response.json()["data"]
    assert {t["code"]: t["test_type"] for t in created["trainings"]} == {"ALPHA": "PRE_TEST", "BETA": None}
    assert created["question_code"] in listed(admin, alpha, "PRE_TEST")
    assert created["question_code"] not in listed(admin, alpha, "POST_TEST")
    assert summary(admin)["ALPHA", "PRE_TEST"]["question_count"] == 4

    # Without a context the form keeps making unclassified links, as before.
    plain = admin.post("/admin/questions", json=question_body([str(alpha.id)], "Added without a context?")).json()["data"]
    assert [t["test_type"] for t in plain["trainings"]] == [None]

    # An edit never changes an existing classification, even if a test type is sent.
    edit = question_body([str(alpha.id)], "Added for the ALPHA pre-test, reworded?", question_code=created["question_code"], training_test_types={str(alpha.id): "POST_TEST"})
    assert admin.patch(f"/admin/questions/{created['id']}", json=edit).status_code == 200
    links = set(db.execute(select(QuestionTrainingTag.training_id, QuestionTrainingTag.test_type).where(QuestionTrainingTag.question_id == uuid.UUID(created["id"]))).all())
    assert links == {(alpha.id, "PRE_TEST")}


def test_a_context_test_type_must_belong_to_a_selected_training(world, db, client_for):
    alpha, beta = setup_two_trainings(world, db)
    admin = client_for(world.admin)
    before = db.scalar(select(func.count()).select_from(Question))
    assert admin.post("/admin/questions", json=question_body([str(alpha.id)], "Wrong training?", training_test_types={str(beta.id): "PRE_TEST"})).status_code == 400
    assert admin.post("/admin/questions", json=question_body([str(alpha.id)], "Unknown test?", training_test_types={str(alpha.id): "MID_TEST"})).status_code == 400
    assert db.scalar(select(func.count()).select_from(Question)) == before


# ---------- Permissions ----------

def test_the_restricted_list_and_counts_are_for_ld_only(world, db, client_for):
    alpha, _ = setup_two_trainings(world, db)
    for person in (world.employee, world.manager, world.hr):
        client = client_for(person)
        assert client.get("/admin/questions/summary").status_code == 403
        assert client.get("/admin/questions", params={"training_id": str(alpha.id), "test_type": "PRE_TEST"}).status_code == 403
        assert client.post("/admin/questions", json=question_body([str(alpha.id)], "Not allowed?", training_test_types={str(alpha.id): "PRE_TEST"})).status_code == 403
    anonymous = client_for(world.admin)
    anonymous.http.cookies.clear()
    assert anonymous.get("/admin/questions/summary").status_code == 401


# ---------- Unknown references (audit B6) ----------

@pytest.mark.parametrize("field", ["competency_id", "department_id", "function_id"])
def test_unknown_competency_department_or_function_is_a_400_not_a_500(world, db, client_for, field):
    """A stale or hand-made ID is a clear validation error on create and on edit, and changes nothing."""
    training = world.training("ALPHA", questions=1, count=1)
    admin = client_for(world.admin)
    missing = str(uuid.uuid4())
    label = field.removesuffix("_id")

    created = admin.post("/admin/questions", json=question_body([str(training.id)], "Which is the approved process?", **{field: missing}))
    assert created.status_code == 400, created.text
    assert created.json()["error"] == {**created.json()["error"], "code": "VALIDATION_ERROR", "message": f"The selected {label} no longer exists."}
    assert db.scalar(select(func.count()).select_from(Question).where(Question.question_text == "Which is the approved process?")) == 0

    question = db.scalar(select(Question).where(Question.question_code == "ALPHA-Q01"))
    edited = admin.patch(f"/admin/questions/{question.id}", json=question_body([str(training.id)], "Edited text", **{field: missing}))
    assert edited.status_code == 400, edited.text
    assert edited.json()["error"]["message"] == f"The selected {label} no longer exists."
    db.expire_all()
    assert db.get(Question, question.id).question_text != "Edited text" and db.get(Question, question.id).version == question.version
