"""Sign-in, sessions and own account. Gate-exempt routes are the explicit allowlist in BR §5.4."""
import hashlib
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.clock import utcnow
from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import CSRF_COOKIE, SESSION_COOKIE, CurrentUser, client_ip, require_session
from app.core.enums import AccountStatus, EmploymentStatus
from app.core.errors import ApiError, validation
from app.core.responses import ok
from app.core.security import (
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    validate_password_strength,
    verify_password,
)
from app.models import AuthAttempt, UserAccount, UserSession
from app.modules.assessment.gate import access_state, promote_due_retakes

router = APIRouter(prefix="/auth", tags=["Authentication"])

SSO_PROVIDERS = ("google", "microsoft")


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


def _rate_key(email: str, ip: str | None) -> str:
    return hashlib.sha256(f"{email}|{ip}".encode()).hexdigest()


def _account_key(email: str) -> str:
    """One bucket per account across every address, so guessing from many addresses is limited too."""
    return hashlib.sha256(f"{email}|*".encode()).hexdigest()


# Failures from all addresses together that lock an account for the window (per address: LOGIN_MAX_FAILURES).
ACCOUNT_FAILURE_FACTOR = 4


def _set_cookies(response: Response, token: str, csrf: str) -> None:
    settings = get_settings()
    lifetime = settings.session_absolute_hours * 3600
    response.set_cookie(SESSION_COOKIE, token, max_age=lifetime, httponly=True, secure=settings.session_cookie_secure, samesite="lax", path="/")
    # Readable by the page so it can echo the value in the CSRF header. Useless to another site.
    response.set_cookie(CSRF_COOKIE, csrf, max_age=lifetime, httponly=False, secure=settings.session_cookie_secure, samesite="lax", path="/")


def user_payload(user: CurrentUser, db: Session) -> dict:
    e = user.employee
    return {
        "id": str(user.id),
        "employee_id": str(e.id),
        "employee_code": e.employee_code,
        "full_name": e.full_name,
        "email": user.account.login_email,
        "department": e.department.name if e.department else None,
        "function": e.function.name if e.function else None,
        "location": e.location.name if e.location else None,
        "grade": e.grade,
        "roles": sorted(user.roles),
        "primary_role": user.primary_role,
        # Lets the interface hide switched-off workflows. The server still enforces them.
        "features": {"behaviour": get_settings().behaviour_enabled},
    }


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    settings = get_settings()
    email = body.email.strip().lower()
    ip = client_ip(request)
    now = utcnow()
    key = _rate_key(email, ip)
    window_start = now - timedelta(minutes=settings.login_window_minutes)

    account_key = _account_key(email)
    counts = dict(
        db.execute(
            select(AuthAttempt.key_hash, func.count())
            .where(AuthAttempt.key_hash.in_([key, account_key]), AuthAttempt.attempted_at >= window_start)
            .group_by(AuthAttempt.key_hash)
        ).all()
    )
    if counts.get(key, 0) >= settings.login_max_failures or counts.get(account_key, 0) >= settings.login_max_failures * ACCOUNT_FAILURE_FACTOR:
        raise ApiError(429, "RATE_LIMITED", "Too many sign-in attempts. Please wait a few minutes and try again.")

    account = db.scalar(select(UserAccount).where(UserAccount.login_email == email))
    valid = verify_password(account.password_hash if account else None, body.password)
    usable = (
        valid
        and account is not None
        and account.account_status == AccountStatus.ACTIVE
        and account.employee.employment_status != EmploymentStatus.INACTIVE
    )
    if not usable:
        db.add_all([AuthAttempt(key_hash=key, attempted_at=now), AuthAttempt(key_hash=account_key, attempted_at=now)])
        record_audit(db, account.id if account else None, "LOGIN_FAILED", "user_account", account.id if account else None, ip_address=ip)
        db.commit()
        raise ApiError(401, "INVALID_CREDENTIALS", "The email or password is incorrect.")

    if needs_rehash(account.password_hash):
        account.password_hash = hash_password(body.password)
    db.execute(delete(AuthAttempt).where(AuthAttempt.key_hash == key))

    token, csrf = new_token(), new_token()
    session = UserSession(
        user_account_id=account.id,
        session_token_hash=hash_token(token),
        csrf_token=csrf,
        expires_at=now + timedelta(hours=settings.session_absolute_hours),
        last_seen_at=now,
    )
    db.add(session)
    account.last_login_at = now
    promote_due_retakes(db, account.employee_id, now)  # "Next eligible login" (BR §9.2).
    record_audit(db, account.id, "LOGIN_SUCCESS", "user_account", account.id, ip_address=ip)
    db.commit()

    _set_cookies(response, token, csrf)
    user = CurrentUser(account, account.employee, session, {link.role.code for link in account.role_links})
    return ok({"user": user_payload(user, db), "access_state": access_state(db, user.employee_id), "csrf_token": csrf})


@router.post("/logout")
def logout(response: Response, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    user.session.revoked_at = utcnow()
    record_audit(db, user.id, "LOGOUT", "user_account", user.id)
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return ok({"signed_out": True})


@router.get("/me")
def me(user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    return ok({"user": user_payload(user, db), "csrf_token": user.session.csrf_token})


@router.post("/change-password")
def change_password(body: ChangePasswordIn, response: Response, user: CurrentUser = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    if not verify_password(user.account.password_hash, body.current_password):
        raise validation("Your current password is incorrect.")
    problem = validate_password_strength(body.new_password)
    if problem:
        raise validation(problem)
    now = utcnow()
    user.account.password_hash = hash_password(body.new_password)
    for session in db.scalars(select(UserSession).where(UserSession.user_account_id == user.id, UserSession.revoked_at.is_(None))):
        session.revoked_at = now
    token, csrf = new_token(), new_token()
    db.add(
        UserSession(
            user_account_id=user.id,
            session_token_hash=hash_token(token),
            csrf_token=csrf,
            expires_at=now + timedelta(hours=get_settings().session_absolute_hours),
            last_seen_at=now,
        )
    )
    record_audit(db, user.id, "PASSWORD_CHANGED", "user_account", user.id)
    db.commit()
    _set_cookies(response, token, csrf)
    return ok({"changed": True, "csrf_token": csrf})


@router.get("/sso/providers")
def sso_providers() -> dict:
    """Integration point only. No provider is connected until Finvasia IT approves one."""
    return ok([{"provider": p, "configured": False} for p in SSO_PROVIDERS])


@router.get("/sso/{provider}/start")
def sso_start(provider: str) -> dict:
    raise ApiError(501, "SSO_NOT_CONFIGURED", f"{provider.title()} sign-in is not connected. Use your email and password.")
