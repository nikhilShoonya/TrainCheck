"""The training row lock that keeps writers and permanent training deletion apart.

Permanent deletion (training.deletion) takes FOR UPDATE on the training row before it reads or removes anything.
Every request that writes records belonging to a training first takes FOR KEY SHARE on the same row, before any
other row lock. The two modes conflict, and key-share holders never block each other, so:

- a writer that already holds the lock finishes (and its records are then deleted with the training);
- a writer that arrives while the deletion runs waits, then finds the training gone and gets a clean 404;
- writers of the same training never wait for each other because of this lock.

Taking the lock first, always, is what prevents deadlocks: a writer that locked, say, an enrolment and only then
touched the training would wait for the deletion while the deletion waits for that enrolment.
"""
import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import Training

TRAINING_GONE = "This training no longer exists. It may have been deleted. Reload the page."


def training_gone(message: str = TRAINING_GONE) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def _key_share(training_ids: list[uuid.UUID]):
    return select(Training.id).where(Training.id.in_(training_ids)).order_by(Training.id).with_for_update(read=True, key_share=True)


def try_hold_training(db: Session, training_id: uuid.UUID | None) -> bool:
    """Takes the writer's lock on one training. False when the training does not exist (any more)."""
    if training_id is None:
        return False
    return db.scalar(_key_share([training_id])) is not None


def hold_training(db: Session, training_id: uuid.UUID | None, message: str = TRAINING_GONE) -> None:
    """try_hold_training, raising 404 when the training is gone."""
    if not try_hold_training(db, training_id):
        raise training_gone(message)


def hold_trainings(db: Session, training_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """Locks several trainings at once (in ID order) and returns those that still exist."""
    ids = sorted(set(training_ids))
    if not ids:
        return set()
    return set(db.scalars(_key_share(ids)))
