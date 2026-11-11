"""Own in-app notifications, shared search and the L&D dashboard summary."""
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.db import get_db
from app.core.deps import CurrentUser, require_gate_clear
from app.core.errors import not_found
from app.core.responses import iso, ok
from app.models import Notification

router = APIRouter(prefix="/me/notifications", tags=["Notifications"])


class ReadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    read: bool = True


def view(n: Notification) -> dict:
    return {"id": str(n.id), "type": n.type, "title": n.title, "message": n.message, "link": n.link, "read": n.read_at is not None, "created_at": iso(n.created_at)}


@router.get("")
def list_notifications(user: CurrentUser = Depends(require_gate_clear), db: Session = Depends(get_db), unread_only: bool = False, limit: int = Query(default=100, le=200)) -> dict:
    query = select(Notification).where(Notification.user_account_id == user.id).order_by(Notification.created_at.desc()).limit(limit)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    items = db.scalars(query).all()
    unread = len(db.scalars(select(Notification.id).where(Notification.user_account_id == user.id, Notification.read_at.is_(None))).all())
    return ok([view(n) for n in items], unread=unread)


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
