"""The success envelope used by every API (DATABASE_API_DESIGN.md §8.3)."""
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any

from app.core.errors import request_id_var


def ok(data: Any, **meta: Any) -> dict:
    return {"data": data, "meta": {"request_id": request_id_var.get(), **meta}}


def display_percent(value: Decimal | float | None) -> float | None:
    """Two decimals, rounded down, so a failing 69.996% is never shown as 70%."""
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_DOWN))


def num(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def iso(value: Any) -> str | None:
    """Always UTC with an explicit offset, whatever the database session's timezone is."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat() if isinstance(value, datetime) else value.isoformat()
