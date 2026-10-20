"""finos goal: a budget for something you spend on over months, such as a trip.

You give a goal its rows by their IDs from finos rows. v_goal_progress (migration 0007) adds
them up month by month, by each row's cash month, so the total does not depend on spreads.
Goal names are personal: they live in the database, never in the repository.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from finos.db import NeonHttpDb, Query
from finos.errors import ConfigError
from finos.spread import SHOWN_ID, Problem, Row, find_row, id_prefix, problems

MAX_NAME = 60
MAX_BUDGET = Decimal("999999999999.99")  # numeric(14, 2)


@dataclass(frozen=True)
class Progress:
    """One line of v_goal_progress: a month, or the total (month None)."""

    month: date | None
    rows: int
    spent: Decimal  # expense rows of the goal; refunds take away
    spent_to_date: Decimal
    remaining: Decimal  # budget less spent_to_date


@dataclass(frozen=True)
class Goal:
    goal_id: int
    name: str
    budget: Decimal
    rows: int
    spent: Decimal
    remaining: Decimal


@dataclass(frozen=True)
class GoalProgress:
    goal_id: int
    name: str
    budget: Decimal
    months: list[Progress]
    total: Progress
    problems: list[Problem]  # rows of the goal that add nothing now


@dataclass(frozen=True)
class Assigned:
    name: str
    rows: list[Row]


def add_goal(db: NeonHttpDb, name: str, budget: Decimal) -> int:
    """Add a goal and return its number."""
    name = " ".join(name.split())
    if not name or not name.isprintable() or len(name) > MAX_NAME:
        raise ConfigError(f"A goal name must be 1 to {MAX_NAME} printable characters.")
    if name.isdigit():
        raise ConfigError("A goal name must not be only digits: a number names a goal by its ID.")
    try:
        whole_paise = budget == budget.quantize(Decimal("0.01"))
    except InvalidOperation:
        whole_paise = False
    if not budget.is_finite() or not whole_paise or not 0 < budget <= MAX_BUDGET:
        raise ConfigError("A budget must be more than 0, in rupees and paise, such as 60000.")
    if db.execute("select 1 from goals where lower(name) = lower(%s)", [name]):
        raise ConfigError(f'There is already a goal named "{name}".')
    found = db.execute(
        "insert into goals (name, budget) values (%s, %s) returning goal_id", [name, budget]
    )
    return found[0]["goal_id"]


def goals(db: NeonHttpDb) -> list[Goal]:
    """Each goal with its total, by number."""
    found = db.execute(
        "select goal_id, goal as name, budget, rows, spent, remaining from v_goal_progress "
        "where month is null order by goal_id"
    )
    return [Goal(**row) for row in found]


def goal_progress(db: NeonHttpDb, goal: str) -> GoalProgress:
    """A goal month by month, its total, and its rows that add nothing now."""
    goal_id, name, budget = _goal(db, goal)
    found = db.execute(
        "select month, rows, spent, spent_to_date, remaining from v_goal_progress "
        "where goal_id = %s order by month nulls last",
        [goal_id],
    )
    lines = [Progress(**row) for row in found]
    return GoalProgress(
        goal_id=goal_id,
        name=name,
        budget=budget,
        months=lines[:-1],
        total=lines[-1],
        problems=problems(db, goal_id=goal_id),
    )


def assign(db: NeonHttpDb, goal: str, row_ids: Sequence[str]) -> Assigned:
    """Add rows to a goal. Every row is checked first: one refusal adds nothing."""
    goal_id, name, _ = _goal(db, goal)
    found = [find_row(db, text) for text in row_ids]
    queries: list[Query] = []
    for row in found:
        if row.kind != "expense":
            raise ConfigError(
                f"Row {row.txn_id[:SHOWN_ID]} is not an expense. A goal holds money spent, and "
                "refunds of it."
            )
        other = db.execute(
            "select g.goal_id, g.name from goal_rows r join goals g using (goal_id) "
            "where r.txn_id = %s",
            [row.txn_id],
        )
        if other and other[0]["goal_id"] != goal_id:
            raise ConfigError(
                f'Row {row.txn_id[:SHOWN_ID]} is already in the goal "{other[0]["name"]}". Free '
                f"it first with finos goal unassign {row.txn_id[:SHOWN_ID]}."
            )
        queries.append(
            (
                "insert into goal_rows (txn_id, goal_id, txn_date, source, account_last4, "
                "direction, amount) values (%s, %s, %s, %s, %s, %s, %s) "
                "on conflict (txn_id) do nothing",
                [
                    row.txn_id,
                    goal_id,
                    row.date,
                    row.source,
                    row.account_last4,
                    row.direction,
                    row.amount,
                ],
            )
        )
    if queries:
        db.batch(queries)
    return Assigned(name=name, rows=found)


def unassign(db: NeonHttpDb, row_ids: Sequence[str]) -> int:
    """Take rows out of their goal, even rows that no longer count. Returns how many."""
    chosen = []
    for text in row_ids:
        prefix = id_prefix(text)
        found = db.execute(
            "select txn_id from goal_rows where txn_id like %s limit 2", [prefix + "%"]
        )
        if len(found) != 1:
            raise ConfigError(
                f'No row in a goal has an ID that starts with "{prefix}": it is in no goal.'
                if not found
                else f'"{prefix}" matches 2 rows or more. Give more characters of the ID.'
            )
        chosen.append(found[0]["txn_id"])
    db.batch([("delete from goal_rows where txn_id = %s", [txn_id]) for txn_id in chosen])
    return len(set(chosen))


def remove_goal(db: NeonHttpDb, goal: str) -> str:
    """Remove a goal and its rows; the transactions do not change. Returns its name."""
    goal_id, name, _ = _goal(db, goal)
    db.execute("delete from goals where goal_id = %s", [goal_id])
    return name


def _goal(db: NeonHttpDb, text: str) -> tuple[int, str, Decimal]:
    """A goal named by its number or its name, ignoring case."""
    text = " ".join(text.split())
    if text.isdigit():
        found = db.execute(
            "select goal_id, name, budget from goals where goal_id = %s", [int(text)]
        )
    else:
        found = db.execute(
            "select goal_id, name, budget from goals where lower(name) = lower(%s)", [text]
        )
    if not found:
        raise ConfigError(f'No goal is named "{text}". Run finos goal list to see the goals.')
    return found[0]["goal_id"], found[0]["name"], found[0]["budget"]
