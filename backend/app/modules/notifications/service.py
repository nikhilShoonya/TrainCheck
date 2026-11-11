"""In-app notifications. External channels stay off until a provider is approved (OD-BRD-012)."""
import uuid
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.models import Notification, Role, UserAccount, UserRole


def notify_account(db: Session, account_id: uuid.UUID, kind: str, title: str, message: str, link: str | None, dedupe_key: str | None, now: datetime | None = None) -> None:
    """Safe to call repeatedly: the same business event creates one notification per person."""
    db.execute(
        insert(Notification)
        .values(id=uuid.uuid4(), user_account_id=account_id, type=kind, title=title, message=message, link=link, dedupe_key=dedupe_key, created_at=now or utcnow())
        .on_conflict_do_nothing(constraint="uq_notification_once")
    )


def notify_employee(db: Session, employee_id: uuid.UUID, kind: str, title: str, message: str, link: str | None, dedupe_key: str | None, now: datetime | None = None) -> None:
    account_id = db.scalar(select(UserAccount.id).where(UserAccount.employee_id == employee_id))
    if account_id:
        notify_account(db, account_id, kind, title, message, link, dedupe_key, now)


def notify_roles(db: Session, roles: Iterable[str], kind: str, title: str, message: str, link: str | None, dedupe_key: str | None, now: datetime | None = None) -> None:
    accounts = db.scalars(
        select(UserRole.user_account_id).join(Role, Role.id == UserRole.role_id).where(Role.code.in_(list(roles))).distinct()
    )
    for account_id in accounts:
        notify_account(db, account_id, kind, title, message, link, dedupe_key, now)
