"""Append-only audit records. Never pass passwords, tokens or answer keys here."""
from typing import Any

from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import request_id_var
from app.models import AuditLog


def record_audit(
    db: Session,
    actor_user_id: Any,
    action: str,
    target_type: str | None = None,
    target_id: Any = None,
    reason: str | None = None,
    before: dict | None = None,
    after: dict | None = None,
    ip_address: str | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            reason=reason,
            before_summary=before,
            after_summary=after,
            request_id=request_id_var.get(),
            ip_address=ip_address,
            created_at=utcnow(),
        )
    )
