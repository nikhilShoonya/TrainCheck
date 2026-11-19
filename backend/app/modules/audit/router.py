"""Read-only audit log, the L&D dashboard and scoped search."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_gate_clear, require_withdrawn
from app.core.enums import AssessmentType, EnrolmentStatus, ImportStatus, RoleCode, TrainingStatus
from app.core.responses import iso, ok
from app.core.routing import ReleasingRoute
from app.models import AssessmentConfig, AuditLog, Employee, Enrolment, ImportJob, Training, UserAccount
from app.modules.assessment.service import PoolData, pool_problem
from app.modules.reports.data import departments_summary, load_rows, monthly_trend, summary

router = APIRouter(route_class=ReleasingRoute, tags=["Administration"])
SEARCH_LIMIT = 20
LIKE_ESCAPE = "!"


# The Audit Logs reader is withdrawn from L&D Admin. Audit events are still recorded by app.core.audit.
@router.get("/admin/audit-logs")
def audit_logs(_: CurrentUser = Depends(require_withdrawn), db: Session = Depends(get_db), action: str = Query(default="", max_length=80), limit: int = Query(default=200, le=500)) -> dict:
    query = select(AuditLog).options(selectinload(AuditLog.actor).selectinload(UserAccount.employee)).order_by(AuditLog.created_at.desc()).limit(limit)
    if action:
        query = query.where(AuditLog.action.ilike(f"%{action}%"))
    return ok(
        [
            {
                "id": str(a.id),
                "created_at": iso(a.created_at),
                "actor": a.actor.employee.full_name if a.actor else "System",
                "action": a.action,
                "target_type": a.target_type,
                "target_id": a.target_id,
                "reason": a.reason,
                "before": a.before_summary,
                "after": a.after_summary,
                "request_id": a.request_id,
            }
            for a in db.scalars(query)
        ]
    )


@router.get("/admin/dashboard")
def admin_dashboard(_: CurrentUser = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    now = utcnow()
    rows = load_rows(db, None)
    trainings = db.scalars(select(Training).order_by(Training.title)).all()
    groups: dict = {}
    for r in rows:
        groups.setdefault(r.enrolment.training_id, []).append(r)

    recent = []
    needs_setup = 0
    ids = [t.id for t in trainings]
    configs = {c.training_id: c for c in db.scalars(select(AssessmentConfig).where(AssessmentConfig.training_id.in_(ids), AssessmentConfig.assessment_type == AssessmentType.POST_TEST, AssessmentConfig.is_active))} if ids else {}
    pools = PoolData(db, ids)
    for t in trainings:
        config = configs.get(t.id)
        if t.status != TrainingStatus.ACTIVE or config is None or pool_problem(db, config, pools):
            needs_setup += 1
        group = groups.get(t.id, [])
        recent.append({"id": str(t.id), "title": t.title, "status": t.status, "enrolled": len(group), "pass_rate": summary(group)["pass_rate"]})

    open_imports = db.scalars(select(ImportJob).where(ImportJob.status == ImportStatus.READY)).all()
    return ok(
        {
            "total_employees": len(db.scalars(select(Employee.id).where(Employee.employment_status != "INACTIVE")).all()),
            "training_programmes": len(trainings),
            "summary": summary(rows),
            "departments": departments_summary(rows),
            "trend": monthly_trend(rows, now),
            "recent_trainings": recent[:3],
            "completions_awaiting": sum(1 for r in rows if not r.enrolment.completion),
            "import_rows_need_review": sum(j.rejected_rows for j in open_imports),
            "programmes_need_setup": needs_setup,
        }
    )


@router.get("/search")
def search(q: str = Query(min_length=1, max_length=120), user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """Scoped search. L&D Admin searches the organisation; an employee finds only assigned training.

    Two narrow queries over live assignments in scope, instead of loading every enrolment and attempt (audit F-12).
    """
    escaped = q.lower().replace(LIKE_ESCAPE, LIKE_ESCAPE * 2).replace("%", LIKE_ESCAPE + "%").replace("_", LIKE_ESCAPE + "_")
    needle = f"%{escaped}%"  # The search text is matched literally: % and _ are not wildcards.
    live = (Enrolment.enrolment_status != EnrolmentStatus.CANCELLED,)
    scope = () if user.has_role(RoleCode.LD_ADMIN) else (Enrolment.employee_id == user.employee_id,)
    trainings = db.execute(
        select(Training.title, Training.category)
        .join(Enrolment, Enrolment.training_id == Training.id)
        .where(*live, *scope, func.lower(Training.title).like(needle, escape=LIKE_ESCAPE))
        .group_by(Training.title, Training.category)
        .order_by(Training.title)
        .limit(SEARCH_LIMIT)
    ).all()
    people = db.execute(
        select(Employee.id, Employee.full_name, Employee.employee_code)
        .join(Enrolment, Enrolment.employee_id == Employee.id)
        .where(
            *live,
            *scope,
            Employee.id != user.employee_id,
            or_(func.lower(Employee.full_name).like(needle, escape=LIKE_ESCAPE), func.lower(Employee.employee_code).like(needle, escape=LIKE_ESCAPE)),
        )
        .group_by(Employee.id, Employee.full_name, Employee.employee_code)
        .order_by(Employee.full_name)
        .limit(SEARCH_LIMIT)
    ).all()
    results = [{"type": "training", "title": title, "subtitle": category} for title, category in trainings]
    results += [{"type": "employee", "title": name, "subtitle": code, "employee_id": str(employee_id)} for employee_id, name, code in people]
    return ok(results[:SEARCH_LIMIT])
