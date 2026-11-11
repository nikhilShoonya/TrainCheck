"""Authentication, CSRF, role checks and the assessment gate, used by every router.

Route classes:
- `require_session`: signed in. Only for the explicit gate-exempt allowlist.
- `require_gate_clear`: signed in AND no blocking assessment. Every other route must use it.
`tests/test_gate.py` walks the whole route table to prove nothing is missed.
"""
import uuid
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.db import get_db
from app.core.enums import AccountStatus, EmploymentStatus, RoleCode
from app.core.errors import ApiError, forbidden
from app.core.security import hash_token
from app.models import Employee, ManagerAssignment, UserAccount, UserRole, UserSession

SESSION_COOKIE = "tc_session"
CSRF_COOKIE = "tc_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
PRIMARY_ROLE_ORDER = [RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY, RoleCode.MANAGER, RoleCode.EMPLOYEE]


@dataclass
class CurrentUser:
    account: UserAccount
    employee: Employee
    session: UserSession
    roles: set[str]

    @property
    def id(self) -> uuid.UUID:
        return self.account.id

    @property
    def employee_id(self) -> uuid.UUID:
        return self.employee.id

    @property
    def primary_role(self) -> str:
        return next((r.value for r in PRIMARY_ROLE_ORDER if r.value in self.roles), RoleCode.EMPLOYEE.value)

    def has_role(self, *codes: str) -> bool:
        return bool(self.roles.intersection(codes))


def client_ip(request: Request) -> str | None:
    """The verified client address, resolved through TRUSTED_PROXIES (never a raw forwarded header)."""
    from app.core.ratelimit import client_ip_for

    return client_ip_for(request)


def require_session(request: Request, db: Session = Depends(get_db)) -> CurrentUser:
    token = request.cookies.get(SESSION_COOKIE)
    unauthenticated = ApiError(401, "UNAUTHENTICATED", "Please sign in again.")
    if not token:
        raise unauthenticated
    session = db.scalar(select(UserSession).where(UserSession.session_token_hash == hash_token(token)))
    now = utcnow()
    settings = get_settings()
    if session is None or session.revoked_at is not None or session.expires_at <= now:
        raise unauthenticated
    if session.last_seen_at + timedelta(minutes=settings.session_idle_minutes) <= now:
        session.revoked_at = now
        db.commit()
        raise unauthenticated

    account = db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.employee), joinedload(UserAccount.role_links).joinedload(UserRole.role))
        .where(UserAccount.id == session.user_account_id)
    )
    if (
        account is None
        or account.account_status != AccountStatus.ACTIVE
        or account.employee.employment_status == EmploymentStatus.INACTIVE
    ):
        raise unauthenticated

    if request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != session.csrf_token:
        raise ApiError(403, "CSRF_FAILED", "Your session needs refreshing. Reload the page and try again.")

    if now - session.last_seen_at > timedelta(seconds=60):  # Avoid a database write on every request.
        session.last_seen_at = now
        db.commit()

    return CurrentUser(account, account.employee, session, {link.role.code for link in account.role_links})


def require_gate_clear(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> CurrentUser:
    from app.modules.assessment.gate import blocking_obligations  # Imported here to avoid an import cycle.

    if blocking_obligations(db, user.employee_id):
        raise ApiError(403, "ASSESSMENT_REQUIRED", "Complete your pending assessment before opening this page.")
    return user


def require_roles(*codes: RoleCode):
    """Role check on top of the gate. Enforced on the server; navigation is only a convenience."""
    allowed = {c.value for c in codes}

    def dependency(user: CurrentUser = Depends(require_gate_clear)) -> CurrentUser:
        if not user.roles.intersection(allowed):
            raise forbidden()
        return user

    return dependency


require_admin = require_roles(RoleCode.LD_ADMIN)
require_manager = require_roles(RoleCode.MANAGER)
require_reader = require_roles(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY)  # Organisation-wide read scope.
require_report_user = require_roles(RoleCode.LD_ADMIN, RoleCode.HR_READ_ONLY, RoleCode.MANAGER)


def team_employee_ids(db: Session, manager_employee_id: uuid.UUID) -> list[uuid.UUID]:
    """A manager's current team, always resolved here from effective-dated records."""
    today = utcnow().date()
    return list(
        db.scalars(
            select(ManagerAssignment.employee_id).where(
                ManagerAssignment.manager_employee_id == manager_employee_id,
                ManagerAssignment.effective_from <= today,
                (ManagerAssignment.effective_to.is_(None)) | (ManagerAssignment.effective_to >= today),
            )
        )
    )


def current_manager_id(db: Session, employee_id: uuid.UUID) -> uuid.UUID | None:
    today = utcnow().date()
    return db.scalar(
        select(ManagerAssignment.manager_employee_id).where(
            ManagerAssignment.employee_id == employee_id,
            ManagerAssignment.effective_from <= today,
            (ManagerAssignment.effective_to.is_(None)) | (ManagerAssignment.effective_to >= today),
        )
    )
