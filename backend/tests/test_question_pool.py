"""Question pool diagnostics for Assessment Configuration (BR §7, §20.4). Validation stays server-side."""
import pytest
from sqlalchemy import select

from app.models import AssessmentConfig, Question, QuestionOption


def pool(client, training_id, **params):
    response = client.get(f"/admin/trainings/{training_id}/question-pool", params=params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def save_config(client, training_id, count, **extra):
    return client.post(f"/admin/trainings/{training_id}/assessment-configs", json={"question_count": count, "duration_minutes": 15, **extra})


def add_question(client, training_id, code, difficulty="EASY"):
    body = {"question_code": code, "topic": "Topic", "question_type": "MCQ_SINGLE", "question_text": f"{code}?", "options": ["Right", "Wrong"], "correct_option_indexes": [0], "difficulty": difficulty, "marks": 1, "training_ids": [str(training_id)]}
    response = client.post("/admin/questions", json=body)
    assert response.status_code == 200, response.text


def configs(db, training_id):
    db.expire_all()
    return db.scalars(select(AssessmentConfig).where(AssessmentConfig.training_id == training_id).order_by(AssessmentConfig.version)).all()


def test_zero_eligible_questions(world, client_for, db):  # 1
    admin = client_for(world.admin)
    training_id = admin.post("/admin/trainings", json={"title": "Sales Basics", "training_code": "SALES1"}).json()["data"]["id"]
    report = pool(admin, training_id)
    assert (report["linked_total"], report["eligible"], report["suggested_question_count"]) == (0, 0, 0)

    response = save_config(admin, training_id, 1)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "QUESTION_POOL_INSUFFICIENT"
    assert "Sales Basics has no eligible active questions" in error["message"]
    assert (error["details"]["eligible"], error["details"]["required"], error["details"]["shortfall"]) == (0, 1, 1)
    assert configs(db, training_id) == []


@pytest.mark.parametrize(("questions", "suggested"), [(5, 5), (10, 10), (20, 10)])
def test_suggested_questions_per_attempt(world, client_for, questions, suggested):  # 2, 3, 4
    training = world.training(f"S{questions}", questions=questions, count=1)
    report = pool(client_for(world.admin), training.id)
    assert report["eligible"] == questions
    assert report["suggested_question_count"] == suggested


def test_existing_configured_count_is_reported_not_reduced(world, client_for):  # 5
    training = world.training("MANUAL", questions=20, count=12)
    detail = client_for(world.admin).get(f"/admin/trainings/{training.id}").json()["data"]
    assert detail["config"]["question_count"] == 12  # Kept, though the suggestion for a new form is 10.
    assert detail["question_pool"]["suggested_question_count"] == 10
    assert (detail["question_pool"]["required"], detail["question_pool"]["ready"]) == (12, True)
    assert detail["pool_problem"] is None


def test_questions_of_another_training_do_not_count(world, client_for):  # 6
    mine = world.training("MINE", questions=3, count=1)
    world.training("OTHER", questions=7, count=1)
    report = pool(client_for(world.admin), mine.id)
    assert (report["linked_total"], report["eligible"]) == (3, 3)


def test_inactive_questions_are_excluded_and_counted(world, client_for, db):  # 7
    training = world.training("INACT", questions=5, count=1)
    for question in db.scalars(select(Question).limit(2)):
        question.status = "INACTIVE"
    db.commit()
    report = pool(client_for(world.admin), training.id, question_count=5)
    assert (report["linked_total"], report["active"], report["inactive"], report["eligible"]) == (5, 3, 2, 3)
    assert (report["ready"], report["shortfall"]) == (False, 2)


def test_questions_missing_answer_keys(world, client_for, db):  # 8
    training = world.training("NOKEY", questions=2, count=1)
    world.question(training, "NOKEY-Q", correct=0)
    db.commit()
    report = pool(client_for(world.admin), training.id)
    assert (report["active"], report["missing_answer_key"], report["eligible"]) == (3, 1, 2)
    assert report["missing_answer_key_codes"] == ["NOKEY-Q"]


def test_questions_with_insufficient_options(world, client_for, db):  # 9
    training = world.training("FEWOPT", questions=2, count=1)
    question = world.question(training, "ONE-OPTION")
    for option in db.scalars(select(QuestionOption).where(QuestionOption.question_id == question.id, QuestionOption.display_order > 0)):
        db.delete(option)
    db.commit()
    report = pool(client_for(world.admin), training.id)
    assert (report["insufficient_options"], report["eligible"]) == (1, 2)
    assert report["insufficient_options_codes"] == ["ONE-OPTION"]


def test_difficulty_mix_with_insufficient_easy(world, client_for, db):  # 10
    training = world.training("MIX", questions=6, count=6)  # Two each of Easy, Medium and Hard.
    admin = client_for(world.admin)
    response = save_config(admin, training.id, 6, difficulty_mix={"EASY": 4, "MEDIUM": 1, "HARD": 1})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["details"]["reason"] == "INSUFFICIENT_DIFFICULTY"
    assert error["details"]["difficulty_shortfalls"] == [{"difficulty": "EASY", "available": 2, "required": 4, "shortfall": 2}]
    assert "Easy: 2 available, 4 required." in error["message"]
    assert pool(admin, training.id, question_count=6, easy=4, medium=1, hard=1)["difficulty_shortfalls"][0]["difficulty"] == "EASY"
    # Without a mix, no difficulty restriction applies.
    assert save_config(admin, training.id, 6).status_code == 200


def test_mix_is_only_applied_when_enabled(world, client_for, db):
    training = world.training("ALLHARD", questions=0, count=1)
    for i in range(4):
        world.question(training, f"HARD-{i}", difficulty="HARD")
    db.commit()
    admin = client_for(world.admin)
    assert pool(admin, training.id, question_count=4)["ready"] is True
    assert save_config(admin, training.id, 4).status_code == 200


def test_adding_questions_after_a_failed_save(world, client_for, db):  # 11
    training = world.training("GROW", questions=4, count=4)
    admin = client_for(world.admin)
    failed = save_config(admin, training.id, 5)
    assert failed.status_code == 422
    assert "has 4 eligible active questions, but the assessment requires 5. Add 1 more or reduce questions per attempt to 4." in failed.json()["error"]["message"]
    versions = configs(db, training.id)
    assert [(c.version, c.is_active, c.question_count) for c in versions] == [(1, True, 4)]  # Nothing changed.

    add_question(admin, training.id, "GROW-NEW")
    assert pool(admin, training.id, question_count=5)["ready"] is True
    assert save_config(admin, training.id, 5).json()["data"]["version"] == 2
    assert [(c.version, c.is_active) for c in configs(db, training.id)] == [(1, False), (2, True)]  # History kept.


def test_successful_save_then_activation(world, client_for):  # 12
    admin = client_for(world.admin)
    training_id = admin.post("/admin/trainings", json={"title": "Fresh", "training_code": "FRESH"}).json()["data"]["id"]
    early = admin.post(f"/admin/trainings/{training_id}/status", json={"status": "ACTIVE"})
    assert early.status_code == 422 and "no assessment configuration" in early.json()["error"]["message"]

    for i in range(3):
        add_question(admin, training_id, f"FRESH-{i}")
    assert pool(admin, training_id)["suggested_question_count"] == 3
    assert save_config(admin, training_id, 3).status_code == 200
    listed = next(t for t in admin.get("/admin/trainings").json()["data"] if t["id"] == training_id)
    assert (listed["eligible_questions"], listed["config_ready"]) == (3, True)
    activated = admin.post(f"/admin/trainings/{training_id}/status", json={"status": "ACTIVE"})
    assert activated.status_code == 200 and activated.json()["data"]["status"] == "ACTIVE"


def test_activation_blocked_when_pool_shrinks(world, client_for, db):
    training = world.training("SHRINK", questions=3, count=3, )
    training.status = "DRAFT"
    db.scalars(select(Question)).first().status = "INACTIVE"
    db.commit()
    response = client_for(world.admin).post(f"/admin/trainings/{training.id}/status", json={"status": "ACTIVE"})
    assert response.status_code == 422
    assert response.json()["error"]["details"]["shortfall"] == 1


def test_only_ld_can_read_the_pool(world, client_for):
    training = world.training("PRIV", questions=1, count=1)
    assert client_for(world.hr).get(f"/admin/trainings/{training.id}/question-pool").status_code == 403
    assert client_for(world.employee).get(f"/admin/trainings/{training.id}/question-pool").status_code == 403
