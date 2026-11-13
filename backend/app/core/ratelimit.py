"""Rate limiting with verified client identity.

Identity
- A request with a valid server-side session is limited per user account, so employees behind the
  same proxy or office network never share a bucket.
- Any other request is limited per client IP, resolved through an explicit trusted-proxy list.

Client IP
- X-Forwarded-For is read only when the immediate peer is in TRUSTED_PROXIES. The chain is walked
  from the right, skipping trusted proxies; the first untrusted address is the client. Entries a
  client wrote itself sit to the left of what the trusted proxies appended, so they are never chosen.

Storage
- "memory": per process. Correct for one backend instance.
- "database": counters in PostgreSQL, shared by every instance. No new infrastructure is needed.

Algorithm
- Sliding-window estimate over two fixed windows: previous_count × (1 − elapsed fraction) + current_count.
  Every request counts, including refused ones, so a client that keeps retrying stays limited.
"""
import hashlib
import ipaddress
import logging
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Depends, Request
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.core.config import get_settings
from app.core.errors import ApiError

logger = logging.getLogger("traincheck.ratelimit")

WINDOW_SECONDS = 60
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network


# ---------- Trusted proxies and client IP ----------

def parse_trusted_proxies(spec: str) -> list[Network]:
    """Comma-separated addresses or CIDR ranges. A wildcard is refused: it would trust any caller."""
    networks: list[Network] = []
    for raw in (part.strip() for part in spec.split(",")):
        if not raw:
            continue
        if raw == "*":
            raise ValueError("TRUSTED_PROXIES must list specific addresses or ranges; '*' would trust every caller's X-Forwarded-For.")
        try:
            networks.append(ipaddress.ip_network(raw, strict=False))
        except ValueError as exc:
            raise ValueError(f"TRUSTED_PROXIES contains an invalid address or range: {raw!r}") from exc
    return networks


def parse_ip(value: str | None) -> IPAddress | None:
    """Accepts 1.2.3.4, 1.2.3.4:5678, ::1, [::1] and [::1]:5678. IPv4-mapped IPv6 becomes IPv4."""
    if not value:
        return None
    text = value.strip()
    if text.startswith("["):
        text = text[1 : text.find("]")] if "]" in text else ""
    elif text.count(":") == 1:  # IPv4 with a port. Bare IPv6 always has two or more colons.
        text = text.split(":")[0]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def is_trusted(address: IPAddress, trusted: list[Network]) -> bool:
    return any(address.version == network.version and address in network for network in trusted)


def resolve_client_ip(peer: str | None, forwarded_for: list[str], trusted: list[Network]) -> str:
    """The verified client address for a request (see the module docstring)."""
    current = parse_ip(peer)
    if current is None:
        return peer or "unknown"
    if not is_trusted(current, trusted):
        return str(current)  # A direct caller: whatever it says in X-Forwarded-For is ignored.
    entries = [entry for header in forwarded_for for entry in header.split(",")]
    for raw in reversed(entries):
        hop = parse_ip(raw)
        if hop is None:
            break  # A malformed hop cannot be verified; keep the last address that was.
        current = hop
        if not is_trusted(hop, trusted):
            break
    return str(current)


# ---------- Stores ----------

class MemoryStore:
    """Per-process counters. Suitable for a single backend instance."""

    def __init__(self) -> None:
        self._counts: dict[tuple[str, int], int] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, window: int) -> tuple[int, int]:
        with self._lock:
            current = self._counts.get((key, window), 0) + 1
            self._counts[(key, window)] = current
            if len(self._counts) > 50_000:
                for old in [k for k in self._counts if k[1] < window - 1]:
                    del self._counts[old]
            return self._counts.get((key, window - 1), 0), current

    def prune(self, before_window: int) -> int:
        with self._lock:
            old = [k for k in self._counts if k[1] < before_window]
            for k in old:
                del self._counts[k]
            return len(old)


class DatabaseStore:
    """Counters in PostgreSQL, shared by every backend instance. Keys are hashed before storage."""

    def __init__(self, engine) -> None:
        self.engine = engine

    @staticmethod
    def _start(window: int) -> datetime:
        return datetime.fromtimestamp(window * WINDOW_SECONDS, UTC)

    def hit(self, key: str, window: int) -> tuple[int, int]:
        from app.models import RateLimitCounter

        key_hash = hashlib.sha256(key.encode()).hexdigest()
        upsert = (
            insert(RateLimitCounter)
            .values(key_hash=key_hash, window_start=self._start(window), count=1)
            .on_conflict_do_update(index_elements=["key_hash", "window_start"], set_={"count": RateLimitCounter.count + 1})
            .returning(RateLimitCounter.count)
        )
        with self.engine.begin() as connection:
            current = connection.execute(upsert).scalar_one()
            previous = connection.execute(
                select(RateLimitCounter.count).where(RateLimitCounter.key_hash == key_hash, RateLimitCounter.window_start == self._start(window - 1))
            ).scalar()
        return previous or 0, current

    def prune(self, before_window: int) -> int:
        from app.models import RateLimitCounter

        with self.engine.begin() as connection:
            return connection.execute(delete(RateLimitCounter).where(RateLimitCounter.window_start < self._start(before_window))).rowcount


# ---------- Limiter ----------

def _position(now: float) -> tuple[int, float]:
    """The fixed window `now` falls in, and how far through it (0 to 1)."""
    return int(now // WINDOW_SECONDS), (now % WINDOW_SECONDS) / WINDOW_SECONDS


def seconds_until_allowed(previous: int, current: int, limit: int, now: float) -> int:
    """Whole seconds a client must wait, sending nothing meanwhile, before its next request is allowed.
    Uses the same estimate as the limiter, so honouring Retry-After always succeeds."""
    window, _ = _position(now)
    for wait in range(1, 2 * WINDOW_SECONDS + 1):
        later_window, elapsed = _position(now + wait)
        if later_window == window:
            p, c = previous, current
        elif later_window == window + 1:
            p, c = current, 0
        else:
            p, c = 0, 0
        if p * (1 - elapsed) + c + 1 <= limit:
            return wait
    return 2 * WINDOW_SECONDS


@dataclass
class Decision:
    allowed: bool
    limit: int
    retry_after: int


class RateLimiter:
    def __init__(self, store) -> None:
        self.store = store

    def hit(self, key: str, limit: int, now: float | None = None) -> Decision:
        now = time.time() if now is None else now
        window, elapsed = _position(now)
        previous, current = self.store.hit(key, window)
        allowed = previous * (1 - elapsed) + current <= limit
        retry_after = 0 if allowed else seconds_until_allowed(previous, current, limit, now)
        return Decision(allowed=allowed, limit=limit, retry_after=retry_after)

    def prune(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        return self.store.prune(int(now // WINDOW_SECONDS) - 1)


_limiter: RateLimiter | None = None
_trusted: list[Network] | None = None


def get_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        settings = get_settings()
        if settings.rate_limit_store == "database":
            from app.core.db import get_engine

            _limiter = RateLimiter(DatabaseStore(get_engine()))
        elif settings.rate_limit_store == "memory":
            _limiter = RateLimiter(MemoryStore())
        else:
            raise ValueError("RATE_LIMIT_STORE must be 'memory' or 'database'.")
    return _limiter


def trusted_proxies() -> list[Network]:
    global _trusted
    if _trusted is None:
        _trusted = parse_trusted_proxies(get_settings().trusted_proxies)
    return _trusted


def reset() -> None:
    """Rebuilds limiter and proxy list from current settings. Used at startup and in tests."""
    global _limiter, _trusted
    _limiter, _trusted = None, None
    with _identity_lock:
        _identity_cache.clear()


# The rate limiter only needs to know which bucket a cookie belongs to. Remembering that for a few seconds
# saves a database round trip on every request. Authentication is unaffected: require_session still checks
# the session in the database on every request, so a revoked session is refused immediately.
IDENTITY_CACHE_SECONDS = 30
IDENTITY_CACHE_MAX = 10_000
_identity_cache: dict[str, tuple[float, str | None]] = {}
_identity_lock = threading.Lock()


def client_ip_for(request: Request) -> str:
    cached = getattr(request.state, "client_ip", None)
    if cached:
        return cached
    peer = request.client.host if request.client else None
    ip = resolve_client_ip(peer, request.headers.getlist("x-forwarded-for"), trusted_proxies())
    request.state.client_ip = ip
    return ip


def session_account_id(token: str) -> str | None:
    """The account behind a session cookie, only if that session is currently valid (cached briefly; see above)."""
    from app.core.security import hash_token

    key = hash_token(token)
    moment = time.monotonic()
    with _identity_lock:
        hit = _identity_cache.get(key)
    if hit is not None and moment - hit[0] < IDENTITY_CACHE_SECONDS:
        return hit[1]
    account = _lookup_session_account(key)
    with _identity_lock:
        if len(_identity_cache) >= IDENTITY_CACHE_MAX:
            _identity_cache.clear()  # Bounded memory; the next requests simply look up again.
        _identity_cache[key] = (moment, account)
    return account


def _lookup_session_account(token_hash: str) -> str | None:
    from app.core.clock import utcnow
    from app.core.db import session_factory
    from app.models import UserSession

    settings = get_settings()
    now = utcnow()
    with session_factory()() as db:
        session = db.scalar(select(UserSession).where(UserSession.session_token_hash == token_hash))
        if session is None or session.revoked_at is not None or session.expires_at <= now:
            return None
        if session.last_seen_at + timedelta(minutes=settings.session_idle_minutes) <= now:
            return None
        return str(session.user_account_id)


def rate_identity(request: Request, token: str | None) -> str:
    """'user:<account id>' for a valid session, otherwise 'ip:<verified client IP>'."""
    if token:
        try:
            account = session_account_id(token)
        except Exception:  # Database trouble: fall back to the stricter IP bucket; the route will report the outage.
            logger.warning("Session lookup for rate limiting failed; using the client IP.")
            account = None
        if account:
            return f"user:{account}"
    return f"ip:{client_ip_for(request)}"


# ---------- Limits for expensive endpoints ----------

def expensive(category: str):
    """An extra, per-identity limit on top of the general one, e.g. imports or report generation."""

    def dependency(request: Request) -> None:
        settings = get_settings()
        if not settings.rate_limit_enabled:
            return
        limit = getattr(settings, f"rate_limit_{category}_per_minute")
        identity = getattr(request.state, "rate_identity", None) or f"ip:{client_ip_for(request)}"
        decision = get_limiter().hit(f"{category}|{identity}", limit)
        if not decision.allowed:
            raise ApiError(429, "RATE_LIMITED", "You are doing this too often. Please wait a moment and try again.", headers={"Retry-After": str(decision.retry_after)})

    return Depends(dependency)
