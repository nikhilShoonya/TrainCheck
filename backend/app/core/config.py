"""Application settings, loaded from environment variables or backend/.env."""
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    app_env: str = "development"
    database_url: str = ""
    database_url_direct: str = ""
    test_database_url: str = ""

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
    # Business decision pending: may PARTIAL attendance count as training completion? Off until approved.
    completion_allows_partial_attendance: bool = False

    # Lets anyone who can reach the sign-in page erase every table and reload the synthetic demo data.
    # Only for demo environments. Always refused in production, whatever this is set to.
    demo_reset_enabled: bool = False

    # Rate limiting (see app/core/ratelimit.py). Limits are requests per minute per identity.
    rate_limit_enabled: bool = True
    rate_limit_store: str = "memory"  # "memory" for one backend instance, "database" for several
    rate_limit_user_per_minute: int = 600  # Each signed-in user; the previous single-bucket limit
    rate_limit_anonymous_per_minute: int = 600  # Each verified client IP without a valid session
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
