"""Scheduled jobs (audit F-11): one bad record never stops the rest, and two backend processes never do a job twice."""
from datetime import timedelta

from sqlalchemy import func, select

from app.core import db as database
from app.models import AssessmentAttempt, ReportDelivery, ReportExport, ReportSchedule
from app.modules.scheduler import jobs
from tests.conftest import NOW, start


def test_one_attempt_that_cannot_be_finalised_does_not_stop_the_others(world, db, client_for, monkeypatch):
    first = world.complete(world.employee, world.training("T1"))
    second = world.complete(world.teammate, world.training("T2"))
    broken = start(client_for(world.employee), first.id)["attempt_id"]
    healthy = start(client_for(world.teammate), second.id)["attempt_id"]
    real = jobs.finalise_attempt

    def finalise(session, attempt_id, **kwargs):
        if str(attempt_id) == broken:
            raise RuntimeError("simulated corrupt attempt")
        return real(session, attempt_id, **kwargs)

    monkeypatch.setattr(jobs, "finalise_attempt", finalise)
    assert jobs.finalise_expired(db, NOW + timedelta(hours=2)) == 1
    db.expire_all()
    assert db.get(AssessmentAttempt, healthy).status == "TIMED_OUT"
    assert db.get(AssessmentAttempt, broken).status == "IN_PROGRESS"  # Left for the next run; logged meanwhile.


def test_a_schedule_claimed_by_another_process_is_not_delivered_twice(world, db, client_for, monkeypatch):
    from app.modules.reports import router as reports

    admin = client_for(world.admin)
    created = admin.post("/reports/schedules", json={"report_code": "pass-fail", "export_format": "CSV", "cadence": "WEEKLY"}).json()["data"]
    later = NOW + timedelta(days=8)
    real_next_run = reports.next_run

    def other_process_claims_first(cadence, after):
        # Between this process reading the due schedule and claiming it, the other process claims and delivers it.
        other = database.session_factory()()
        row = other.get(ReportSchedule, created["id"])
        if row.next_run_at <= later:
            row.next_run_at = real_next_run(cadence, row.next_run_at)
            other.commit()
        other.close()
        return real_next_run(cadence, after)

    monkeypatch.setattr(reports, "next_run", other_process_claims_first)
    assert reports.run_due_schedules(db, later) == 0
    assert db.scalar(select(func.count()).select_from(ReportExport)) == 0
    assert db.scalar(select(func.count()).select_from(ReportDelivery)) == 0


def test_an_attempt_that_cannot_be_finalised_does_not_break_the_employees_pages(world, db, client_for, monkeypatch):
    """The gate finalises expired attempts on every request; a failing one is logged and skipped, not fatal."""
    from app.core import clock
    from app.core.errors import ApiError
    from app.modules.assessment import service

    obligation = world.complete(world.employee, world.training())
    client = client_for(world.employee)
    start(client, obligation.id)

    def cannot(*_args, **_kwargs):
        raise ApiError(422, "QUESTION_POOL_INSUFFICIENT", "This attempt has no valid marks. Contact L&D.")

    monkeypatch.setattr(service, "finalise_attempt", cannot)
    clock.freeze(NOW + timedelta(hours=2))
    client = client_for(world.employee)
    assert client.get("/me/access-state").status_code == 200
    assert client.get("/me/assessment-queue").status_code == 200
