"""Database access over Neon's HTTPS SQL endpoint.

Cloud sessions cannot open Postgres ports, so SQL travels over HTTPS, the way Neon's own
serverless driver sends it. This client never sends a credential: the cloud environment's
network secret adds the Neon-Connection-String header after the request leaves the session.

SQL is written with %s placeholders and converted to Postgres's $1, $2 form here.
"""

import json
import time
from collections.abc import Callable, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

import httpx

from finos.errors import DbError, proxy_refused

Row = dict[str, Any]
Query = tuple[str, Sequence[Any]]
Table = tuple[list[str], list[tuple[str | None, ...]]]  # column names, then rows of text

# Postgres type OIDs for the types finos stores. Anything else comes back as text.
_DECODERS: dict[int, Callable[[str], Any]] = {
    16: lambda v: v == "t",  # bool
    20: int,  # int8
    21: int,  # int2
    23: int,  # int4
    1700: Decimal,  # numeric
    1082: date.fromisoformat,  # date
    1114: datetime.fromisoformat,  # timestamp
    1184: datetime.fromisoformat,  # timestamptz
    114: json.loads,  # json
    3802: json.loads,  # jsonb
}

_HEADERS = {"Neon-Raw-Text-Output": "true", "Neon-Array-Mode": "true"}
# Brief failures (rate limits, a compute waking from sleep, a dropped connection) are retried.
# A batch that committed before its reply was lost fails on retry with a duplicate key, and the
# next sync sees its files as already recorded, so a retry never imports anything twice.
_RETRY_STATUSES = {429, 502, 503, 504}
_BACKOFF_SECONDS = (0.5, 1.0, 2.0)
# How long one finos sql query may run.
_READ_ONLY_TIMEOUT = "15s"


class NeonHttpDb:
    def __init__(
        self,
        sql_url: str,
        client: httpx.Client,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.sql_url = sql_url
        self.host = urlsplit(sql_url).hostname or sql_url
        self.client = client
        self.sleep = sleep

    def execute(self, sql: str, params: Sequence[Any] = ()) -> list[Row]:
        result = self._post(_query_json(sql, params), batch=False)
        return _rows(result)

    def batch(self, queries: Sequence[Query]) -> list[list[Row]]:
        """Run every query in one transaction; if one fails, none take effect."""
        body = {"queries": [_query_json(sql, params) for sql, params in queries]}
        result = self._post(body, batch=True)
        results = result.get("results")
        if not isinstance(results, list) or len(results) != len(queries):
            raise DbError("Neon returned an unexpected batch result")
        return [_rows(r) for r in results]

    def read_only(self, sql: str) -> Table:
        """Run one query, exactly as typed, in a read-only transaction: for finos sql.

        A first query fixes the mode, so the query itself cannot turn it off, and a timeout
        stops a runaway query. A plain SET in the query would outlive the transaction on a
        reused connection, so the settings are reset after it. The SQL gets no %s conversion.
        Values come back as the text Postgres prints, so any type can be shown.
        """
        body = {
            "queries": [
                {"query": "set transaction read only", "params": []},
                {"query": f"set local statement_timeout = '{_READ_ONLY_TIMEOUT}'", "params": []},
                {"query": "select 1", "params": []},
                {"query": sql, "params": []},
                {"query": "reset all", "params": []},
            ]
        }
        results = self._post(body, batch=True, read_only=True).get("results")
        if not isinstance(results, list) or len(results) != len(body["queries"]):
            raise DbError("Neon returned an unexpected batch result")
        answer = results[-2]
        fields = answer.get("fields") or []
        rows = [tuple(row) for row in answer.get("rows") or []]
        return [f["name"] for f in fields], rows

    def _post(
        self, body: dict[str, Any], *, batch: bool, read_only: bool = False
    ) -> dict[str, Any]:
        headers = dict(_HEADERS)
        if batch:
            headers["Neon-Batch-Isolation-Level"] = "ReadCommitted"
        if read_only:
            headers["Neon-Batch-Read-Only"] = "true"
        for wait in (*_BACKOFF_SECONDS, None):
            try:
                response = self.client.post(self.sql_url, json=body, headers=headers)
            except httpx.TransportError as error:
                if wait is None:
                    # The proxy also answers brief outages with a ProxyError, so it is retried
                    # like any dropped connection; once retries run out it is most likely policy.
                    if isinstance(error, httpx.ProxyError):
                        raise DbError(proxy_refused(self.host, error)) from None
                    raise DbError(
                        f"Could not reach the database at {self.host}: {type(error).__name__}"
                    ) from None
                self.sleep(wait)
                continue
            except httpx.HTTPError as error:
                raise DbError(
                    f"Could not reach the database at {self.host}: {type(error).__name__}"
                ) from None
            if response.status_code in _RETRY_STATUSES and wait is not None:
                self.sleep(wait)
                continue
            break

        if response.status_code in (401, 403):
            raise DbError(
                self._credential_hint(
                    f"The database refused the request (HTTP {response.status_code})."
                )
            )
        if response.status_code == 400:
            # One line: a message can quote a value, and a value can hold a narration.
            message = " ".join(_error_message(response).split())
            about_credential = any(w in message.lower() for w in ("connection string", "password"))
            # A finos sql query can name a password column itself; it is the credential only if
            # a plain query fails too.
            if about_credential and not (read_only and self._reachable()):
                # Not echoed: this message is about the credential.
                raise DbError(self._credential_hint("The database rejected the credential."))
            raise DbError(f"The database rejected a query: {message[:300]}")
        if response.status_code != 200:
            raise DbError(f"The database returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError:
            raise DbError("The database returned a response that is not JSON") from None

    def _reachable(self) -> bool:
        try:
            self.execute("select 1")
        except DbError:
            return False
        return True

    def _credential_hint(self, message: str) -> str:
        return (
            f"{message} Check the cloud environment's network secret for {self.host}: it must "
            "send the Neon connection string in the Neon-Connection-String header."
        )


def _query_json(sql: str, params: Sequence[Any]) -> dict[str, Any]:
    return {
        "query": _numbered_placeholders(sql, len(params)),
        "params": [_param(p) for p in params],
    }


def _numbered_placeholders(sql: str, expected: int) -> str:
    """Turn %s into $1, $2, ... and %% into %."""
    out: list[str] = []
    count = 0
    i = 0
    while i < len(sql):
        char = sql[i]
        if char != "%":
            out.append(char)
            i += 1
            continue
        following = sql[i + 1 : i + 2]
        if following == "%":
            out.append("%")
        elif following == "s":
            count += 1
            out.append(f"${count}")
        else:
            raise ValueError(f"unsupported placeholder %{following} in SQL; use %s or %%")
        i += 2
    if count != expected:
        raise ValueError(f"SQL has {count} placeholders but {expected} parameters were given")
    return "".join(out)


def _param(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | Decimal | float | str):
        return str(value)
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, dict | list):
        return json.dumps(value, default=str)
    raise TypeError(f"cannot send a {type(value).__name__} to the database")


def _rows(result: dict[str, Any]) -> list[Row]:
    fields = result.get("fields") or []
    names = [f["name"] for f in fields]
    decoders = [_DECODERS.get(f["dataTypeID"], str) for f in fields]
    return [
        {
            name: None if value is None else decode(value)
            for name, decode, value in zip(names, decoders, row, strict=True)
        }
        for row in result.get("rows") or []
    ]


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return f"HTTP {response.status_code}"
