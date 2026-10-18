"""Writes verified statements to the database, idempotently."""

import hashlib
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict
from typing import Any, Literal

from finos.db import NeonHttpDb, Query
from finos.models import Extraction, SourceFile, Statement, Transaction

Outcome = Literal["imported", "unchanged", "replaced", "kept"]


def is_known_file(db: NeonHttpDb, drive_file_id: str, drive_md5: str) -> bool:
    """Whether this exact Drive file has been seen before."""
    rows = db.execute(
        "select 1 from drive_files where drive_file_id = %s and drive_md5 = %s",
        [drive_file_id, drive_md5],
    )
    return bool(rows)


def is_known_content(db: NeonHttpDb, sha256: str) -> bool:
    """Whether the same bytes were seen before, perhaps under another Drive name or ID."""
    return bool(db.execute("select 1 from source_files where sha256 = %s", [sha256]))


def record_file(db: NeonHttpDb, file: SourceFile) -> None:
    """Remember a file as seen, so later runs skip it without calling Claude."""
    db.batch(_record_file(file))


def forget_flagged(db: NeonHttpDb) -> int:
    """Drop flagged statements, and files kept out by a verified one, so the next sync retries
    them. Returns how many statements were dropped."""
    flagged = db.execute("select count(*)::int as n from statements where status = 'flagged'")
    unstored = "not in (select statement_id from statements)"
    db.batch(
        [
            ("delete from statements where status = 'flagged'", []),
            (f"delete from drive_files where sha256 {unstored}", []),  # noqa: S608
            (f"delete from source_files where sha256 {unstored}", []),  # noqa: S608
        ]
    )
    return flagged[0]["n"]


def store_statement(
    db: NeonHttpDb,
    file: SourceFile,
    statement: Statement,
    extraction: Extraction,
    problems: Sequence[str],
) -> Outcome:
    """Store a statement and its transactions in one transaction.

    The same file again changes nothing. A different file for the same account and period
    replaces the earlier statement and its transactions, unless the earlier one passed its
    checks and the new one did not: then the earlier one is kept ("kept"), and the new file is
    recorded as seen so it is not extracted again on every run.
    """
    statement_id = file.sha256
    existing = db.execute(
        "select statement_id, status from statements where statement_id = %s or "
        "(source = %s and account_last4 = %s and period_start = %s and period_end = %s)",
        [
            statement_id,
            statement.source,
            statement.account_last4,
            statement.period_start,
            statement.period_end,
        ],
    )
    existing_ids = {row["statement_id"] for row in existing}
    if statement_id in existing_ids:
        record_file(db, file)
        return "unchanged"
    if problems and any(row["status"] == "ok" for row in existing):
        record_file(db, file)
        return "kept"

    queries: list[Query] = [
        ("delete from statements where statement_id = %s", [old]) for old in sorted(existing_ids)
    ]
    queries += _record_file(file)
    queries.append(
        (
            "insert into statements (statement_id, source, account_last4, period_start, "
            "period_end, printed_totals, status, problems) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s)",
            [
                statement_id,
                statement.source,
                statement.account_last4,
                statement.period_start,
                statement.period_end,
                _totals_json(statement),
                "flagged" if problems else "ok",
                list(problems),
            ],
        )
    )
    queries.append(
        (
            "insert into extractions (statement_id, model, prompt_version, attempts, raw) "
            "values (%s, %s, %s, %s, %s)",
            [
                statement_id,
                extraction.model,
                extraction.prompt_version,
                extraction.attempts,
                extraction.raw,
            ],
        )
    )
    for seq, (txn, txn_id) in enumerate(_with_ids(statement_id, statement.transactions)):
        queries.append(
            (
                "insert into transactions (txn_id, statement_id, seq, txn_date, amount, "
                "direction, narration, balance) values (%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    txn_id,
                    statement_id,
                    seq,
                    txn.date,
                    txn.amount,
                    txn.direction,
                    txn.narration,
                    txn.balance,
                ],
            )
        )
    db.batch(queries)
    return "replaced" if existing_ids else "imported"


def _record_file(file: SourceFile) -> list[Query]:
    return [
        (
            "insert into source_files (sha256, name) values (%s, %s) on conflict do nothing",
            [file.sha256, file.name],
        ),
        (
            "insert into drive_files (drive_file_id, drive_md5, sha256) values (%s, %s, %s) "
            "on conflict (drive_file_id, drive_md5) do nothing",
            [file.drive_file_id, file.drive_md5, file.sha256],
        ),
    ]


def _with_ids(
    statement_id: str, transactions: Sequence[Transaction]
) -> list[tuple[Transaction, str]]:
    """Deterministic IDs: identical rows in one statement are told apart by occurrence."""
    seen: Counter[tuple[Any, ...]] = Counter()
    out = []
    for txn in transactions:
        key = (txn.date, txn.amount, txn.direction, txn.narration)
        occurrence = seen[key]
        seen[key] += 1
        material = "|".join(str(part) for part in (statement_id, *key, occurrence))
        out.append((txn, hashlib.sha256(material.encode()).hexdigest()))
    return out


def _totals_json(statement: Statement) -> dict[str, str | None]:
    return {k: None if v is None else str(v) for k, v in asdict(statement.totals).items()}
