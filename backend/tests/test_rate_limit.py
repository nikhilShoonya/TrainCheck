"""Rate limiting behind the Next.js proxy: per-user buckets, verified client IP, trusted proxies, shared store."""
import io
import time

import pytest
from sqlalchemy import func, select, text

from app.core import db as database
from app.core import ratelimit
from app.core.config import get_settings
from app.core.ratelimit import DatabaseStore, MemoryStore, RateLimiter, parse_trusted_proxies, resolve_client_ip
from app.main import create_app
from app.models import AuditLog, RateLimitCounter
from tests.conftest import ApiClient

PROXY = "10.0.0.1"  # Stands in for the Next.js server in these tests.
OFFICE = "203.0.113.5"  # Many employees can share one office address.


@pytest.fixture
def limits(monkeypatch):
    """Turns rate limiting on with small limits and an explicit trusted proxy."""

    def configure(**overrides):
        settings = get_settings()
        values = {
            "rate_limit_enabled": True,
            "rate_limit_store": "memory",
            "trusted_proxies": PROXY,
            "rate_limit_user_per_minute": 5,
            "rate_limit_anonymous_per_minute": 3,
            "rate_limit_import_per_minute": 2,
            "rate_limit_export_per_minute": 2,
            "rate_limit_report_per_minute": 3,
            "rate_limit_bulk_per_minute": 2,
            **overrides,
        }
        for name, value in values.items():
            monkeypatch.setattr(settings, name, value)
        ratelimit.reset()

    configure()
    yield configure
    ratelimit.reset()


def via_proxy(client_ip: str) -> ApiClient:
    """A browser at client_ip, reaching FastAPI through the trusted proxy, which appended client_ip."""
    return ApiClient(address=PROXY, headers={"X-Forwarded-For": client_ip})


def signed_in(email: str, client_ip: str = OFFICE) -> ApiClient:
    client = via_proxy(client_ip)
    assert client.login(email).status_code == 200
    return client


def statuses(client: ApiClient, path: str, count: int, **kwargs) -> list[int]:
    return [client.get(path, **kwargs).status_code for _ in range(count)]


# ---------- 1, 2: authenticated employees behind the same proxy ----------

def test_employees_behind_one_proxy_have_separate_buckets(world, limits):
    limits(rate_limit_anonymous_per_minute=10)
    first = signed_in(world.employee.work_email)
    second = signed_in(world.teammate.work_email)  # Same office address, same proxy.

    assert statuses(first, "/auth/me", 5) == [200] * 5
    blocked = first.get("/auth/me")
    assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "RATE_LIMITED"
    assert int(blocked.headers["Retry-After"]) >= 1

    assert statuses(second, "/auth/me", 5) == [200] * 5  # One employee cannot use up another's quota.


def test_signed_in_users_do_not_consume_the_anonymous_ip_bucket(world, limits):
    limits(rate_limit_anonymous_per_minute=2, rate_limit_user_per_minute=50)
    employee = signed_in(world.employee.work_email)  # The sign-in itself is anonymous: 1 of 2.
    assert statuses(employee, "/auth/me", 10) == [200] * 10
    assert via_proxy(OFFICE).get("/system/ping").status_code == 200  # 2 of 2: still available.


# ---------- 3, 4, 5: unauthenticated requests and forwarded headers ----------

def test_anonymous_requests_are_limited_per_verified_ip(limits):
    office = via_proxy(OFFICE)
    assert statuses(office, "/system/ping", 3) == [200] * 3
    assert office.get("/system/ping").status_code == 429
    assert via_proxy("203.0.113.6").get("/system/ping").status_code == 200  # A different client is unaffected.


def test_forged_forwarded_header_from_untrusted_caller_is_ignored(limits):
    direct = "198.51.100.7"  # Talks to FastAPI directly, not through the proxy.
    codes = [ApiClient(address=direct, headers={"X-Forwarded-For": f"192.0.2.{i}"}).get("/system/ping").status_code for i in range(4)]
    assert codes == [200, 200, 200, 429]  # A new forged address each time did not buy a new bucket.


def test_forged_prefix_through_trusted_proxy_is_ignored(limits):
    # The browser sent "X-Forwarded-For: <forged>"; the proxy appended the real address.
    codes = [ApiClient(address=PROXY, headers={"X-Forwarded-For": f"192.0.2.{i}, {OFFICE}"}).get("/system/ping").status_code for i in range(4)]
    assert codes == [200, 200, 200, 429]


def test_trusted_proxy_forwarded_address_is_used_everywhere(world, limits, db):
    via_proxy("203.0.113.9").login(world.employee.work_email, "wrong-password")
    log = db.scalar(select(AuditLog).where(AuditLog.action == "LOGIN_FAILED"))
    assert log.ip_address == "203.0.113.9"  # The audit log records the client, not the proxy.


def test_error_response_reveals_no_proxy_details(limits):
    client = via_proxy(OFFICE)
    statuses(client, "/system/ping", 3)
    body = client.get("/system/ping").text
    assert PROXY not in body and OFFICE not in body


def test_invalid_session_cookie_falls_back_to_ip_bucket(limits):
    """A made-up session cookie cannot buy a fresh per-user bucket."""
    codes = []
    for i in range(4):
        client = via_proxy(OFFICE)
        client.http.cookies.set("tc_session", f"forged-{i}")
        codes.append(client.get("/system/ping").status_code)
    assert codes == [200, 200, 200, 429]


# ---------- 6, 7, 8: address parsing and proxy chains ----------

TRUSTED = parse_trusted_proxies("10.0.0.0/8, 192.168.1.1, fd00::/8")


@pytest.mark.parametrize(
    ("peer", "header", "expected"),
    [
        ("203.0.113.9", [], "203.0.113.9"),  # 6. IPv4, direct
        ("203.0.113.9", ["6.6.6.6"], "203.0.113.9"),  # Untrusted caller: header ignored
        ("10.0.0.1", ["203.0.113.9"], "203.0.113.9"),  # Trusted proxy
        ("10.0.0.1", ["6.6.6.6, 203.0.113.9"], "203.0.113.9"),  # Forged prefix is never chosen
        ("10.0.0.1", ["6.6.6.6, 203.0.113.9, 192.168.1.1"], "203.0.113.9"),  # 8. Chain of trusted hops
        ("10.0.0.1", ["6.6.6.6", "203.0.113.9"], "203.0.113.9"),  # Repeated headers keep their order
        ("10.0.0.1", ["10.0.0.7, 10.0.0.8"], "10.0.0.7"),  # Every hop trusted: furthest verified hop
        ("10.0.0.1", ["203.0.113.9, not-an-ip"], "10.0.0.1"),  # Malformed hop: stop at what is verified
        ("10.0.0.1", [], "10.0.0.1"),  # Trusted peer with no header, e.g. a health check
        ("10.0.0.1", ["203.0.113.9:443"], "203.0.113.9"),  # IPv4 with a port
        ("::ffff:10.0.0.1", ["203.0.113.9"], "203.0.113.9"),  # IPv4-mapped IPv6 proxy address (Node.js style)
        ("2001:db8::5", [], "2001:db8::5"),  # 7. IPv6, direct
        ("fd00::1", ["2001:db8::5"], "2001:db8::5"),  # IPv6 proxy forwarding an IPv6 client
        ("fd00::1", ["[2001:db8::5]:8443"], "2001:db8::5"),  # Bracketed IPv6 with a port
        ("10.0.0.1", ["2001:db8::5, 203.0.113.9"], "203.0.113.9"),  # Mixed families
        ("testclient", ["203.0.113.9"], "testclient"),  # A peer that is not an address is never trusted
    ],
)
def test_client_ip_resolution(peer, header, expected):
    assert resolve_client_ip(peer, header, TRUSTED) == expected


def test_nothing_is_trusted_by_default():
    assert parse_trusted_proxies("") == []
    assert resolve_client_ip("127.0.0.1", ["203.0.113.9"], []) == "127.0.0.1"


@pytest.mark.parametrize("spec", ["*", "10.0.0.1, banana", "300.1.1.1"])
def test_unsafe_or_invalid_trusted_proxies_stop_startup(monkeypatch, spec):
    monkeypatch.setattr(get_settings(), "trusted_proxies", spec)
    with pytest.raises(ValueError, match="TRUSTED_PROXIES"):
        create_app()
    monkeypatch.undo()
    ratelimit.reset()


def test_ipv6_clients_get_their_own_buckets(limits):
    first, second = ApiClient(address="2001:db8::5"), ApiClient(address="2001:db8::6")
    assert statuses(first, "/system/ping", 3) == [200] * 3
    assert first.get("/system/ping").status_code == 429
    assert second.get("/system/ping").status_code == 200


# ---------- 9: sign-in abuse protection ----------

def test_login_keeps_per_email_lockout_with_verified_ip(world, limits):
    limits(rate_limit_anonymous_per_minute=100)
    attacker = via_proxy("203.0.113.66")
    assert [attacker.login(world.employee.work_email, "wrong").status_code for _ in range(5)] == [401] * 5
    assert attacker.login(world.employee.work_email).status_code == 429  # Locked for this client, even with the right password.
    assert via_proxy(OFFICE).login(world.employee.work_email).status_code == 200  # The real employee elsewhere is not locked out.


def test_login_is_also_covered_by_the_anonymous_ip_limit(world, limits):
    attacker = via_proxy("203.0.113.66")
    codes = [attacker.login(f"nobody{i}@test.example", "wrong").status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]  # Spraying many accounts from one address is throttled too.


# ---------- 10: expensive endpoints ----------

def upload(client):
    return client.post("/admin/imports", files={"file": ("q.csv", io.BytesIO(b"id,training\n1,2\n"))}, data={"import_type": "QUESTIONS"})


def test_imports_have_their_own_tighter_limit(world, limits):
    limits(rate_limit_user_per_minute=50, rate_limit_anonymous_per_minute=10)
    admin = signed_in(world.admin.work_email)
    assert [upload(admin).status_code for _ in range(2)] == [400, 400]  # Rejected file, but counted.
    blocked = upload(admin)
    assert blocked.status_code == 429 and "Retry-After" in blocked.headers
    assert admin.get("/admin/trainings").status_code == 200  # Ordinary pages still work.


def test_export_and_report_limits_are_per_user(world, limits):
    limits(rate_limit_user_per_minute=50, rate_limit_anonymous_per_minute=10)
    hr, admin = signed_in(world.hr.work_email), signed_in(world.admin.work_email)
    export = {"report_code": "compliance", "export_format": "CSV"}
    assert [hr.post("/reports/exports", json=export).status_code for _ in range(3)] == [200, 200, 429]
    assert admin.post("/reports/exports", json=export).status_code == 200  # HR's usage does not block L&D.
    assert statuses(hr, "/reports/compliance", 4) == [200, 200, 200, 429]


def test_bulk_assignment_has_its_own_limit(world, limits):
    limits(rate_limit_user_per_minute=50, rate_limit_anonymous_per_minute=10)
    training = world.training("BULK", questions=1, count=1)
    admin = signed_in(world.admin.work_email)
    body = {"training_id": str(training.id), "employee_ids": [str(world.employee.id)]}
    assert [admin.post("/admin/enrolments", json=body).status_code for _ in range(3)] == [200, 200, 429]


# ---------- 12: shared store across backend instances ----------

def test_database_store_is_shared_between_instances():
    first, second = RateLimiter(DatabaseStore(database.get_engine())), RateLimiter(DatabaseStore(database.get_engine()))
    now = time.time()
    assert first.hit("general|ip:203.0.113.5", 3, now).allowed
    assert second.hit("general|ip:203.0.113.5", 3, now).allowed
    assert first.hit("general|ip:203.0.113.5", 3, now).allowed
    assert not second.hit("general|ip:203.0.113.5", 3, now).allowed  # The other instance's requests counted.


def test_memory_store_is_per_instance_only():
    first, second = RateLimiter(MemoryStore()), RateLimiter(MemoryStore())
    for _ in range(3):
        first.hit("k", 3)
    assert second.hit("k", 3).allowed  # Why RATE_LIMIT_STORE=database is needed with several instances.


def test_database_store_end_to_end_stores_only_hashes(world, limits, db):
    limits(rate_limit_store="database")
    office = via_proxy(OFFICE)
    assert statuses(office, "/system/ping", 4) == [200, 200, 200, 429]
    keys = db.scalars(select(RateLimitCounter.key_hash)).all()
    assert keys and all(len(k) == 64 and OFFICE not in k for k in keys)


def test_sliding_window_and_pruning():
    limiter = RateLimiter(DatabaseStore(database.get_engine()))
    start = 1_800_000_000 - 1_800_000_000 % 60  # The start of a window.
    for _ in range(3):
        limiter.hit("slide", 3, start + 1)
    assert not limiter.hit("slide", 3, start + 61).allowed  # Early in the next window the last minute still counts.
    assert limiter.hit("slide", 3, start + 119).allowed  # Late in it, the old window has almost no weight.
    with database.get_engine().connect() as connection:
        before = connection.execute(select(func.count()).select_from(RateLimitCounter)).scalar_one()
    assert limiter.prune(start + 60 * 10) == before
    with database.get_engine().connect() as connection:
        assert connection.execute(text("select count(*) from rate_limit_counters")).scalar_one() == 0


@pytest.mark.parametrize("burst", [10, 30])
def test_retry_after_is_long_enough(burst):
    """Waiting exactly Retry-After seconds is always enough, and one second less is not."""
    start = 1_800_000_000 - 1_800_000_000 % 60 + 50  # Late in a window, so the wait crosses into the next.
    limiter = RateLimiter(MemoryStore())
    decision = None
    for _ in range(burst):
        decision = limiter.hit("retry", 8, start)
    assert not decision.allowed
    wait = decision.retry_after

    def allowed_after(seconds: int) -> bool:
        probe = RateLimiter(MemoryStore())
        for _ in range(burst):
            probe.hit("k", 8, start)
        return probe.hit("k", 8, start + seconds).allowed

    assert allowed_after(wait) is True
    if wait > 1:
        assert allowed_after(wait - 1) is False


def test_rate_limiting_can_be_turned_off_only_by_configuration(world):
    """With the limiter off (the test default), nothing is limited; production leaves it on."""
    assert get_settings().rate_limit_enabled is False
    client = ApiClient()
    assert statuses(client, "/system/ping", 20) == [200] * 20
