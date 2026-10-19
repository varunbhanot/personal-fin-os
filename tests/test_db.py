import json
from datetime import date, datetime
from decimal import Decimal

import httpx
import pytest

from finos.db import NeonHttpDb
from finos.errors import DbError

from .conftest import NEON_SQL_URL


def test_execute_decodes_postgres_types(db):
    rows = db.execute(
        "select 1::int as i, 12345678901::bigint as big, 1234.50::numeric(14,2) as amount, "
        "date '2026-03-31' as d, true as yes, '{\"a\": 1}'::jsonb as doc, "
        "'text' as t, null::text as nothing, timestamptz '2026-03-31 10:00:00+00' as at"
    )

    assert rows == [
        {
            "i": 1,
            "big": 12345678901,
            "amount": Decimal("1234.50"),
            "d": date(2026, 3, 31),
            "yes": True,
            "doc": {"a": 1},
            "t": "text",
            "nothing": None,
            "at": datetime.fromisoformat("2026-03-31T10:00:00+00:00"),
        }
    ]


def test_execute_binds_parameters_of_each_supported_type(db):
    rows = db.execute(
        "select %s::text as s, %s::int as i, %s::numeric as n, %s::date as d, "
        "%s::boolean as b, %s::jsonb as j, %s::text as nothing",
        ["UPI/DR/123", 42, Decimal("99.95"), date(2026, 1, 5), False, {"k": [1, 2]}, None],
    )

    assert rows == [
        {
            "s": "UPI/DR/123",
            "i": 42,
            "n": Decimal("99.95"),
            "d": date(2026, 1, 5),
            "b": False,
            "j": {"k": [1, 2]},
            "nothing": None,
        }
    ]


def test_a_literal_percent_sign_survives_placeholder_conversion(db):
    rows = db.execute("select '100%%' as pct, %s::text as v", ["x"])

    assert rows == [{"pct": "100%", "v": "x"}]


def test_batch_runs_in_one_transaction(db):
    db.execute("create table t (v int primary key)")

    with pytest.raises(DbError):
        db.batch([("insert into t values (%s)", [1]), ("insert into t values (%s)", [1])])

    assert db.execute("select count(*) as n from t") == [{"n": 0}]

    results = db.batch([("insert into t values (%s)", [1]), ("select v from t", [])])
    assert results == [[], [{"v": 1}]]


def test_requests_carry_no_credential(db, neon):
    db.execute("select 1 as one")

    request = neon.requests[0]
    assert str(request.url) == NEON_SQL_URL
    assert "neon-connection-string" not in request.headers
    assert "authorization" not in request.headers
    assert request.headers["neon-array-mode"] == "true"
    assert request.headers["neon-raw-text-output"] == "true"


def test_sql_errors_become_db_errors_with_the_server_message(db):
    # Postgres may quote a bad value in its message. Only statement data is ever sent as a
    # parameter; secrets never go to the database.
    with pytest.raises(DbError) as error:
        db.execute("select %s::int", ["not-a-number"])

    assert str(error.value).startswith("The database rejected a query: ")
    assert "invalid input syntax" in str(error.value)


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_credential_points_at_the_network_secret(status):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="unauthorized")

    db = NeonHttpDb(NEON_SQL_URL, httpx.Client(transport=httpx.MockTransport(handler)))

    with pytest.raises(DbError) as error:
        db.execute("select 1")

    assert "network secret" in str(error.value)
    assert "api.test-region.aws.neon.tech" in str(error.value)


def test_a_missing_connection_string_points_at_the_network_secret():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"message": "No connection string provided"})

    db = NeonHttpDb(NEON_SQL_URL, httpx.Client(transport=httpx.MockTransport(handler)))

    with pytest.raises(DbError) as error:
        db.execute("select 1")

    assert "network secret" in str(error.value)
    assert "No connection string provided" not in str(error.value)


def test_an_unreachable_endpoint_becomes_a_db_error_after_retries():
    waits: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    db = NeonHttpDb(NEON_SQL_URL, client, sleep=waits.append)

    with pytest.raises(DbError, match="ConnectError"):
        db.execute("select 1")
    assert waits == [0.5, 1.0, 2.0]


def test_a_lasting_proxy_refusal_points_at_the_network_secret():
    waits: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ProxyError("403 Forbidden http://user:proxy-token@proxy")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    db = NeonHttpDb(NEON_SQL_URL, client, sleep=waits.append)

    with pytest.raises(DbError) as error:
        db.execute("select 1")
    assert waits == [0.5, 1.0, 2.0]
    assert "api.test-region.aws.neon.tech" in str(error.value)
    assert "(proxy status 403)" in str(error.value)
    assert "network secret" in str(error.value)
    assert "proxy-token" not in str(error.value)


def test_a_brief_proxy_failure_is_retried(db, neon):
    replies: list[Exception] = [httpx.ProxyError("503 Service Unavailable")]

    def handler(request: httpx.Request) -> httpx.Response:
        if replies:
            raise replies.pop(0)
        return neon(request)

    flaky = NeonHttpDb(
        NEON_SQL_URL, httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None
    )

    assert flaky.execute("select 1 as one") == [{"one": 1}]


def test_brief_failures_are_retried(db, neon):
    replies = [httpx.Response(503), httpx.Response(429)]
    waits: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return replies.pop(0) if replies else neon(request)

    flaky = NeonHttpDb(
        NEON_SQL_URL, httpx.Client(transport=httpx.MockTransport(handler)), sleep=waits.append
    )

    assert flaky.execute("select 1 as one") == [{"one": 1}]
    assert waits == [0.5, 1.0]


def test_a_persistent_server_error_is_reported():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    db = NeonHttpDb(NEON_SQL_URL, client, sleep=lambda seconds: None)

    with pytest.raises(DbError, match="HTTP 503"):
        db.execute("select 1")


def test_unsupported_placeholders_are_rejected(db):
    with pytest.raises(ValueError):
        db.execute("select %(name)s", [])


def test_parameter_count_must_match(db):
    with pytest.raises(ValueError):
        db.execute("select %s, %s", [1])


def test_batch_request_shape(db, neon):
    db.batch([("select %s::int as a", [1]), ("select %s::int as b", [2])])

    body = json.loads(neon.requests[0].content)
    assert body == {
        "queries": [
            {"query": "select $1::int as a", "params": ["1"]},
            {"query": "select $1::int as b", "params": ["2"]},
        ]
    }
