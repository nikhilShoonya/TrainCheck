"""Bursts of requests must queue, never stall (audit F-02, F-03).

Sync dependencies and endpoints run in a shared worker-thread pool, and every request shares one database session.
If a request keeps its database connection while it waits for a worker thread (between a dependency and the
endpoint, or before the response is serialised), and every worker thread is busy waiting for a connection, nothing
can move until the pool times out. Here the pool and the thread pool are made tiny so a modest burst hits that.
"""
import anyio
import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.core import db as database
from app.main import app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def tiny_pools():
    """A 2-connection pool with a short timeout (the 4-thread limit is set inside the test's event loop)."""
    url = str(database.get_engine().url)
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, poolclass=QueuePool, pool_size=2, max_overflow=0, pool_timeout=3, connect_args=connect_args)
    saved_factory = database._session_factory
    database._session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    yield
    database._session_factory = saved_factory
    engine.dispose()


@pytest.mark.anyio
async def test_a_burst_larger_than_the_pools_queues_instead_of_stalling(world, client_for, tiny_pools):
    signed_in = client_for(world.employee)
    cookies = dict(signed_in.http.cookies)
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = 4
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50001))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", cookies=cookies, timeout=60) as client:
        with anyio.fail_after(30):
            responses = await _burst(client, 30)
    codes = sorted(r.status_code for r in responses)
    assert codes == [200] * 30, codes


async def _burst(client: httpx.AsyncClient, size: int) -> list[httpx.Response]:
    results: list[httpx.Response] = []

    async def one(path: str) -> None:
        results.append(await client.get(path))

    async with anyio.create_task_group() as group:
        for i in range(size):
            group.start_soon(one, ("/api/v1/me/access-state", "/api/v1/me/dashboard", "/api/v1/me/notifications")[i % 3])
    return results


def test_an_exhausted_pool_answers_503_with_retry_after(world, client_for):
    """When no connection frees up in time the API says 'temporarily unavailable', not 'something went wrong'."""
    client = client_for(world.employee)
    url = str(database.get_engine().url)
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, poolclass=QueuePool, pool_size=1, max_overflow=0, pool_timeout=0.5, connect_args=connect_args)
    saved = database._session_factory
    database._session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    held = engine.connect()
    try:
        response = client.get("/me/access-state")
    finally:
        held.close()
        database._session_factory = saved
        engine.dispose()
    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    assert int(response.headers["Retry-After"]) > 0
