"""Alembic uses Neon's direct endpoint, because migrations should not pass through PgBouncer (ADR-0001)."""
import os

from alembic import context
from sqlalchemy import create_engine, pool

from app import models  # noqa: F401  Registers every table on Base.metadata.
from app.core.config import get_settings, normalise_database_url
from app.core.db import Base

target_metadata = Base.metadata


def database_url() -> str:
    settings = get_settings()
    url = os.environ.get("ALEMBIC_DATABASE_URL") or settings.database_url_direct or settings.database_url
    return normalise_database_url(url)


def run_offline() -> None:
    context.configure(url=database_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
