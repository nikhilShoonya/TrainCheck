"""Departments & Functions page: delete (and competency edit). A record is deleted only when nothing uses it; one still
used by employees, trainings, questions or behaviour data is refused with where it is used, and nothing changes."""
import pytest
from sqlalchemy import select

from app.models import AuditLog, Competency, Department, Function, Trainer, TrainingDepartment, TrainingFunction


def test_unused_department_and_function_are_deleted_and_audited(world, db, client_for):
    admin = client_for(world.admin)
    department = admin.post("/admin/departments", json={"code": "TMP", "name": "Temporary"}).json()["data"]
    function = admin.post("/admin/functions", json={"name": "Temporary function"}).json()["data"]

    assert admin.delete(f"/admin/departments/{department['id']}").json()["data"] == {"deleted": True}
    assert admin.delete(f"/admin/functions/{function['id']}").json()["data"] == {"deleted": True}
    db.expire_all()
    assert db.get(Department, department["id"]) is None and db.get(Function, function["id"]) is None
    assert all(d["id"] != department["id"] for d in admin.get("/admin/departments").json()["data"])
    actions = set(db.scalars(select(AuditLog.action)))
    assert {"DEPARTMENT_DELETED", "FUNCTION_DELETED"} <= actions
    # A second delete finds nothing.
    assert admin.delete(f"/admin/departments/{department['id']}").status_code == 404


def test_department_in_use_is_refused_with_where_it_is_used(world, db, client_for):
    training = world.training()
    db.add(TrainingDepartment(training_id=training.id, department_id=world.departments["OPS"].id))
    db.commit()
    response = client_for(world.admin).delete(f"/admin/departments/{world.departments['OPS'].id}")
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "IN_USE"
    # OPS holds M1, A1, H1, E1 and E2 in the shared test organisation.
    assert error["details"]["usage"] == ["5 employees", "1 training"]
    assert "Mark it inactive instead" in error["message"]
    db.expire_all()
    assert db.get(Department, world.departments["OPS"].id) is not None
    assert db.scalar(select(AuditLog).where(AuditLog.action == "DEPARTMENT_DELETED")) is None


def test_function_used_by_a_training_or_question_is_refused(world, db, client_for):
    unused_by_people = Function(code="LEGAL", name="Legal")
    db.add(unused_by_people)
    db.flush()
    training = world.training()
    db.add(TrainingFunction(training_id=training.id, function_id=unused_by_people.id))
    question = world.question(training, "T1-QX")
    question.function_id = unused_by_people.id
    db.commit()
    response = client_for(world.admin).delete(f"/admin/functions/{unused_by_people.id}")
    assert response.status_code == 409 and response.json()["error"]["details"]["usage"] == ["1 training", "1 question"]


def test_trainer_delete_only_when_no_training_uses_it(world, db, client_for):
    admin = client_for(world.admin)
    world.training()  # Uses world.trainer.
    refused = admin.delete(f"/admin/trainers/{world.trainer.id}")
    assert refused.status_code == 409 and refused.json()["error"]["details"]["usage"] == ["1 training"]
    spare = admin.post("/admin/trainers", json={"name": "Spare Trainer"}).json()["data"]
    assert admin.delete(f"/admin/trainers/{spare['id']}").status_code == 200
    db.expire_all()
    assert db.get(Trainer, spare["id"]) is None and db.get(Trainer, world.trainer.id) is not None


def test_competency_can_be_edited_and_deleted_when_unused(world, db, client_for):
    admin = client_for(world.admin)
    created = admin.post("/admin/competencies", json={"name": "Listens actively", "description": "Old"}).json()["data"]
    edited = admin.patch(f"/admin/competencies/{created['id']}", json={"name": "Listens carefully", "description": "", "is_active": False})
    assert edited.status_code == 200, edited.text
    assert (edited.json()["data"]["name"], edited.json()["data"]["description"], edited.json()["data"]["is_active"]) == ("Listens carefully", None, False)
    duplicate = admin.patch(f"/admin/competencies/{created['id']}", json={"name": world.competency.name})
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "DUPLICATE_NAME"
    assert admin.delete(f"/admin/competencies/{created['id']}").status_code == 200

    world.training()  # Its questions use world.competency.
    in_use = admin.delete(f"/admin/competencies/{world.competency.id}")
    assert in_use.status_code == 409 and in_use.json()["error"]["details"]["usage"] == ["10 questions"]
    db.expire_all()
    assert db.get(Competency, world.competency.id) is not None


@pytest.mark.parametrize("path", ["departments", "functions", "trainers", "competencies"])
def test_only_l_and_d_admins_delete(world, db, client_for, path):
    record = {"departments": world.departments["CX"], "functions": world.functions["SALES"], "trainers": world.trainer, "competencies": world.competency}[path]
    assert client_for(world.employee).delete(f"/admin/{path}/{record.id}").status_code == 403
    assert client_for(world.admin).delete(f"/admin/{path}/3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b").status_code == 404
    db.expire_all()
    assert db.get(type(record), record.id) is not None
