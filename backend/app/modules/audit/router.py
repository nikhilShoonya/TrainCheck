"""Read-only audit log, the L&D dashboard and scoped search."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_admin, require_gate_clear, require_withdrawn
from app.core.enums import AssessmentType, ImportStatus, RoleCode, TrainingStatus
from app.core.responses import iso, ok
from app.models import AssessmentConfig, AuditLog, Employee, ImportJob, Training, UserAccount
from app.modules.assessment.service import PoolData, pool_problem
from app.modules.reports.data import departments_summary, load_rows, monthly_trend, summary

router = APIRouter(tags=["Administration"])


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
    """Scoped search. L&D Admin searches the organisation; an employee finds only assigned training."""
    scope = None if user.has_role(RoleCode.LD_ADMIN) else [user.employee_id]
    needle = q.lower()
    seen: dict[str, dict] = {}
    for r in load_rows(db, scope):
        title = r.enrolment.training.title
        if needle in title.lower():
            seen.setdefault(title, {"type": "training", "title": title, "subtitle": r.enrolment.training.category})
        employee = r.enrolment.employee
        if employee.id != user.employee_id and (needle in employee.full_name.lower() or needle in employee.employee_code.lower()):
            seen.setdefault(employee.employee_code, {"type": "employee", "title": employee.full_name, "subtitle": employee.employee_code, "employee_id": str(employee.id)})
    return ok(list(seen.values())[:20])
