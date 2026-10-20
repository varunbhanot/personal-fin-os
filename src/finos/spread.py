"""finos spread: count one row's value in equal parts across months.

A quarterly school fee paid in April counts a third in each of April, May and June, and a
refund that pays for earlier months can be set against them. The parts are made in the view
v_transactions_spread of migration 0007; parts() here does the same arithmetic, so a command
can show them before you look at a month.

A row is named by the start of its txn_id, as finos rows prints it: no narration is ever typed
back into a shell or printed.
"""

import re
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_DOWN, Decimal

from finos.db import NeonHttpDb
from finos.errors import ConfigError

MIN_ID = 6  # characters of a txn_id that name a row
SHOWN_ID = 8  # characters finos rows prints
MAX_MONTHS = 60
MAX_SHIFT = 60  # months a spread can start before or after its row's own month
SPREADABLE = ("expense", "income", "investment")

_HEX = re.compile(r"[0-9a-f]+")


def parts(value: Decimal, months: int) -> list[Decimal]:
    """value in months equal parts, in paise, toward zero; the last part takes what is left."""
    share = (value * 100 / months).to_integral_value(rounding=ROUND_DOWN) / 100
    return [share] * (months - 1) + [value - share * (months - 1)]


def months_between(first: date, last: date) -> int:
    return (last.year - first.year) * 12 + last.month - first.month


def add_months(month: date, n: int) -> date:
    index = month.year * 12 + month.month - 1 + n
    return date(index // 12, index % 12 + 1, 1)


@dataclass(frozen=True)
class Row:
    """A counted row, as v_transactions shows it."""

    txn_id: str
    date: date
    month: date
    source: str
    account_last4: str
    direction: str
    amount: Decimal
    category: str | None
    kind: str | None
    linked: bool
    value: Decimal | None


@dataclass(frozen=True)
class Spread:
    spread_id: int
    txn_id: str
    date: date  # the stored copy: still known when the row is gone
    source: str
    account_last4: str
    direction: str
    amount: Decimal
    start: date
    months: int
    category: str | None  # now, or None when the row does not count
    value: Decimal | None  # now; None when the spread adds nothing (see problem)
    problem: str | None  # a v_spread_problems state, or None

    def parts(self) -> list[tuple[date, Decimal]]:
        """Each month and its part, or nothing while the spread adds nothing."""
        if self.value is None:
            return []
        return [
            (add_months(self.start, i), part)
            for i, part in enumerate(parts(self.value, self.months))
        ]


@dataclass(frozen=True)
class Problem:
    """A spread or a goal row that adds nothing now, named by its stored copy."""

    what: str  # 'spread' or 'goal'
    id: int  # the spread's or the goal's number
    txn_id: str
    date: date
    source: str
    account_last4: str
    direction: str
    amount: Decimal
    state: str  # 'not counted', 'transfer', 'no category' or 'not an expense'


def id_prefix(text: str) -> str:
    """The start of a txn_id, checked: 6 or more hex characters."""
    prefix = text.strip().lower()
    if len(prefix) < MIN_ID or not _HEX.fullmatch(prefix):
        raise ConfigError(
            f'"{text}" is not a row ID. Use {MIN_ID} or more characters of the ID that '
            "finos rows prints."
        )
    return prefix


def find_row(db: NeonHttpDb, text: str) -> Row:
    """The one counted row whose ID starts with text."""
    prefix = id_prefix(text)
    found = db.execute(
        "select txn_id, txn_date as date, month, source, account_last4, direction, amount, "
        "category, kind, linked, value from v_transactions where txn_id like %s "
        "order by txn_id limit 2",
        [prefix + "%"],
    )
    if not found:
        raise ConfigError(
            f'No counted row has an ID that starts with "{prefix}". Run finos rows to see the IDs.'
        )
    if len(found) > 1:
        raise ConfigError(f'"{prefix}" matches 2 rows or more. Give more characters of the ID.')
    return Row(**found[0])


def add_spread(db: NeonHttpDb, text: str, months: int, start: date | None = None) -> Spread:
    """Spread a row over months, from start (the row's own month when None)."""
    row = find_row(db, text)
    if row.value is None:
        if row.linked:
            why = "is half of a linked transfer, which is neither income nor spending"
        elif row.kind == "transfer":
            why = "is in Own accounts, which is neither income nor spending"
        else:
            why = "has no category yet. Run finos categorise first"
        raise ConfigError(f"Row {row.txn_id[:SHOWN_ID]} {why}.")
    if not 1 <= months <= MAX_MONTHS:
        raise ConfigError(f"A spread is 1 to {MAX_MONTHS} months.")
    if start is not None and start.day != 1:
        raise ConfigError("A spread starts on the first day of a month.")
    if start is not None and abs(months_between(row.month, start)) > MAX_SHIFT:
        raise ConfigError(
            f"A spread starts at most {MAX_SHIFT} months before or after the month of its row."
        )
    if abs(row.value) * 100 < months:
        raise ConfigError(
            f"Row {row.txn_id[:SHOWN_ID]} is too small to spread over {months} months: a part "
            "would be 0."
        )
    added = db.execute(
        "insert into spreads (txn_id, txn_date, source, account_last4, direction, amount, "
        "start_month, months) values (%s, %s, %s, %s, %s, %s, %s, %s) "
        "on conflict (txn_id) do nothing returning spread_id",
        [
            row.txn_id,
            row.date,
            row.source,
            row.account_last4,
            row.direction,
            row.amount,
            start or row.month,
            months,
        ],
    )
    if not added:
        old = db.execute("select spread_id from spreads where txn_id = %s", [row.txn_id])
        number = old[0]["spread_id"]
        raise ConfigError(
            f"Row {row.txn_id[:SHOWN_ID]} is already spread (spread {number}). Remove it with "
            f"finos spread remove {number} first."
        )
    return _spreads(db, spread_id=added[0]["spread_id"])[0]


def spreads(db: NeonHttpDb) -> list[Spread]:
    return _spreads(db)


def remove_spread(db: NeonHttpDb, text: str) -> Spread:
    """Remove a spread named by its number or by its row's ID, even when the row is gone."""
    text = text.strip()
    found = []
    if text.isdigit() and len(text) < MIN_ID:
        found = _spreads(db, spread_id=int(text))
    elif _HEX.fullmatch(text.lower()) and len(text) >= MIN_ID:
        found = _spreads(db, prefix=text.lower())
    if len(found) != 1:
        raise ConfigError(
            f'No spread is named "{text}". Run finos spread list to see the numbers.'
            if not found
            else f'"{text}" matches {len(found)} spreads. Use the spread number.'
        )
    db.execute("delete from spreads where spread_id = %s", [found[0].spread_id])
    return found[0]


def problems(db: NeonHttpDb, what: str | None = None, goal_id: int | None = None) -> list[Problem]:
    """The spreads and goal rows that add nothing now, oldest row first."""
    rows = db.execute(
        "select what, id, txn_id, txn_date as date, source, account_last4, direction, amount, "
        "state from v_spread_problems where (%s::text is null or what = %s) "
        "and (%s::bigint is null or (what = 'goal' and id = %s)) "
        "order by what desc, txn_date, txn_id",
        [what, what, goal_id, goal_id],
    )
    return [Problem(**row) for row in rows]


def _spreads(
    db: NeonHttpDb, *, spread_id: int | None = None, prefix: str | None = None
) -> list[Spread]:
    """The spreads, all or one by number or by the start of its row's ID."""
    rows = db.execute(
        "select p.spread_id, p.txn_id, p.txn_date as date, p.source, p.account_last4, "
        "p.direction, p.amount, p.start_month as start, p.months, v.category, v.value, "
        "x.state as problem from spreads p "
        "left join v_transactions v on v.txn_id = p.txn_id "
        "left join v_spread_problems x on x.what = 'spread' and x.id = p.spread_id "
        "where (%s::bigint is null or p.spread_id = %s) "
        "and (%s::text is null or p.txn_id like %s || '%%') order by p.spread_id",
        [spread_id, spread_id, prefix, prefix],
    )
    return [Spread(**row) for row in rows]
