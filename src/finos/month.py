"""finos month: income, expenses by category, savings and investments, month by month.

The arithmetic lives in the views of migrations 0006 and 0007, so finos month, finos sql and
any dashboard give the same figures. Each figure view has a cash version (a row counts in the
month of its date) and a spread version (a spread row counts in parts across its months). This
module reads the views and checks that the stored transfer links still agree with a fresh match.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from finos.db import NeonHttpDb
from finos.identify import SourceProfile
from finos.spread import SHOWN_ID
from finos.transfers import find, handles, load

_MONTH = re.compile(r"([0-9]{4})-([0-9]{2})")


@dataclass(frozen=True)
class Summary:
    """One line of v_monthly_summary."""

    month: date  # the first day of the month
    complete: bool  # every account in the record covers every day of the month
    income: Decimal
    expenses: Decimal
    savings: Decimal
    investments_in: Decimal
    investments_out: Decimal
    investments: Decimal
    # Left out of the figures: halves of linked transfers, and "Own accounts" rows.
    linked_rows: int
    linked_out: Decimal
    linked_in: Decimal
    own_rows: int
    own_out: Decimal
    own_in: Decimal
    # Counted with the category they have now.
    review_rows: int
    review_amount: Decimal
    # Not counted: no category yet.
    uncategorised_rows: int
    uncategorised_out: Decimal
    uncategorised_in: Decimal


@dataclass(frozen=True)
class Coverage:
    source: str
    account_last4: str
    days_covered: int
    days_in_month: int


@dataclass(frozen=True)
class CategoryLine:
    kind: str
    category: str
    rows: int
    gross: Decimal  # in the category's own direction: money in for income, else money out
    offsets: Decimal  # the other direction, such as refunds
    net: Decimal


@dataclass(frozen=True)
class MonthView:
    summary: Summary
    coverage: list[Coverage]
    categories: list[CategoryLine]  # in the order of the category list
    flagged: int  # flagged statements whose period overlaps the month; they are not counted
    links_stale: bool  # the stored transfer links differ from a fresh match
    spread_problems: int = 0  # with spread: spreads that add nothing now (v_spread_problems)


def parse_month(text: str) -> date | None:
    """The first day of a month written YYYY-MM, or None."""
    found = _MONTH.fullmatch(text)
    if not found or int(found[1]) < 1 or not 1 <= int(found[2]) <= 12:
        return None
    return date(int(found[1]), int(found[2]), 1)


def _views(spread: bool) -> tuple[str, str]:
    """The summary and category views: cash, or spread."""
    if spread:
        return "v_monthly_summary_spread", "v_monthly_by_category_spread"
    return "v_monthly_summary", "v_monthly_by_category"


def months(db: NeonHttpDb, *, spread: bool = False) -> list[Summary]:
    summary, _ = _views(spread)
    query = f"select * from {summary} order by month"  # noqa: S608 - a fixed view name
    return [Summary(**row) for row in db.execute(query)]


def spread_problems(db: NeonHttpDb) -> int:
    """How many spreads add nothing now."""
    found = db.execute("select count(*)::int as n from v_spread_problems where what = 'spread'")
    return found[0]["n"]


def month_view(
    db: NeonHttpDb, profiles: Sequence[SourceProfile], month: date, *, spread: bool = False
) -> MonthView | None:
    """The month in full, or None when no statement covers any day of it.

    With spread, the spread figures: a month that only a spread reaches has a view too, with
    no coverage.
    """
    summary, by_category = _views(spread)
    found = db.execute(f"select * from {summary} where month = %s", [month])  # noqa: S608
    if not found:
        return None
    coverage = db.execute(
        "select source, account_last4, days_covered, days_in_month from v_month_coverage "
        "where month = %s order by source, account_last4",
        [month],
    )
    categories = db.execute(
        f"select kind, category, rows, gross, offsets, net from {by_category} "  # noqa: S608
        "where month = %s order by position",
        [month],
    )
    flagged = db.execute(
        "select count(*)::int as n from statements where status = 'flagged' "
        "and period_start < (%s::date + interval '1 month') and period_end >= %s::date",
        [month, month],
    )[0]["n"]
    return MonthView(
        summary=Summary(**found[0]),
        coverage=[Coverage(**row) for row in coverage],
        categories=[CategoryLine(**row) for row in categories],
        flagged=flagged,
        links_stale=_links_stale(db, profiles),
        spread_problems=spread_problems(db) if spread else 0,
    )


def _links_stale(db: NeonHttpDb, profiles: Sequence[SourceProfile]) -> bool:
    """Whether a fresh match gives other pairs than transfer_links holds.

    finos month only reads, so it reports this instead of rebuilding the links.
    """
    fresh = find(load(db), profiles, handles(db))
    stored = db.execute("select debit_txn_id, credit_txn_id from transfer_links")
    return {(p.debit.txn_id, p.credit.txn_id) for p in fresh.pairs} != {
        (r["debit_txn_id"], r["credit_txn_id"]) for r in stored
    }


MAX_ROWS = 200  # rows finos rows prints at most


@dataclass(frozen=True)
class RowLine:
    """One counted row for finos rows: never its narration."""

    id: str  # the start of its txn_id, as commands take it
    date: date
    source: str
    account_last4: str
    direction: str
    amount: Decimal
    category: str | None  # None for half of a linked transfer, and for no category yet
    linked: bool
    counterparty: str | None  # the name Claude made from the narration, cleaned
    spread_id: int | None
    goal: str | None


def rows(
    db: NeonHttpDb,
    month: date | None = None,
    *,
    category: str | None = None,
    source: str | None = None,
    min_amount: Decimal | None = None,
    limit: int = MAX_ROWS,
) -> tuple[list[RowLine], int]:
    """The counted rows that fit the filters, by date, at most limit; and how many fit."""
    found = db.execute(
        "select v.txn_id, v.txn_date, v.source, v.account_last4, v.direction, v.amount, "
        "v.category, v.linked, v.counterparty, p.spread_id, g.name as goal, "
        "count(*) over ()::int as total "
        "from v_transactions v "
        "left join spreads p on p.txn_id = v.txn_id "
        "left join goal_rows r on r.txn_id = v.txn_id "
        "left join goals g on g.goal_id = r.goal_id "
        "where (%s::date is null or v.month = %s) "
        "and (%s::text is null or lower(v.category) = lower(%s)) "
        "and (%s::text is null or v.source = %s) "
        "and (%s::numeric is null or v.amount >= %s) "
        "order by v.txn_date, v.source, v.account_last4, v.txn_id limit %s",
        [month, month, category, category, source, source, min_amount, min_amount, limit],
    )
    lines = [
        RowLine(
            id=r["txn_id"][:SHOWN_ID],
            date=r["txn_date"],
            source=r["source"],
            account_last4=r["account_last4"],
            direction=r["direction"],
            amount=r["amount"],
            category=r["category"],
            linked=r["linked"],
            counterparty=r["counterparty"],
            spread_id=r["spread_id"],
            goal=r["goal"],
        )
        for r in found
    ]
    return lines, found[0]["total"] if found else 0
