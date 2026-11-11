"""One place to read the time, so tests can control it. Stored times are always UTC."""
from datetime import UTC, datetime

_frozen: datetime | None = None


def utcnow() -> datetime:
    return _frozen or datetime.now(UTC)


def freeze(moment: datetime | None) -> None:
    """Test helper. Pass None to return to real time."""
    global _frozen
    _frozen = moment
