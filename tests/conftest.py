"""Shared fixtures.

Database tests run against a throwaway Postgres 16 started for the test session. Neon's HTTPS
SQL endpoint is emulated on top of it, so the production NeonHttpDb client is exercised end to
end without any credential. Set FINOS_TEST_DATABASE_URL to use an existing server instead.
"""

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from finos.db import NeonHttpDb

psycopg = pytest.importorskip("psycopg")
from psycopg import pq  # noqa: E402

PG_BIN = Path("/usr/lib/postgresql/16/bin")
NEON_SQL_URL = "https://api.test-region.aws.neon.tech/sql"
UI_ROLE = "finos_ui_access"


@pytest.fixture(scope="session")
def pg_admin_url() -> Iterator[str]:
    if url := os.environ.get("FINOS_TEST_DATABASE_URL"):
        yield url
        return
    if not (PG_BIN / "initdb").exists():
        pytest.skip("Postgres 16 is not installed; set FINOS_TEST_DATABASE_URL instead")

    # initdb refuses to run as root, and the postgres user must be able to reach the directory.
    base = Path(tempfile.mkdtemp(prefix="finos-pg-"))
    base.chmod(0o755)
    as_postgres: list[str] = []
    if os.geteuid() == 0:
        shutil.chown(base, "postgres")
        as_postgres = ["runuser", "-u", "postgres", "--"]
    data, sock = base / "data", base / "sock"

    def run(*args: str) -> None:
        subprocess.run([*as_postgres, *args], check=True, capture_output=True)

    run("mkdir", str(sock))
    run(str(PG_BIN / "initdb"), "-D", str(data), "-A", "trust", "-U", "postgres", "--no-sync")
    run(
        str(PG_BIN / "pg_ctl"), "-D", str(data), "-w", "-l", str(base / "log"),
        "-o", f"-k {sock} -c listen_addresses='' -c fsync=off", "start",
    )  # fmt: skip
    try:
        yield f"postgresql://postgres@/postgres?host={sock}"
    finally:
        run(str(PG_BIN / "pg_ctl"), "-D", str(data), "-m", "immediate", "stop")
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture
def pg_url(pg_admin_url: str) -> Iterator[str]:
    """A fresh, empty database for one test."""
    name = f"t_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        conn.execute(f'create database "{name}"')
    yield pg_admin_url.replace("/postgres?", f"/{name}?", 1)
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        conn.execute(f'drop database "{name}" with (force)')


class NeonEmulator:
    """Answers Neon's HTTPS SQL protocol by running each query on a real Postgres.

    Mirrors @neondatabase/serverless: POST {query, params} or {queries: [...]}, text
    parameters, raw text results in array mode, HTTP 400 with {message, code} on errors.
    With role, each connection runs "set role" first, so the queries have only that role's
    grants: the record as the UI sees it.
    """

    def __init__(self, pg_url: str, *, role: str | None = None) -> None:
        self.pg_url = pg_url
        self.role = role
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        body = json.loads(request.content)
        batch = "queries" in body
        queries = body["queries"] if batch else [body]
        with psycopg.connect(self.pg_url, autocommit=True) as conn:
            pg = conn.pgconn
            if self.role:
                pg.exec_(f"set role {self.role}".encode())
            if batch:
                pg.exec_(b"begin")
            results = []
            for query in queries:
                params = [None if p is None else str(p).encode() for p in query["params"]]
                res = pg.exec_params(query["query"].encode(), params)
                if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
                    error = {
                        "message": (res.error_message or b"").decode().strip(),
                        "code": (res.error_field(pq.DiagnosticField.SQLSTATE) or b"").decode(),
                    }
                    if batch:
                        pg.exec_(b"rollback")
                    return httpx.Response(400, json=error)
                results.append(_result_json(res))
            if batch:
                pg.exec_(b"commit")
        return httpx.Response(200, json={"results": results} if batch else results[0])


def _result_json(res: pq.abc.PGresult) -> dict:
    fields = [
        {"name": (res.fname(i) or b"").decode(), "dataTypeID": res.ftype(i)}
        for i in range(res.nfields)
    ]
    rows = [[_text(res.get_value(r, c)) for c in range(res.nfields)] for r in range(res.ntuples)]
    command = (res.command_status or b"").decode().split(" ")[0]
    return {"fields": fields, "rows": rows, "command": command, "rowCount": len(rows)}


def _text(value: bytes | None) -> str | None:
    # psycopg's get_value returns None for SQL NULL.
    return None if value is None else bytes(value).decode()


@pytest.fixture
def neon(pg_url: str) -> NeonEmulator:
    return NeonEmulator(pg_url)


@pytest.fixture
def db(neon: NeonEmulator) -> Iterator[NeonHttpDb]:
    client = httpx.Client(transport=httpx.MockTransport(neon))
    yield NeonHttpDb(NEON_SQL_URL, client)
    client.close()


@pytest.fixture
def migrated_db(db: NeonHttpDb) -> NeonHttpDb:
    from finos.migrate import migrate

    migrate(db)
    return db


@pytest.fixture
def ui_db(migrated_db: NeonHttpDb, pg_url: str) -> Iterator[NeonHttpDb]:
    """The migrated database as the UI's group role finos_ui_access sees it.

    Build the record with migrated_db (the owner), then read it through this one.
    """
    client = httpx.Client(transport=httpx.MockTransport(NeonEmulator(pg_url, role=UI_ROLE)))
    yield NeonHttpDb(NEON_SQL_URL, client)
    client.close()
