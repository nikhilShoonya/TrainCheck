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
