"""finos month: income, expenses by category, savings and investments, month by month.

The arithmetic lives in the views of migration 0005, so finos month, finos sql and any
dashboard give the same figures. This module reads the views and checks that the stored
transfer links still agree with a fresh match.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from finos.db import NeonHttpDb
from finos.identify import SourceProfile
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


def parse_month(text: str) -> date | None:
    """The first day of a month written YYYY-MM, or None."""
    found = _MONTH.fullmatch(text)
    if not found or int(found[1]) < 1 or not 1 <= int(found[2]) <= 12:
        return None
    return date(int(found[1]), int(found[2]), 1)


def months(db: NeonHttpDb) -> list[Summary]:
    return [Summary(**row) for row in db.execute("select * from v_monthly_summary order by month")]


def month_view(db: NeonHttpDb, profiles: Sequence[SourceProfile], month: date) -> MonthView | None:
    """The month in full, or None when no statement covers any day of it."""
    found = db.execute("select * from v_monthly_summary where month = %s", [month])
    if not found:
        return None
    coverage = db.execute(
        "select source, account_last4, days_covered, days_in_month from v_month_coverage "
        "where month = %s order by source, account_last4",
        [month],
    )
    categories = db.execute(
        "select kind, category, rows, gross, offsets, net from v_monthly_by_category "
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
