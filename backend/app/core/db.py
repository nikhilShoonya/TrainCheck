"""Database engine and sessions, tuned for Neon's pooled, suspendable PostgreSQL (ADR-0001)."""
from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings, normalise_database_url


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def build_engine(url: str) -> Engine:
    engine = create_engine(
        normalise_database_url(url),
        pool_pre_ping=True,  # Neon compute may have suspended since the last query.
        pool_recycle=240,
        pool_size=5,
        max_overflow=5,
        connect_args={"prepare_threshold": None},  # PgBouncer transaction mode cannot keep prepared statements.
    )

    @event.listens_for(engine, "connect")
    def _use_utc(connection, _record) -> None:  # Stored times are UTC, and date logic must read them as UTC.
        with connection.cursor() as cursor:
            cursor.execute("SET TIME ZONE 'UTC'")
        connection.commit()

    return engine


def configure(url: str | None = None) -> None:
    """Create the engine. Tests call this with their own database URL."""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = build_engine(url or get_settings().database_url)
    _session_factory = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


def get_engine() -> Engine:
    if _engine is None:
        configure()
    assert _engine is not None
    return _engine


def session_factory() -> sessionmaker[Session]:
    if _session_factory is None:
        configure()
    assert _session_factory is not None
    return _session_factory


def get_db() -> Iterator[Session]:
    """Request-scoped session. Services commit explicitly; anything uncommitted is rolled back."""
    db = session_factory()()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
