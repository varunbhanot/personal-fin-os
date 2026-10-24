"""The golden record that the Python tests and the laptop UI's TypeScript tests share.

tests/ui_golden/seed.sql is the build_ui record of test_ui_views.py as plain SQL, so the
TypeScript server tests (ui/server) read the same rows without Python. expected.json holds the
figures that finos computes from that record, in the shapes of ui/server/src/record.ts, and
cost_vectors.json the costs of ai.cost_usd. The TypeScript tests check the same three files.

To make the files again after a change to build_ui or to the views, run:

    FINOS_WRITE_GOLDEN=1 uv run pytest tests/test_ui_golden.py

and read the diff before a commit: it must hold made-up data only.
"""

import json
import os
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path
from types import SimpleNamespace

from finos.ai import cost_usd
from finos.categorise import load_categories
from finos.goals import goal_progress, goals
from finos.month import month_view, months
from finos.spread import SHOWN_ID, add_months, spreads

from .test_transfers import PROFILES
from .test_ui_views import build_ui

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = Path(__file__).with_name("ui_golden")
SEED = GOLDEN / "seed.sql"
EXPECTED = GOLDEN / "expected.json"
COST_VECTORS = GOLDEN / "cost_vectors.json"
CATEGORIES_JSON = ROOT / "ui" / "server" / "src" / "categories.json"
WRITE = os.environ.get("FINOS_WRITE_GOLDEN") == "1"

UNLISTED = "Other (unlisted)"

# Every table that holds the record, parents first. schema_migrations comes from migrate.
TABLES = [
    "source_files", "drive_files", "statements", "extractions", "transactions",
    "transfer_links", "owner_handles", "categories", "household_notes", "counterparties",
    "categorisations", "narration_keys", "corrections", "spreads", "goals", "goal_rows",
    "eval_runs", "ai_usage",
]  # fmt: skip

# The rows() filters that expected.json holds, as record.ts takes them.
ROW_FILTERS = {
    "all": {"limit": 50},
    "unlisted": {"category": UNLISTED, "limit": 50},
    "september_groceries": {"month": "2026-09", "category": "Groceries", "limit": 5},
    "card_from_1000": {"source": "sbi-card", "min_amount": "1000", "limit": 1},
}


def golden(path: Path, text: str) -> None:
    """Compare with the file, or write it with FINOS_WRITE_GOLDEN=1."""
    if WRITE:
        path.parent.mkdir(exist_ok=True)
        path.write_text(text)
    assert path.read_text() == text, f"{path.name} is out of date; see this module's docstring"


# --- the seed --------------------------------------------------------------------------


def dump(db) -> str:
    """The record as insert statements, a time as its distance from now in whole minutes.

    The distances keep "this month" and "40 days ago" true whenever the seed is loaded.
    """
    found = db.execute(
        "select table_name::text as name from information_schema.tables "
        "where table_schema = 'public' and table_type = 'BASE TABLE' "
        "and table_name <> 'schema_migrations' order by 1"
    )
    assert sorted(r["name"] for r in found) == sorted(TABLES), "a table is missing from TABLES"

    lines = ["-- The build_ui record of tests/test_ui_views.py. Made by tests/test_ui_golden.py."]
    for table in TABLES:
        cols = db.execute(
            "select column_name::text as name, data_type::text as type, "
            "is_identity::text = 'YES' as identity from information_schema.columns "
            "where table_schema = 'public' and table_name = %s order by ordinal_position",
            [table],
        )
        ago = "round(extract(epoch from now() - {0}) / 60)::int"
        values = ", ".join(
            f"coalesce('now() - interval ''' || {ago.format(c['name'])} || ' minutes''', 'NULL')"
            if c["type"] == "timestamp with time zone"
            else f"quote_nullable({c['name']}::text)"
            for c in cols
        )
        names = ", ".join(c["name"] for c in cols)
        rows = db.execute(
            f"select concat_ws(', ', {values}) as v from {table} order by 1",  # noqa: S608
        )
        override = " overriding system value" if any(c["identity"] for c in cols) else ""
        for row in sorted(r["v"] for r in rows):
            # concat_ws drops a NULL: quote_nullable gives the text NULL, so none is dropped.
            lines.append(f"insert into {table} ({names}){override} values ({row});")
        for c in cols:
            if c["identity"]:
                lines.append(
                    f"select setval(pg_get_serial_sequence('{table}', '{c['name']}'), "
                    f"coalesce((select max({c['name']}) from {table}), 0) + 1, false);"
                )
    return "\n".join(lines) + "\n"


def load_seed(pg_url: str) -> None:
    import psycopg

    with psycopg.connect(pg_url, autocommit=True) as conn:
        result = conn.pgconn.exec_(SEED.read_bytes())  # simple query: many statements
        assert result.error_message in (None, b""), result.error_message


def test_the_seed_is_the_build_ui_record(migrated_db):
    golden(SEED, dump(build_ui(migrated_db)))


def test_the_seed_loads_into_a_migrated_database_as_the_same_record(migrated_db, pg_url):
    load_seed(pg_url)

    assert dump(migrated_db) == SEED.read_text()
    # The identities continue after the seed's rows.
    goal = migrated_db.execute(
        "insert into goals (name, budget) values ('Another', 1) returning goal_id"
    )
    assert goal == [{"goal_id": 2}]


def test_the_seed_holds_no_percent_sign_or_real_looking_figure():
    text = SEED.read_text()

    assert "%" not in text  # NeonHttpDb and the TS emulator would read it as a placeholder
    assert "ZQX" in text  # the planted texts that the guard tests look for


# --- the expected figures --------------------------------------------------------------


def packaged() -> dict[str, str]:
    return {c.name: c.kind for c in load_categories()}


def shown(name: str | None) -> str | None:
    """A category name as the UI shows it: packaged, or "Other (unlisted)"."""
    return name if name is None or name in packaged() else UNLISTED


def plain(value):
    """A JSON value: decimals as strings, dates as YYYY-MM-DD."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [plain(v) for v in value]
    return value


def pct(change: Decimal | None, previous: Decimal | None) -> Decimal | None:
    """change as a percentage of |previous|, to 0.1, half to even; None when previous is 0."""
    if change is None or not previous:
        return None
    found = (change * 100 / abs(previous)).quantize(Decimal("0.1"), rounding=ROUND_HALF_EVEN)
    return found.copy_abs() if found == 0 else found


def kpi(now: Decimal, before: Decimal | None) -> dict:
    change = None if before is None else now - before
    return {"value": now, "previous": before, "change": change, "pct": pct(change, before)}


def summary_dict(summary) -> dict:
    return dict(vars(summary))


def month_payload(db, month: date, *, spread: bool) -> dict:
    view = month_view(db, PROFILES, month, spread=spread)
    assert view is not None
    before = month_view(db, PROFILES, add_months(month, -1), spread=spread)
    s, p = view.summary, before.summary if before else None
    metrics = ("income", "expenses", "savings", "investments")

    # Category lines of both months, by the name the UI shows, in the category list's order.
    lines: dict[tuple[str, str], dict] = {}
    order: dict[tuple[str, str], int] = {}
    position = {
        r["name"]: r["position"]
        for r in db.execute("select name, position from categories")  # the owner reads it
    }
    for which, source in (("now", view), ("before", before)):
        for line in source.categories if source else []:
            key = (line.kind, shown(line.category))
            order[key] = min(order.get(key, 10**9), position[line.category])
            entry = lines.setdefault(
                key, {"rows": 0, "gross": Decimal(0), "offsets": Decimal(0), "net": Decimal(0),
                      "before": Decimal(0)},
            )  # fmt: skip
            if which == "now":
                entry["rows"] += line.rows
                entry["gross"] += line.gross
                entry["offsets"] += line.offsets
                entry["net"] += line.net
            else:
                entry["before"] += line.net
    categories = []
    for key in sorted(lines, key=lambda k: (order[k], k[1])):
        entry = lines[key]
        previous = entry["before"] if before else None
        change = None if previous is None else entry["net"] - previous
        categories.append(
            {
                "kind": key[0],
                "category": key[1],
                "rows": entry["rows"],
                "gross": entry["gross"],
                "offsets": entry["offsets"],
                "net": entry["net"],
                "previous": previous,
                "change": change,
                "pct": pct(change, previous),
            }
        )
    return plain(
        {
            "month": month,
            "complete": s.complete,
            "previous_month": p.month if p else None,
            "kpis": {m: kpi(getattr(s, m), getattr(p, m) if p else None) for m in metrics},
            "categories": categories,
            "coverage": [vars(c) for c in view.coverage],
            "flagged": view.flagged,
            "spread_problems": view.spread_problems,
        }
    )


def rows_payload(db, filters: dict) -> dict:
    found = db.execute("select * from v_ui_rows order by txn_date, source, account_last4, row_id")
    picked = []
    for r in found:
        if "month" in filters and r["month"].isoformat()[:7] != filters["month"]:
            continue
        if "source" in filters and r["source"] != filters["source"]:
            continue
        if "category" in filters and shown(r["category"]) != filters["category"]:
            continue
        if "min_amount" in filters and r["amount"] < Decimal(filters["min_amount"]):
            continue
        picked.append(r | {"category": shown(r["category"])})
    return plain({"total": len(picked), "rows": picked[: filters["limit"]]})


def health_payload(db) -> dict:
    cash = months(db)
    coverage = db.execute(
        "select month, source, account_last4, days_covered, days_in_month from v_month_coverage "
        "order by month, source, account_last4"
    )
    flagged = db.execute(
        "select source, account_last4, period_start, period_end, rows from v_statement_health "
        "where status = 'flagged' order by period_start, source, account_last4"
    )
    spend: dict[str, dict] = {}
    for r in db.execute(
        "select purpose, calls, cost_usd from v_ai_spend "
        "where month = date_trunc('month', now())::date"
    ):
        entry = spend.setdefault(r["purpose"], {"calls": 0, "cost_usd": Decimal(0)})
        entry["calls"] += r["calls"]
        entry["cost_usd"] += r["cost_usd"]
    version = db.execute("select max(version) as v from schema_migrations")[0]["v"]
    return plain(
        {
            "schema_version": version,
            "coverage": coverage,
            "complete_months": [s.month for s in cash if s.complete],
            "partial_months": [s.month for s in cash if not s.complete],
            "review_rows": sum(s.review_rows for s in cash),
            "review_amount": sum((s.review_amount for s in cash), Decimal(0)),
            "uncategorised_rows": sum(s.uncategorised_rows for s in cash),
            "unlinked_transfer_rows": sum(s.own_rows for s in cash),
            "unlinked_out": sum((s.own_out for s in cash), Decimal(0)),
            "unlinked_in": sum((s.own_in for s in cash), Decimal(0)),
            "flagged_statements": flagged,
            "ai_spend": [{"purpose": k} | v for k, v in sorted(spend.items())],
            "ai_spent_this_month": sum((v["cost_usd"] for v in spend.values()), Decimal(0)),
        }
    )


def goals_payload(db) -> list:
    found = []
    for g in goals(db):
        progress = goal_progress(db, str(g.goal_id))
        found.append(
            {"goal_id": g.goal_id, "name": g.name, "budget": g.budget}
            | {k: v for k, v in vars(progress.total).items() if k != "month"}
            | {"months": [vars(m) for m in progress.months]}
        )
    return plain(found)


def spreads_payload(db) -> dict:
    problems = db.execute(
        "select what, id, txn_id, txn_date, source, account_last4, direction, amount, state "
        "from v_spread_problems order by what desc, id, txn_date, txn_id"
    )
    return plain(
        {
            "spreads": [
                {
                    "spread_id": s.spread_id,
                    "row_id": s.txn_id[:SHOWN_ID],
                    "txn_date": s.date,
                    "source": s.source,
                    "account_last4": s.account_last4,
                    "direction": s.direction,
                    "amount": s.amount,
                    "start_month": s.start,
                    "months": s.months,
                }
                for s in spreads(db)
            ],
            "problems": [
                {k: v for k, v in p.items() if k != "txn_id"} | {"row_id": p["txn_id"][:SHOWN_ID]}
                for p in problems
            ],
        }
    )


def expected_record(db) -> dict:
    record: dict = {"months": {}, "month": {}}
    for name, spread in (("cash", False), ("spread", True)):
        lines = months(db, spread=spread)[-12:]
        record["months"][name] = plain([summary_dict(s) for s in lines])
        record["month"][name] = {
            s.month.isoformat()[:7]: month_payload(db, s.month, spread=spread) for s in lines
        }
    record["goals"] = goals_payload(db)
    record["spreads"] = spreads_payload(db)
    record["health"] = health_payload(db)
    record["rows"] = {name: {"filter": f} | rows_payload(db, f) for name, f in ROW_FILTERS.items()}
    return record


def test_expected_json_holds_the_figures_finos_computes_from_the_seed(migrated_db):
    record = expected_record(build_ui(migrated_db))

    golden(EXPECTED, json.dumps(record, indent=1, ensure_ascii=False) + "\n")


def test_expected_json_has_the_figures_it_is_for(migrated_db):
    record = json.loads(EXPECTED.read_text())

    assert list(record["month"]["cash"]) == ["2026-08", "2026-09"]
    assert record["month"]["cash"]["2026-08"]["previous_month"] is None
    sep = record["month"]["cash"]["2026-09"]
    assert sep["kpis"]["income"]["previous"] is not None
    assert UNLISTED in [c["category"] for c in sep["categories"]]
    assert record["goals"] and record["spreads"]["spreads"]
    assert record["health"]["flagged_statements"]
    assert record["rows"]["card_from_1000"]["total"] > len(record["rows"]["card_from_1000"]["rows"])


def test_expected_json_shows_no_planted_text_but_the_goal_name():
    text = EXPECTED.read_text()
    goals_part = json.dumps(json.loads(text)["goals"])

    assert text.count("ZQX") == goals_part.count("ZQX") == 1  # the goal's name, browser only


# --- costs and categories --------------------------------------------------------------


def test_each_cost_vector_is_what_ai_cost_usd_gives():
    vectors = json.loads(COST_VECTORS.read_text())

    assert len(vectors) >= 8
    for vector in vectors:
        usage = SimpleNamespace(**vector["usage"])
        assert str(cost_usd(vector["model"], usage)) == vector["cost_usd"], vector["name"]


def test_the_cost_vectors_cover_half_even_and_unpriced_models():
    names = {v["name"] for v in json.loads(COST_VECTORS.read_text())}

    assert {"half to even, down", "half to even, up", "dated model", "unknown model"} <= names


def test_the_ui_server_holds_the_packaged_categories_in_order():
    found = json.loads(CATEGORIES_JSON.read_text())

    assert found == [{"name": c.name, "kind": c.kind} for c in load_categories()]
