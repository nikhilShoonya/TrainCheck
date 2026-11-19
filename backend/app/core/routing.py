"""Routes that hand their database connection back before the response is serialised (audit F-02).

FastAPI runs sync dependencies, sync endpoints and the response validation of sync endpoints as separate calls in
one shared worker-thread pool, while every request shares one database session. A request that still holds its
connection while it waits for a worker thread can deadlock with requests that hold worker threads while they wait
for a connection: under a burst nothing moves until the pool times out. The rule that prevents it: never hold a
connection across a hand-over to the thread pool.

- require_session and require_gate_clear commit before returning (app.core.deps).
- ReleasingRoute ends the endpoint's transaction in the endpoint's own thread, before serialisation. Endpoints commit
  their own work explicitly, so ending the transaction here only discards what get_db's teardown would discard anyway.
"""
import functools
import inspect
from collections.abc import Callable
from typing import Any

from fastapi.routing import APIRoute
from sqlalchemy.orm import Session


def _releasing(endpoint: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(endpoint)  # Keeps the signature, so FastAPI injects exactly the same parameters.
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return endpoint(*args, **kwargs)
        finally:
            for value in kwargs.values():
                if isinstance(value, Session):
                    value.rollback()  # Returns the connection to the pool; committed work is unaffected.

    return wrapper


class ReleasingRoute(APIRoute):
    def __init__(self, path: str, endpoint: Callable[..., Any], **kwargs: Any) -> None:
        if not inspect.iscoroutinefunction(endpoint):
            endpoint = _releasing(endpoint)
        super().__init__(path, endpoint, **kwargs)
