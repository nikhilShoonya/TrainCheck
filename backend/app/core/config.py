"""Application settings, loaded from environment variables or backend/.env."""
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    app_env: str = "development"
    # The only database setting. The API, the scheduler, operator commands and Alembic migrations all use it.
    # For Neon, use the direct (non "-pooler") connection string. Tests never read it (see tests/conftest.py).
    database_url: str = ""

    # Database connections per backend process. Total across processes must stay within the database's limit.
    db_pool_size: int = 5
    db_max_overflow: int = 5
    # Seconds a request waits for a free connection before the API answers 503 with Retry-After.
    db_pool_timeout: int = 10

    cors_origins: str = "http://localhost:3000"

    session_cookie_secure: bool = False
    session_idle_minutes: int = 60
    session_absolute_hours: int = 12

    login_max_failures: int = 5
    login_window_minutes: int = 15

    file_storage_dir: str = "./var/files"
    max_upload_bytes: int = 5 * 1024 * 1024

    default_timezone: str = "Asia/Kolkata"
    scheduler_enabled: bool = True

    # Scope controls. Level 3 Behaviour is outside the approved scope: when off, no follow-up cycles,
    # behaviour tasks, reminders or submissions are created, and existing records stay readable.
    behaviour_enabled: bool = False
    # Post-test feedback is required only for assessments whose first result came on or after this date (YYYY-MM-DD,
    # midnight in DEFAULT_TIMEZONE): the date the feedback form arrived. Older results never block anyone.
    # Empty: required for every graded post-test. Decision of 19 Nov 2026.
    feedback_required_from: str = "2026-11-14"
    # Business decision pending: may PARTIAL attendance count as training completion? Off until approved.
    completion_allows_partial_attendance: bool = False

    # Lets anyone who can reach the sign-in page erase every table and reload the synthetic demo data.
    # Only for demo environments. Always refused in production, whatever this is set to.
    demo_reset_enabled: bool = False

    # false: employees cannot change their own password (the UI hides the form and the API refuses it); their
    # password stays Fin@ + joining date as DDMMYYYY. true: employees may change it. L&D Admins always may.
    employee_password_change_enabled: bool = False

    # The designated L&D Admin account. Read only by `python -m app.manage sync-admin`, never at startup,
    # and never sent to the browser. Changing them has no effect until that command is run.
    admin_email: str = ""
    admin_password: SecretStr = SecretStr("")

    # Rate limiting (see app/core/ratelimit.py). Limits are requests per minute per identity.
    rate_limit_enabled: bool = True
    rate_limit_store: str = "memory"  # "memory" for one backend instance, "database" for several
    rate_limit_user_per_minute: int = 600  # Each signed-in user; the previous single-bucket limit
    # Each verified client IP without a valid session. A whole office can share one address, and a sign-in page costs
    # about four signed-out requests per person, so this fits a 500-person rush. Password guessing is limited
    # separately per account and per address (LOGIN_MAX_FAILURES).
    rate_limit_anonymous_per_minute: int = 3000
    rate_limit_import_per_minute: int = 20
    rate_limit_export_per_minute: int = 30
    rate_limit_bulk_per_minute: int = 30
    rate_limit_report_per_minute: int = 120
    rate_limit_demo_reset_per_minute: int = 2
    # Proxies whose X-Forwarded-For is believed: exact addresses or CIDR ranges, comma separated.
    # Empty means none: every caller is identified by its own connection address.
    trusted_proxies: str = ""

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def storage_path(self) -> Path:
        path = Path(self.file_storage_dir)
        return path if path.is_absolute() else BACKEND_DIR / path


def normalise_database_url(url: str) -> str:
    """Use the psycopg driver and require TLS for every non-local host, as Neon needs."""
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Paste your Neon connection string into backend/.env (see .env.example)."
        )
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
            break
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query))
    query.pop("channel_binding", None)  # Offered in Neon's copied strings; not needed once TLS is required.
    if parts.hostname not in LOCAL_HOSTS:
        query["sslmode"] = "require"
    return urlunsplit(parts._replace(query=urlencode(query)))


@lru_cache
def get_settings() -> Settings:
    return Settings()
