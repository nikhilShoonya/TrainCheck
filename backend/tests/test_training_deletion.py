"""Permanent training deletion, Unassigned Questions and assigning questions to a training's test (25 Nov 2026).

Deleting a training removes everything that belongs only to it (assignments, completions, assessments, attempts and
their snapshots, feedback, batches, materials, links, reports filtered to it, notifications about it) and keeps
employees, master data, other trainings and every Question Bank question with its options, answer key and revisions.
Questions left with no training link are listed as Unassigned Questions and can be linked to a training's pre-test or
post-test again. All data here is synthetic, in the disposable test database.
"""
import pathlib
import threading
import time
import uuid

from sqlalchemy import func, select, text

from app.core import db as database
from app.core.config import get_settings
from app.models import (
    AssessmentAttempt,
    AssessmentConfig,
    AssessmentFeedback,
    AssessmentObligation,
    AttemptAnswer,
    AttemptQuestion,
    AttemptSecurityEvent,
    AuditLog,
    Competency,
    Department,
    Employee,
    Enrolment,
    Function,
    ImportJob,
    ImportJobRow,
    Notification,
    Question,
    QuestionAnswerKey,
    QuestionOption,
    QuestionRevision,
    QuestionTrainingTag,
    ReportExport,
    ReportSchedule,
    Training,
    TrainingBatch,
    TrainingCompletion,
    TrainingMaterial,
    UserAccount,
    UserRole,
)
from app.modules.training import deletion
from app.modules.training.locks import hold_training
from tests.conftest import NOW, authorise_reattempt, give_feedback, take

EXPORT = {"report_code": "pass-fail", "export_format": "CSV"}


def count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def exists(db, model, record_id) -> bool:
    """By query: a deleted row's expired instance cannot be read back with db.get()."""
    return count(db, model, model.id == record_id) == 1


def confirm(training: Training) -> dict:
    return {"confirmation_code": training.training_code}


def link(db, question: Question, training: Training, test_type: str | None = None) -> None:
    db.add(QuestionTrainingTag(question_id=question.id, training_id=training.id, test_type=test_type))
    db.commit()


def question_master(db, question_id) -> tuple:
    """Everything that is the question itself (not a link): content, status, version, options, key, revisions."""
    db.expire_all()
    q = db.get(Question, question_id)
    options = tuple(db.scalars(select(QuestionOption.option_text).where(QuestionOption.question_id == q.id).order_by(QuestionOption.display_order)))
    keys = tuple(sorted(str(k) for k in db.scalars(select(QuestionAnswerKey.option_id).where(QuestionAnswerKey.question_id == q.id))))
    revisions = tuple(db.scalars(select(QuestionRevision.version).where(QuestionRevision.question_id == q.id).order_by(QuestionRevision.version)))
    return (q.question_code, q.question_text, q.explanation, q.topic, q.difficulty, str(q.marks), q.status, q.version, options, keys, revisions)


def unassigned_codes(admin, query: str = "") -> list[str]:
    response = admin.get(f"/admin/questions?unassigned=true{query}")
    assert response.status_code == 200, response.text
    return sorted(q["question_code"] for q in response.json()["data"])


def unassigned_count(admin) -> int:
    response = admin.get("/admin/questions/unassigned-summary")
    assert response.status_code == 200, response.text
    return response.json()["data"]["question_count"]


def export(admin, filters: dict) -> dict:
    response = admin.post("/reports/exports", json={**EXPORT, "filters": filters})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def stored_file(db, export_id) -> pathlib.Path:
    record = db.get(ReportExport, uuid.UUID(export_id))
    return get_settings().storage_path / record.artifact.storage_key


def ids_of(db, model, *where) -> list:
    return list(db.scalars(select(model.id).where(*where)))


# ---------- The full deletion ----------


def test_deleting_an_assessed_training_removes_its_records_and_keeps_everything_shared(world, db, client_for):
    t1 = world.training("T1", max_attempts=2)
    t2 = world.training("T2")
    shared = db.scalar(select(Question).where(Question.question_code == "T1-Q01"))
    link(db, shared, t2)  # Also used by T2: must stay linked there.
    imported = world.question(t1, "IMP-001")  # A question imported for T1's post-test only, with a revision.
    db.execute(QuestionTrainingTag.__table__.update().where(QuestionTrainingTag.question_id == imported.id).values(test_type="POST_TEST"))
    db.add(QuestionRevision(question_id=imported.id, version=1, content_snapshot={"question_text": imported.question_text}))
    db.commit()
    t1_questions = ids_of(db, Question, Question.trainings.any(Training.id == t1.id))
    masters = {q: question_master(db, q) for q in t1_questions}
    admin = client_for(world.admin)

    # E1 fails, gives feedback, is authorised and passes. E2 fails twice and is sent to re-training (a new cycle).
    # E3 has a due assessment that blocks the workspace.
    e1, e2, e3 = client_for(world.employee), client_for(world.teammate), client_for(world.outsider)
    o1 = world.complete(world.employee, t1)
    give_feedback(e1, take(db, e1, o1.id, 3)["attempt_id"])
    authorise_reattempt(e1, admin, o1.id)
    assert take(db, e1, o1.id, 9)["result_status"] == "PASSED"
    o2 = world.complete(world.teammate, t1)
    give_feedback(e2, take(db, e2, o2.id, 2)["attempt_id"])
    authorise_reattempt(e2, admin, o2.id)
    assert take(db, e2, o2.id, 2)["needs_retraining"] is True
    assert admin.post(f"/admin/obligations/{o2.id}/retraining-cycle", json={"reason": "Re-training approved"}).status_code == 200
    world.complete(world.outsider, t1)
    assert e3.get("/me/access-state").json()["data"]["access_status"] == "ASSESSMENT_REQUIRED"
    # E1 also has T2 history, which must survive untouched.
    o_t2 = world.complete(world.employee, t2)
    give_feedback(e1, take(db, e1, o_t2.id, 9)["attempt_id"])
    assert admin.post(f"/admin/trainings/{t1.id}/materials", json={"kind": "LINK", "title": "Deck", "url": "https://example.com/deck"}).status_code == 200

    # Reports: filtered to T1, filtered to T1's batch, and a global one. Schedules likewise.
    batch = db.scalar(select(TrainingBatch).where(TrainingBatch.training_id == t1.id))
    by_training, by_batch, overall = export(admin, {"training_id": str(t1.id)}), export(admin, {"batch_id": str(batch.id)}), export(admin, {})
    t2_export = export(admin, {"training_id": str(t2.id)})
    files = {key: stored_file(db, record["id"]) for key, record in {"training": by_training, "batch": by_batch, "overall": overall, "t2": t2_export}.items()}
    assert all(path.exists() for path in files.values())
    schedule = {"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}
    t1_schedule = admin.post("/reports/schedules", json={**schedule, "filters": {"training_id": str(t1.id)}}).json()["data"]
    kept_schedule = admin.post("/reports/schedules", json=schedule).json()["data"]

    # Import records: a question import for T1 (exclusive) and a completion import (may name several trainings).
    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == world.admin.id))
    question_import = ImportJob(import_type="QUESTIONS", uploaded_by=account.id, file_name="t1.csv", status="COMPLETED", created_at=NOW, training_id=t1.id, test_type="POST_TEST")
    completion_import = ImportJob(import_type="COMPLETIONS", uploaded_by=account.id, file_name="all.csv", status="COMPLETED", created_at=NOW)
    db.add_all([question_import, completion_import])
    db.flush()
    db.add(ImportJobRow(import_job_id=completion_import.id, row_number=2, row_status="IMPORTED", payload={"training_id": str(t1.id)}))
    db.commit()

    # Everything that belongs to T1, captured before the deletion.
    enrolments = ids_of(db, Enrolment, Enrolment.training_id == t1.id)
    obligations = ids_of(db, AssessmentObligation, AssessmentObligation.training_id == t1.id)
    attempts = ids_of(db, AssessmentAttempt, AssessmentAttempt.training_id == t1.id)
    attempt_questions = ids_of(db, AttemptQuestion, AttemptQuestion.attempt_id.in_(attempts))
    t1_ids = {str(i) for i in [t1.id, *enrolments, *obligations, *attempts]}
    assert len(attempts) == 4 and count(db, AttemptAnswer, AttemptAnswer.attempt_question_id.in_(attempt_questions)) > 0
    assert count(db, Notification) > 0
    t2_rows = {model: count(db, model, model.training_id == t2.id) for model in (Enrolment, AssessmentObligation, AssessmentAttempt, AssessmentFeedback, QuestionTrainingTag)}
    t2_attempts = ids_of(db, AssessmentAttempt, AssessmentAttempt.training_id == t2.id)
    t2_snapshots = count(db, AttemptQuestion, AttemptQuestion.attempt_id.in_(t2_attempts))
    kept = {model: count(db, model) for model in (Employee, UserAccount, UserRole, Department, Function, Competency, Question, QuestionOption, QuestionAnswerKey, QuestionRevision)}

    preview = admin.get(f"/admin/trainings/{t1.id}/deletion-preview")
    assert preview.status_code == 200, preview.text
    counts = preview.json()["data"]["counts"]
    assert preview.json()["data"]["training"]["code"] == "T1"
    assert {k: counts[k] for k in ("assignments", "completions", "assessments", "attempts", "submitted_attempts", "feedback", "batches", "materials")} == {
        "assignments": 3, "completions": 3, "assessments": 3, "attempts": 4, "submitted_attempts": 4, "feedback": 2, "batches": 1, "materials": 1,
    }
    assert (counts["question_links"], counts["questions_becoming_unassigned"]) == (11, 10)
    assert (counts["question_imports"], counts["report_exports"], counts["report_schedules"]) == (1, 2, 1)
    assert counts["notifications"] > 0

    response = admin.delete(f"/admin/trainings/{t1.id}", json={"confirmation_code": "t1"})  # Not case-sensitive.
    assert response.status_code == 200, response.text
    body = response.json()["data"]
    assert body["counts"] == counts and body["training"]["title"] == "Training T1" and body["files_pending_removal"] == 0

    db.expunge_all()  # Fresh reads from here; the instances already loaded keep their IDs.
    # Gone: the training and every record of it.
    assert not exists(db, Training, t1.id)
    for model in (Enrolment, AssessmentObligation, AssessmentAttempt, AssessmentFeedback, AssessmentConfig, TrainingBatch, TrainingMaterial, QuestionTrainingTag):
        assert count(db, model, model.training_id == t1.id) == 0, model.__name__
    assert count(db, TrainingCompletion, TrainingCompletion.enrolment_id.in_(enrolments)) == 0
    assert count(db, AttemptQuestion, AttemptQuestion.id.in_(attempt_questions)) == 0
    assert count(db, AttemptAnswer, AttemptAnswer.attempt_question_id.in_(attempt_questions)) == 0
    assert count(db, AttemptSecurityEvent, AttemptSecurityEvent.attempt_id.in_(attempts)) == 0
    notes = db.execute(select(Notification.link, Notification.dedupe_key)).all()
    assert not [n for n in notes if any(i in f"{n.link} {n.dedupe_key}" for i in t1_ids)]
    assert any(str(o_t2.id) in (n.dedupe_key or "") for n in notes)  # T2's notifications stay.
    assert not exists(db, ImportJob, question_import.id)
    assert exists(db, ImportJob, completion_import.id) and count(db, ImportJobRow, ImportJobRow.import_job_id == completion_import.id) == 1
    assert {str(i) for i in ids_of(db, ReportExport)} == {overall["id"], t2_export["id"]}
    assert not files["training"].exists() and not files["batch"].exists()
    assert files["overall"].exists() and files["t2"].exists()
    assert {str(i) for i in ids_of(db, ReportSchedule)} == {kept_schedule["id"]} and t1_schedule["id"] != kept_schedule["id"]

    # Kept: people, master data, every question with its content, options, key and revisions; T2 unchanged.
    assert {model: count(db, model) for model in kept} == kept
    assert {q: question_master(db, q) for q in t1_questions} == masters
    assert {model: count(db, model, model.training_id == t2.id) for model in t2_rows} == t2_rows
    assert count(db, AttemptQuestion, AttemptQuestion.attempt_id.in_(t2_attempts)) == t2_snapshots
    assert set(db.scalars(select(QuestionTrainingTag.training_id).where(QuestionTrainingTag.question_id == shared.id))) == {t2.id}

    # T1's own questions are Unassigned Questions now; the shared one stays under T2.
    expected = sorted([f"T1-Q{i:02d}" for i in range(2, 11)] + ["IMP-001"])
    assert unassigned_codes(admin) == expected and unassigned_count(admin) == 10
    t2_codes = {q["question_code"] for q in admin.get(f"/admin/questions?training_id={t2.id}").json()["data"]}
    assert "T1-Q01" in t2_codes
    assert all(card["training_id"] != str(t1.id) for card in admin.get("/admin/questions/summary").json()["data"])

    # The audit record names the training and what was deleted.
    log = db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_DELETED"))
    assert (log.target_id, log.before_summary["code"], log.before_summary["title"], log.after_summary["counts"]) == (str(t1.id), "T1", "Training T1", counts)

    # Employees: the deleted assessment no longer blocks, its result is gone, the other training stays.
    assert e3.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"
    assert e3.get("/me/assessment-queue").json()["data"] == []
    assert e1.get(f"/attempts/{attempts[0]}/result").status_code == 404
    assert [card["training_id"] for card in e1.get("/me/trainings").json()["data"]] == [str(t2.id)]

    # Repeating the deletion is a clean 404, and links to the training show not found.
    again = admin.delete(f"/admin/trainings/{t1.id}", json=confirm(t1))
    assert again.status_code == 404 and "already" in again.json()["error"]["message"]
    assert admin.get(f"/admin/trainings/{t1.id}").status_code == 404
    assert admin.get(f"/admin/trainings/{t1.id}/deletion-preview").status_code == 404


def test_unused_training_preview_is_empty_and_confirmation_is_checked(world, db, client_for):
    admin = client_for(world.admin)
    created = admin.post("/admin/trainings", json={"title": "Never used", "training_code": "NEW1"}).json()["data"]
    counts = admin.get(f"/admin/trainings/{created['id']}/deletion-preview").json()["data"]["counts"]
    assert set(counts.values()) == {0}
    path = f"/admin/trainings/{created['id']}"
    assert admin.delete(path).status_code == 400
    assert admin.delete(path, json={"confirmation_code": "  "}).status_code == 400
    wrong = admin.delete(path, json={"confirmation_code": "NEW2"})
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "CONFIRMATION_MISMATCH" and "Nothing was deleted" in wrong.json()["error"]["message"]
    assert admin.delete(path, json={"confirmation_code": "NEW1", "extra": 1}).status_code == 400
    for outsider in (world.employee, world.hr):
        assert client_for(outsider).get(f"{path}/deletion-preview").status_code == 403
        assert client_for(outsider).delete(path, json={"confirmation_code": "NEW1"}).status_code == 403
    assert admin.get(path).status_code == 200
    assert admin.delete(path, json={"confirmation_code": " NEW1 "}).status_code == 200
    assert count(db, AuditLog, AuditLog.action == "TRAINING_DELETED") == 1


def test_a_failure_during_deletion_rolls_everything_back(world, db, client_for, monkeypatch):
    training = world.training("T1")
    world.complete(world.employee, training)
    admin = client_for(world.admin)
    file = stored_file(db, export(admin, {"training_id": str(training.id)})["id"])
    before = {model: count(db, model) for model in (Training, Enrolment, AssessmentObligation, QuestionTrainingTag, ReportExport, Notification, Question)}
    real = deletion._notification_ids
    calls: list = []

    def fail_late(session, related):  # The first call counts; the second runs after most rows were deleted.
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("simulated failure during deletion")
        return real(session, related)

    monkeypatch.setattr(deletion, "_notification_ids", fail_late)
    response = admin.delete(f"/admin/trainings/{training.id}", json=confirm(training))
    assert response.status_code == 500 and len(calls) == 2  # Failed after most rows had been deleted.
    db.expire_all()
    assert {model: count(db, model) for model in before} == before
    assert file.exists()  # Files are removed only after a successful commit.
    assert count(db, AuditLog, AuditLog.action == "TRAINING_DELETED") == 0


def test_a_file_that_cannot_be_removed_is_cleaned_up_later(world, db, client_for, monkeypatch):
    training = world.training("T1")
    admin = client_for(world.admin)
    file = stored_file(db, export(admin, {"training_id": str(training.id)})["id"])
    real_unlink = pathlib.Path.unlink

    def locked(self, *args, **kwargs):
        raise PermissionError("file in use")

    monkeypatch.setattr(pathlib.Path, "unlink", locked)
    response = admin.delete(f"/admin/trainings/{training.id}", json=confirm(training))
    assert response.status_code == 200 and response.json()["data"]["files_pending_removal"] == 1
    assert file.exists()
    log = db.scalar(select(AuditLog).where(AuditLog.action == "TRAINING_DELETED"))
    assert log.after_summary["file_keys"] == [file.name]
    monkeypatch.setattr(pathlib.Path, "unlink", real_unlink)
    assert deletion.remove_leftover_files(db) == 1
    assert not file.exists()
    assert deletion.remove_leftover_files(db) == 0  # Idempotent.


# ---------- Concurrency ----------


def _in_thread(call) -> tuple[threading.Thread, dict]:
    outcome: dict = {}

    def run() -> None:
        try:
            outcome["response"] = call()
        except Exception as exc:  # noqa: BLE001 - reported by the test
            outcome["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    return thread, outcome


def test_deletion_waits_for_a_writer_already_holding_the_training(world, db, client_for):
    """A request that is still writing to the training finishes first; its records are then deleted too."""
    training = world.training("T1")
    admin = client_for(world.admin)
    writer = database.session_factory()()
    hold_training(writer, training.id)
    writer.add(Enrolment(training_id=training.id, employee_id=world.teammate.id, assigned_at=NOW))
    writer.flush()
    thread, outcome = _in_thread(lambda: admin.delete(f"/admin/trainings/{training.id}", json=confirm(training)))
    time.sleep(1.5)
    assert thread.is_alive(), "the deletion must wait for the writer"
    writer.commit()
    writer.close()
    thread.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 200, response.text
    assert response.json()["data"]["counts"]["assignments"] == 1
    db.expunge_all()
    assert count(db, Enrolment) == 0 and not exists(db, Training, training.id)


def test_a_busy_training_is_reported_and_not_deleted(world, db, client_for, monkeypatch):
    training = world.training("T1")
    monkeypatch.setattr(deletion, "LOCK_TIMEOUT", text("SET LOCAL lock_timeout = '1s'"))
    writer = database.session_factory()()
    hold_training(writer, training.id)  # A request that does not finish in time.
    try:
        response = client_for(world.admin).delete(f"/admin/trainings/{training.id}", json=confirm(training))
        assert response.status_code == 409 and response.json()["error"]["code"] == "TRAINING_BUSY", response.text
    finally:
        writer.rollback()
        writer.close()
    db.expire_all()
    assert exists(db, Training, training.id)


def test_writers_arriving_during_a_deletion_get_clean_errors_and_leave_nothing(world, db, client_for):
    """While a deletion holds the training, assignment, starting an assessment, linking questions (assign and the
    question form) and adding material wait; once it commits they fail cleanly and nothing is written."""
    training = world.training("T1")
    obligation = world.complete(world.employee, training)
    loose = world.question(training, "LOOSE-1")
    db.execute(QuestionTrainingTag.__table__.delete().where(QuestionTrainingTag.question_id == loose.id))
    db.commit()
    employee = client_for(world.employee)
    admins = [client_for(world.admin) for _ in range(3)]
    questions_before = count(db, Question)
    deleting = database.session_factory()()
    target = deletion.lock_for_deletion(deleting, training.id)
    new_question = {
        "topic": "Topic", "question_type": "MCQ_SINGLE", "question_text": "A brand new question?", "options": ["A", "B"],
        "correct_option_indexes": [0], "difficulty": "EASY", "marks": 1, "training_ids": [str(training.id)],
    }
    calls = {
        "assign": lambda: admins[0].post("/admin/enrolments", json={"training_id": str(training.id), "employee_ids": [str(world.teammate.id)]}),
        "start": lambda: employee.post(f"/assessment-obligations/{obligation.id}/attempts", json={"instructions_acknowledged": True}),
        "link": lambda: admins[1].post("/admin/questions/assign", json={"question_ids": [str(loose.id)], "training_id": str(training.id), "test_type": "POST_TEST"}),
        "create": lambda: admins[2].post("/admin/questions", json=new_question),
    }
    running = {name: _in_thread(call) for name, call in calls.items()}
    time.sleep(1.5)
    assert all(thread.is_alive() for thread, _ in running.values()), "every writer must wait for the deletion"
    account = deleting.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.admin.id))
    deletion.delete_training(deleting, target, account)
    deleting.commit()
    deleting.close()
    statuses = {}
    for name, (thread, outcome) in running.items():
        thread.join(timeout=30)
        assert "error" not in outcome, outcome.get("error")
        statuses[name] = outcome["response"].status_code
    assert statuses == {"assign": 404, "start": 404, "link": 404, "create": 400}
    db.expire_all()
    assert count(db, Enrolment) == 0 and count(db, AssessmentAttempt) == 0 and count(db, QuestionTrainingTag) == 0
    assert count(db, Question) == questions_before  # The refused form created nothing.


def test_answer_saves_and_submission_during_a_deletion_get_a_clean_404(world, db, client_for):
    """An employee is mid-assessment when L&D deletes the training: their save and submit wait for the deletion and
    then get 404 (the attempt is gone), never a server error, and no answer or result is left behind."""
    from tests.conftest import start

    training = world.training("T1")
    obligation = world.complete(world.employee, training)
    saver, submitter = client_for(world.employee), client_for(world.employee)
    attempt = start(saver, obligation.id)
    question = attempt["questions"][0]
    deleting = database.session_factory()()
    target = deletion.lock_for_deletion(deleting, training.id)
    save = _in_thread(lambda: saver.put(f"/attempts/{attempt['attempt_id']}/questions/{question['attempt_question_id']}/answer", json={"selected_option_ids": [question["options"][0]["option_id"]]}))
    done = _in_thread(lambda: submitter.post(f"/attempts/{attempt['attempt_id']}/submit"))
    time.sleep(1.5)
    assert save[0].is_alive() and done[0].is_alive(), "both must wait for the deletion"
    account = deleting.scalar(select(UserAccount.id).where(UserAccount.employee_id == world.admin.id))
    deletion.delete_training(deleting, target, account)
    deleting.commit()
    deleting.close()
    for thread, outcome in (save, done):
        thread.join(timeout=30)
        assert outcome["response"].status_code == 404, outcome["response"].text
    db.expunge_all()
    assert count(db, AssessmentAttempt) == 0 and count(db, AttemptAnswer) == 0 and count(db, Notification) == 0
    assert saver.get("/me/access-state").json()["data"]["access_status"] == "DASHBOARD_ALLOWED"


def test_two_deletions_at_once_delete_once(world, db, client_for):
    training = world.training("T1")
    world.complete(world.employee, training)
    first, second = client_for(world.admin), client_for(world.admin)
    threads = [_in_thread(lambda c=c: c.delete(f"/admin/trainings/{training.id}", json=confirm(training))) for c in (first, second)]
    for thread, _ in threads:
        thread.join(timeout=30)
    assert sorted(outcome["response"].status_code for _, outcome in threads) == [200, 404]
    assert count(db, AuditLog, AuditLog.action == "TRAINING_DELETED") == 1


def test_imports_of_a_deleted_training_are_handled(world, db, client_for):
    """A question import for the training goes with it. A completion import validated before the deletion keeps its
    record; on commit its row for the deleted training is refused with a reason, not a server error."""
    training, other = world.training("T1"), world.training("T2")
    world.enrol(world.teammate, other)
    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == world.admin.id))
    ready = ImportJob(import_type="QUESTIONS", uploaded_by=account.id, file_name="q.csv", status="READY", created_at=NOW, training_id=training.id, test_type="POST_TEST", total_rows=1, accepted_rows=1)
    completions = ImportJob(import_type="COMPLETIONS", uploaded_by=account.id, file_name="c.csv", status="READY", created_at=NOW, total_rows=2, accepted_rows=2)
    db.add_all([ready, completions])
    db.flush()
    for number, (employee, target) in enumerate(((world.employee, training), (world.teammate, other)), start=2):
        payload = {"employee_id": str(employee.id), "training_id": str(target.id), "completion_date": "2026-11-03", "source_event_id": f"EV-{number}", "attendance": "PRESENT"}
        db.add(ImportJobRow(import_job_id=completions.id, row_number=number, row_status="VALID", record_label=employee.employee_code, payload=payload))
    db.commit()
    admin = client_for(world.admin)
    assert world.enrol(world.employee, training)
    assert admin.delete(f"/admin/trainings/{training.id}", json=confirm(training)).status_code == 200
    assert admin.post(f"/admin/imports/{ready.id}/commit").status_code == 404
    response = admin.post(f"/admin/imports/{completions.id}/commit")
    assert response.status_code == 200, response.text
    db.expire_all()
    rows = {r.row_number: r for r in db.scalars(select(ImportJobRow).where(ImportJobRow.import_job_id == completions.id))}
    assert rows[2].row_status == "INVALID" and "deleted" in rows[2].errors[0]["message"]
    assert rows[3].row_status == "IMPORTED"
    assert count(db, TrainingCompletion) == 1


# ---------- Unassigned Questions ----------


def _new_question(admin, code: str, training_ids: list | None = None, status: str = "ACTIVE") -> dict:
    body = {
        "question_code": code, "topic": "Topic", "question_type": "MCQ_SINGLE", "question_text": f"What is {code}?", "options": ["Yes", "No"],
        "correct_option_indexes": [0], "difficulty": "EASY", "marks": 1, "training_ids": [str(t) for t in training_ids or []], "status": status,
    }
    response = admin.post("/admin/questions", json=body)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_unassigned_questions_are_those_with_no_training_link(world, db, client_for):
    active, archived = world.training("T1", questions=0), world.training("T2", questions=0)
    db.execute(Training.__table__.update().where(Training.id == archived.id).values(status="ARCHIVED"))
    db.commit()
    admin = client_for(world.admin)
    _new_question(admin, "FREE-1")
    _new_question(admin, "FREE-2", status="INACTIVE")
    _new_question(admin, "ARCH-1", [archived.id])  # A link to an archived training still counts.
    _new_question(admin, "BOTH-1", [active.id, archived.id])
    unlinked = _new_question(admin, "UNLINK-1", [active.id])
    assert unassigned_codes(admin) == ["FREE-1", "FREE-2"]
    summary = admin.get("/admin/questions/unassigned-summary").json()["data"]
    assert summary == {"question_count": 2, "active": 1, "inactive": 1}

    # Removing the last link in the question form makes it unassigned; it can be read and edited there.
    edit = {
        "topic": "Topic", "question_type": "MCQ_SINGLE", "question_text": "What is UNLINK-1?", "options": ["Yes", "No"],
        "correct_option_indexes": [0], "difficulty": "EASY", "marks": 1, "training_ids": [], "expected_version": unlinked["version"],
    }
    assert admin.patch(f"/admin/questions/{unlinked['id']}", json=edit).status_code == 200
    assert unassigned_codes(admin) == ["FREE-1", "FREE-2", "UNLINK-1"] and unassigned_count(admin) == 3
    preview = admin.get(f"/admin/questions/{unlinked['id']}").json()["data"]
    assert preview["trainings"] == [] and len(preview["options"]) == 2
    edited = admin.patch(f"/admin/questions/{unlinked['id']}", json={**edit, "question_text": "What is UNLINK-1 now?", "expected_version": preview["version"]})
    assert edited.status_code == 200 and edited.json()["data"]["version"] == preview["version"] + 1
    assert unassigned_codes(admin) == ["FREE-1", "FREE-2", "UNLINK-1"]

    # Server-side filters narrow the unassigned list; a training filter is refused.
    assert unassigned_codes(admin, "&status=INACTIVE") == ["FREE-2"]
    assert unassigned_codes(admin, "&search=UNLINK") == ["UNLINK-1"]
    assert admin.get(f"/admin/questions?unassigned=true&training_id={active.id}").status_code == 400
    assert client_for(world.employee).get("/admin/questions?unassigned=true").status_code == 403
    assert client_for(world.employee).get("/admin/questions/unassigned-summary").status_code == 403


# ---------- Assigning questions to a training's test ----------


def test_assigning_single_and_bulk_questions_to_pre_and_post_tests(world, db, client_for):
    training, other = world.training("T1", questions=0), world.training("T2", questions=0)
    admin = client_for(world.admin)
    single, bulk, inactive = _new_question(admin, "U-1"), _new_question(admin, "U-2"), _new_question(admin, "U-3", status="INACTIVE")
    legacy = _new_question(admin, "U-4", [training.id])  # An unclassified (legacy) link serves both tests.
    elsewhere = _new_question(admin, "U-5", [other.id])
    masters = {q["id"]: question_master(db, uuid.UUID(q["id"])) for q in (single, bulk, inactive, legacy, elsewhere)}
    questions = count(db, Question)
    assert unassigned_count(admin) == 3

    def assign(ids: list[str], test_type: str, training_id=training.id):
        response = admin.post("/admin/questions/assign", json={"question_ids": ids, "training_id": str(training_id), "test_type": test_type})
        assert response.status_code == 200, response.text
        return response.json()["data"]

    one = assign([single["id"]], "PRE_TEST")
    assert one["summary"]["ASSIGNED"] == 1 and one["results"][0]["status"] == "ASSIGNED" and one["test_type"] == "PRE_TEST"
    pre = {q["question_code"] for q in admin.get(f"/admin/questions?training_id={training.id}&test_type=PRE_TEST").json()["data"]}
    post = {q["question_code"] for q in admin.get(f"/admin/questions?training_id={training.id}&test_type=POST_TEST").json()["data"]}
    assert "U-1" in pre and "U-1" not in post

    missing = str(uuid.uuid4())
    result = assign([bulk["id"], inactive["id"], single["id"], legacy["id"], elsewhere["id"], missing, bulk["id"]], "POST_TEST")
    outcome = {r["question_code"] or r["question_id"]: (r["status"], r["test_type"], bool(r["warning"])) for r in result["results"]}
    assert outcome == {
        "U-2": ("ASSIGNED", "POST_TEST", False),
        "U-3": ("ASSIGNED", "POST_TEST", True),  # Linked, still Inactive, with a warning that it will not be drawn.
        "U-1": ("OTHER_TEST", "PRE_TEST", False),  # Kept as the pre-test link; not reported as assigned.
        "U-4": ("ALREADY_ASSIGNED", None, False),  # The legacy link already serves the post-test; unchanged.
        "U-5": ("ASSIGNED", "POST_TEST", False),  # Its link to T2 stays.
        missing: ("NOT_FOUND", None, False),
    }
    assert len(result["results"]) == 6  # The repeated ID is reported once.
    assert result["summary"] == {"ASSIGNED": 3, "ALREADY_ASSIGNED": 1, "OTHER_TEST": 1, "NOT_FOUND": 1, "NOT_DRAWN": 1}
    assert "not be drawn" in next(r for r in result["results"] if r["question_code"] == "U-3")["warning"]

    db.expire_all()
    links = {(str(q), str(t)): kind for q, t, kind in db.execute(select(QuestionTrainingTag.question_id, QuestionTrainingTag.training_id, QuestionTrainingTag.test_type))}
    assert links == {
        (single["id"], str(training.id)): "PRE_TEST",
        (bulk["id"], str(training.id)): "POST_TEST",
        (inactive["id"], str(training.id)): "POST_TEST",
        (legacy["id"], str(training.id)): None,
        (elsewhere["id"], str(training.id)): "POST_TEST",
        (elsewhere["id"], str(other.id)): None,
    }
    assert count(db, Question) == questions  # Links only: no copy was made.
    assert {q: question_master(db, uuid.UUID(q)) for q in masters} == masters  # Content, status and revisions intact.
    assert unassigned_count(admin) == 0 and unassigned_codes(admin) == []

    # The training's cards and pool: the inactive question is listed but never drawn.
    cards = {c["test_type"]: c for c in admin.get("/admin/questions/summary").json()["data"] if c["training_id"] == str(training.id)}
    assert (cards["PRE_TEST"]["question_count"], cards["POST_TEST"]["question_count"], cards["POST_TEST"]["inactive"]) == (2, 4, 1)
    pool = admin.get(f"/admin/trainings/{training.id}/question-pool?assessment_type=POST_TEST").json()["data"]
    assert pool["eligible"] == 3

    # A repeat changes nothing.
    again = assign([bulk["id"]], "POST_TEST")
    assert again["results"][0]["status"] == "ALREADY_ASSIGNED" and count(db, QuestionTrainingTag) == len(links)
    assert count(db, AuditLog, AuditLog.action == "QUESTIONS_ASSIGNED") == 3


def test_assignment_is_refused_cleanly_for_unavailable_trainings_and_non_admins(world, db, client_for):
    training = world.training("T1", questions=0)
    admin = client_for(world.admin)
    question = _new_question(admin, "U-1")
    body = {"question_ids": [question["id"]], "training_id": str(training.id), "test_type": "POST_TEST"}
    assert client_for(world.employee).post("/admin/questions/assign", json=body).status_code == 403
    assert admin.post("/admin/questions/assign", json={**body, "question_ids": []}).status_code == 400
    assert admin.post("/admin/questions/assign", json={**body, "test_type": "MID_TEST"}).status_code == 400
    assert admin.post("/admin/questions/assign", json={**body, "question_ids": ["not-an-id"]}).status_code == 400
    gone = admin.post("/admin/questions/assign", json={**body, "training_id": str(uuid.uuid4())})
    assert gone.status_code == 404 and "no longer exists" in gone.json()["error"]["message"]
    db.execute(Training.__table__.update().where(Training.id == training.id).values(status="ARCHIVED"))
    db.commit()
    archived = admin.post("/admin/questions/assign", json=body)
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "TRAINING_NOT_IMPORTABLE"
    assert count(db, QuestionTrainingTag) == 0 and unassigned_count(admin) == 1


def test_assignment_keeps_links_added_concurrently_and_never_duplicates(world, db, client_for):
    """Another request links the same question to this training (and to another one) at the same moment. The assign
    waits for it, adds no duplicate, reports the link that exists, and the other training's link is kept."""
    training, other = world.training("T1", questions=0), world.training("T2", questions=0)
    admin = client_for(world.admin)
    question = _new_question(admin, "U-1")
    concurrent = database.session_factory()()
    concurrent.add_all([QuestionTrainingTag(question_id=uuid.UUID(question["id"]), training_id=training.id, test_type="POST_TEST"), QuestionTrainingTag(question_id=uuid.UUID(question["id"]), training_id=other.id, test_type=None)])
    concurrent.flush()
    thread, outcome = _in_thread(lambda: admin.post("/admin/questions/assign", json={"question_ids": [question["id"]], "training_id": str(training.id), "test_type": "POST_TEST"}))
    time.sleep(1.5)
    assert thread.is_alive(), "the assignment must wait for the uncommitted link"
    concurrent.commit()
    concurrent.close()
    thread.join(timeout=30)
    response = outcome["response"]
    assert response.status_code == 200, response.text
    assert response.json()["data"]["results"][0]["status"] == "ALREADY_ASSIGNED"
    db.expire_all()
    assert count(db, QuestionTrainingTag) == 2


def test_assign_and_unassigned_routes_are_not_read_as_question_ids(world, db, client_for):
    admin = client_for(world.admin)
    assert admin.get("/admin/questions/unassigned-summary").status_code == 200
    assert admin.post("/admin/questions/assign", json={}).status_code == 400  # Validated as an assignment.
    assert admin.get("/admin/questions/assign").status_code in (400, 404, 405)
