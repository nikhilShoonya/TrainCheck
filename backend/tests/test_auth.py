"""Authentication and sessions. TC-AUTH-*, Security §5, SEC-012."""
from datetime import timedelta

from sqlalchemy import select

from app.core import clock
from app.core.deps import SESSION_COOKIE
from app.core.security import verify_password
from app.models import AuditLog, UserAccount, UserSession
from tests.conftest import NOW, PASSWORD, ApiClient


def test_password_is_stored_with_argon2id(world, db):
    account = db.scalar(select(UserAccount).where(UserAccount.login_email == world.employee.work_email))
    assert account.password_hash.startswith("$argon2id$")
    assert PASSWORD not in account.password_hash


def test_login_sets_httponly_session_and_stores_only_a_hash(world, db):
    client = ApiClient()
    response = client.login(world.employee.work_email)
    assert response.status_code == 200
    cookies = response.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith(SESSION_COOKIE))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    token = session_cookie.split("=", 1)[1].split(";")[0]
    stored = db.scalar(select(UserSession))
    assert stored.session_token_hash != token and len(stored.session_token_hash) == 64


def test_invalid_login_is_generic(world):
    client = ApiClient()
    wrong = client.login(world.employee.work_email, "wrong-password")
    unknown = client.login("nobody@test.example", "wrong-password")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["error"]["message"] == unknown.json()["error"]["message"]


def test_login_is_rate_limited(world):
    client = ApiClient()
    for _ in range(5):
        assert client.login(world.employee.work_email, "wrong-password").status_code == 401
    limited = client.login(world.employee.work_email, PASSWORD)
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "RATE_LIMITED"
    clock.freeze(NOW + timedelta(minutes=16))
    assert client.login(world.employee.work_email, PASSWORD).status_code == 200


def test_unauthenticated_requests_rejected():
    response = ApiClient().get("/me/access-state")
    assert response.status_code == 401 and response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert "request_id" in response.json()["error"]


def test_state_change_needs_csrf_token(world, client_for):
    obligation_client = client_for(world.employee)
    assert obligation_client.http.post("/api/v1/auth/logout").json()["error"]["code"] == "CSRF_FAILED"
    assert obligation_client.http.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert obligation_client.post("/auth/logout").status_code == 200


def test_logout_revokes_the_session(world, client_for):  # SEC-012
    client = client_for(world.employee)
    cookie = client.http.cookies.get(SESSION_COOKIE)
    assert client.post("/auth/logout").status_code == 200
    stolen = ApiClient()
    stolen.http.cookies.set(SESSION_COOKIE, cookie)
    assert stolen.get("/auth/me").status_code == 401


def test_idle_and_absolute_expiry(world, client_for):
    client = client_for(world.employee)
    clock.freeze(NOW + timedelta(minutes=61))
    assert client.get("/auth/me").status_code == 401
    active = client_for(world.employee)
    moment = NOW + timedelta(minutes=61)
    for _ in range(14):  # Staying active does not extend past the absolute limit.
        moment += timedelta(minutes=55)
        clock.freeze(moment)
        last = active.get("/auth/me").status_code
    assert last == 401


def test_disabled_account_loses_access_immediately(world, client_for, db):  # TC-RBAC-008
    client = client_for(world.employee)
    assert client.get("/auth/me").status_code == 200
    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == world.employee.id))
    account.account_status = "DISABLED"
    db.commit()
    assert client.get("/auth/me").status_code == 401
    assert ApiClient().login(world.employee.work_email).status_code == 401


def test_inactive_employee_cannot_sign_in(world, db):  # TC-RBAC-008
    world.employee.employment_status = "INACTIVE"
    db.commit()
    assert ApiClient().login(world.employee.work_email).status_code == 401


def test_change_password_revokes_other_sessions(world, client_for, db):
    other = client_for(world.employee)
    client = client_for(world.employee)
    weak = client.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "short"})
    assert weak.status_code == 400
    assert client.post("/auth/change-password", json={"current_password": "wrong", "new_password": "NewPassword123"}).status_code == 400
    response = client.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "NewPassword123"})
    assert response.status_code == 200
    client.csrf = response.json()["data"]["csrf_token"]
    assert other.get("/auth/me").status_code == 401
    assert client.get("/auth/me").status_code == 200
    db.expire_all()
    account = db.scalar(select(UserAccount).where(UserAccount.employee_id == world.employee.id))
    assert verify_password(account.password_hash, "NewPassword123")


def test_login_events_are_audited_without_secrets(world, db):
    client = ApiClient()
    client.login(world.employee.work_email, "wrong-password")
    client.login(world.employee.work_email)
    logs = db.scalars(select(AuditLog)).all()
    assert {log.action for log in logs} == {"LOGIN_FAILED", "LOGIN_SUCCESS"}
    assert "wrong-password" not in str([(log.before_summary, log.after_summary, log.reason) for log in logs])


def test_sso_is_not_claimed_as_configured():
    client = ApiClient()
    assert all(p["configured"] is False for p in client.get("/auth/sso/providers").json()["data"])
    assert client.get("/auth/sso/google/start").json()["error"]["code"] == "SSO_NOT_CONFIGURED"


def test_error_response_hides_internals(world):
    body = ApiClient().post("/auth/login", json={"email": "bad", "password": "secret-value"})
    assert body.status_code == 400
    assert "secret-value" not in body.text
    assert body.json()["error"]["code"] == "VALIDATION_ERROR"
