"""Own in-app notifications, shared search and the L&D dashboard summary."""
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select, tuple_, update
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear
from app.core.errors import not_found
from app.core.responses import iso, ok
from app.core.routing import ReleasingRoute
from app.models import Notification

router = APIRouter(route_class=ReleasingRoute, prefix="/me/notifications", tags=["Notifications"])


class ReadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    read: bool = True


def view(n: Notification) -> dict:
    return {"id": str(n.id), "type": n.type, "title": n.title, "message": n.message, "link": n.link, "read": n.read_at is not None, "created_at": iso(n.created_at)}


PAGE_SIZE = 100  # The default and the largest page: the list is always bounded.


@router.get("")
def list_notifications(
    user: CurrentUser = Depends(require_gate_clear),
    db: Session = Depends(get_db),
    unread_only: bool = False,
    limit: int = Query(default=PAGE_SIZE, ge=1, le=PAGE_SIZE),
    before: uuid.UUID | None = Query(default=None, description="The last notification already shown: the page continues after it."),
) -> dict:
    """Newest first, in pages (audit B21). Ordered by (created_at, id), both descending, so notifications created at
    the same moment still have one fixed order; `before` continues strictly after a notification already shown, so
    consecutive pages never repeat or skip one. meta.has_more says whether an older page exists."""
    query = select(Notification).where(Notification.user_account_id == user.id)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    if before is not None:
        anchor = db.get(Notification, before)
        if anchor is None or anchor.user_account_id != user.id:
            raise not_found("That notification is not available. Reload the notifications.")
        query = query.where(tuple_(Notification.created_at, Notification.id) < tuple_(anchor.created_at, anchor.id))
    rows = db.scalars(query.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)).all()
    items, has_more = rows[:limit], len(rows) > limit
    return ok([view(n) for n in items], unread=_unread(db, user), has_more=has_more, next_before=str(items[-1].id) if has_more else None)


def _unread(db: Session, user: CurrentUser) -> int:
    return db.scalar(select(func.count()).select_from(Notification).where(Notification.user_account_id == user.id, Notification.read_at.is_(None))) or 0


@router.get("/unread-count")
def unread_count(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    """The exact number of unread notifications, for the header bell (the list is limited, so it cannot count them)."""
    return ok({"unread": _unread(db, user)})


@router.post("/mark-all-read")
def mark_all(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    db.execute(update(Notification).where(Notification.user_account_id == user.id, Notification.read_at.is_(None)).values(read_at=utcnow()))
    db.commit()
    return ok({"marked": True})


@router.patch("/{notification_id}")
def set_read(notification_id: uuid.UUID, body: ReadIn, user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db)) -> dict:
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_account_id != user.id:
        raise not_found()
    notification.read_at = utcnow() if body.read else None
    db.commit()
    return ok(view(notification))
