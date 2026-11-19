"""Training Completion by training: the card counts and the per-training employee table.

The L&D page lists trainings as cards (counts from GET /admin/trainings, one request for every card) and opens one
training's employees (GET /admin/enrolments?training_id=). Attendance, completion and waiver act on one enrolment
only, even when the employee is assigned to several trainings. Reads and writes are L&D-only. SCR-LND-006, TC-RBAC-006.
"""
import uuid

from tests.conftest import NOW, ApiClient


def _cards(admin) -> dict[str, dict]:
    response = admin.get("/admin/trainings")
    assert response.status_code == 200, response.text
    return {t["id"]: t for t in response.json()["data"]}


def _rows(admin, training) -> list[dict]:
    response = admin.get(f"/admin/enrolments?training_id={training.id}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _row(admin, training, enrolment) -> dict:
    return next(r for r in _rows(admin, training) if r["id"] == str(enrolment.id))


def test_cards_count_assigned_recorded_and_awaiting_per_training(world, client_for):
    first, second, empty = world.training("T1"), world.training("T2"), world.training("T3")
    world.complete(world.employee, first)  # Completion recorded.
    world.enrol(world.teammate, first)  # Awaiting completion.
    cancelled = world.enrol(world.outsider, first)
    world.enrol(world.employee, second)  # The same employee, also assigned to a second training.
    admin = client_for(world.admin)
    assert admin.post(f"/admin/enrolments/{cancelled.id}/cancel", json={"reason": "Assigned by mistake"}).status_code == 200

    cards = _cards(admin)
    # A cancelled assignment is not counted, exactly as it is not listed in the training's table.
    assert (cards[str(first.id)]["assigned_count"], cards[str(first.id)]["completed_count"]) == (2, 1)
    assert (cards[str(second.id)]["assigned_count"], cards[str(second.id)]["completed_count"]) == (1, 0)
    assert (cards[str(empty.id)]["assigned_count"], cards[str(empty.id)]["completed_count"]) == (0, 0)
    # Each card's numbers equal what its table shows.
    for training in (first, second, empty):
        rows = _rows(admin, training)
        card = cards[str(training.id)]
        assert card["assigned_count"] == len(rows)
        assert card["completed_count"] == sum(1 for r in rows if r["completed_at"])


def test_training_search_finds_by_name(world, client_for):
    world.training("T1")
    world.training("T2")
    admin = client_for(world.admin)
    found = admin.get("/admin/trainings?search=training t2").json()["data"]
    assert [t["title"] for t in found] == ["Training T2"]
    assert admin.get("/admin/trainings?search=no such programme").json()["data"] == []


def test_a_training_lists_only_its_assigned_employees(world, client_for):
    first, second, empty = world.training("T1"), world.training("T2"), world.training("T3")
    in_first = world.enrol(world.employee, first)
    world.enrol(world.teammate, first)
    in_second = world.enrol(world.employee, second)
    world.enrol(world.outsider, second)
    admin = client_for(world.admin)

    first_rows, second_rows = _rows(admin, first), _rows(admin, second)
    assert {r["training_id"] for r in first_rows} == {str(first.id)}
    assert {r["training_id"] for r in second_rows} == {str(second.id)}
    assert sorted(r["employee_code"] for r in first_rows) == ["E1", "E2"]
    assert sorted(r["employee_code"] for r in second_rows) == ["E1", "E3"]
    # An employee assigned to two trainings appears once in each, with that training's own enrolment.
    assert [r["id"] for r in first_rows if r["employee_code"] == "E1"] == [str(in_first.id)]
    assert [r["id"] for r in second_rows if r["employee_code"] == "E1"] == [str(in_second.id)]
    # A training without employees, and an unknown training, list nobody.
    assert _rows(admin, empty) == []
    assert admin.get(f"/admin/enrolments?training_id={uuid.uuid4()}").json()["data"] == []
    # The employee search works inside one training.
    searched = admin.get(f"/admin/enrolments?training_id={first.id}&search=e2").json()["data"]
    assert [r["employee_code"] for r in searched] == ["E2"]


def test_a_malformed_training_id_is_rejected(world, client_for):
    assert client_for(world.admin).get("/admin/enrolments?training_id=not-a-training").status_code == 400


def test_attendance_changes_only_the_selected_enrolment(world, client_for):
    first, second = world.training("T1"), world.training("T2")
    in_first, in_second = world.enrol(world.employee, first), world.enrol(world.employee, second)
    admin = client_for(world.admin)

    response = admin.patch(f"/admin/enrolments/{in_first.id}/attendance", json={"attendance_status": "ABSENT"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["id"] == str(in_first.id)
    assert _row(admin, first, in_first)["attendance_status"] == "ABSENT"
    assert _row(admin, second, in_second)["attendance_status"] == "PENDING"


def test_mark_completed_changes_only_the_selected_enrolment(world, client_for):
    first, second = world.training("T1"), world.training("T2")
    in_first, in_second = world.enrol(world.employee, first), world.enrol(world.employee, second)
    admin = client_for(world.admin)

    done = admin.post(f"/admin/enrolments/{in_second.id}/completion", json={"completion_date": str(NOW.date()), "attendance_status": "PRESENT"})
    assert done.status_code == 200, done.text
    assert done.json()["data"]["assessment_scheduling"]["status"] == "SCHEDULED"

    second_row, first_row = _row(admin, second, in_second), _row(admin, first, in_first)
    assert second_row["completed_at"] and second_row["obligation_id"]
    assert first_row["completed_at"] is None and first_row["obligation_id"] is None
    assert (first_row["attendance_status"], first_row["assessment_state"]) == ("PENDING", "Awaiting completion")
    cards = _cards(admin)
    assert cards[str(second.id)]["completed_count"] == 1
    assert cards[str(first.id)]["completed_count"] == 0


def test_waive_changes_only_the_selected_enrolment(world, client_for):
    first, second = world.training("T1"), world.training("T2")
    waived, kept = world.complete(world.employee, first), world.complete(world.employee, second)
    admin = client_for(world.admin)
    in_first = next(r for r in _rows(admin, first) if r["employee_code"] == "E1")
    in_second = next(r for r in _rows(admin, second) if r["employee_code"] == "E1")
    assert (in_first["obligation_id"], in_second["obligation_id"]) == (str(waived.id), str(kept.id))

    response = admin.post(f"/admin/obligations/{waived.id}/waive", json={"reason": "Exempt: equivalent certification on file"})
    assert response.status_code == 200, response.text
    after_first = next(r for r in _rows(admin, first) if r["employee_code"] == "E1")
    after_second = next(r for r in _rows(admin, second) if r["employee_code"] == "E1")
    assert after_first["assessment_state"] == "Waived"
    assert after_first["outcome"] != "PASSED"  # A waiver is never a pass.
    assert after_second["assessment_state"] == in_second["assessment_state"] == "Due"
    # Waiving the assessment does not change training completion.
    assert after_first["completed_at"] == in_first["completed_at"]


def test_completion_reads_and_writes_are_ld_only(world, client_for):
    training = world.training("T1")
    enrolment = world.enrol(world.teammate, training)
    obligation = world.complete(world.employee, training)
    reads = ["/admin/trainings", f"/admin/enrolments?training_id={training.id}"]

    employee = client_for(world.teammate)  # Not L&D, though assigned to this very training (and nothing due).
    for path in reads:
        assert employee.get(path).status_code == 403, path
    assert employee.patch(f"/admin/enrolments/{enrolment.id}/attendance", json={"attendance_status": "PRESENT"}).status_code == 403
    assert employee.post(f"/admin/enrolments/{enrolment.id}/completion", json={"completion_date": str(NOW.date())}).status_code == 403
    assert employee.post(f"/admin/obligations/{obligation.id}/waive", json={"reason": "Trying my luck"}).status_code == 403

    anonymous = ApiClient()
    for path in reads:
        assert anonymous.get(path).status_code == 401, path

    # Nothing changed.
    admin = client_for(world.admin)
    row = _row(admin, training, enrolment)
    assert (row["attendance_status"], row["completed_at"]) == ("PENDING", None)
    assert next(r for r in _rows(admin, training) if r["employee_code"] == "E1")["assessment_state"] == "Due"
