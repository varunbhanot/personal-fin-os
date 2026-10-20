from datetime import date
from decimal import Decimal

import pytest

from finos.categorise import load_categories, sync_categories
from finos.errors import ConfigError
from finos.goals import add_goal, assign, goal_progress, goals, remove_goal, unassign
from finos.spread import problems

from .test_month import give, txn
from .test_spread import row_id
from .test_transfers import store

JUL, AUG, SEP = date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)


@pytest.fixture
def trip(migrated_db):
    """A made-up trip paid by card over three months, and a salary."""
    db = migrated_db
    sync_categories(db, load_categories())
    store(db, "sbi-card", "04", JUL, date(2026, 9, 30),
          txn(10, "20000", "debit", "FLIGHTS", month=7),
          txn(12, "25000", "debit", "HOTEL", month=8),
          txn(5, "10000", "debit", "TOURS", month=9),
          txn(20, "4000", "credit", "HOTEL REFUND", month=9),
          txn(21, "700", "debit", "DINNER AT HOME", month=9))  # fmt: skip
    store(db, "axis-bank", "", JUL, date(2026, 9, 30), txn(1, "90000", "credit", "SALARY"))
    for narration in ("FLIGHTS", "HOTEL", "TOURS", "HOTEL REFUND"):
        give(db, narration, "Travel")
    give(db, "DINNER AT HOME", "Food & dining")
    give(db, "SALARY", "Salary")
    return db


def ids(db, *narrations):
    return [row_id(db, n) for n in narrations]


def lines(progress):
    return [(m.month, m.rows, m.spent, m.spent_to_date, m.remaining) for m in progress.months]


# --- adding a goal -----------------------------------------------------------------------


def test_a_goal_is_added_and_numbered(migrated_db):
    first = add_goal(migrated_db, "  Hill   trip ", Decimal("60000"))
    second = add_goal(migrated_db, "New sofa", Decimal("25000.50"))

    assert second == first + 1
    assert [(g.name, g.budget) for g in goals(migrated_db)] == [
        ("Hill trip", 60000), ("New sofa", Decimal("25000.50")),
    ]  # fmt: skip


@pytest.mark.parametrize("name", ["", "   ", "x" * 61, "bad\x1bname"])
def test_a_goal_name_is_1_to_60_printable_characters(migrated_db, name):
    with pytest.raises(ConfigError, match="1 to 60 printable"):
        add_goal(migrated_db, name, Decimal("100"))


@pytest.mark.parametrize("name", ["2027", " 12 "])
def test_a_goal_name_must_not_be_only_digits(migrated_db, name):
    with pytest.raises(ConfigError, match="only digits"):
        add_goal(migrated_db, name, Decimal("100"))

    assert add_goal(migrated_db, "Trip 2027", Decimal("100"))


def test_a_goal_name_is_unique_ignoring_case(migrated_db):
    add_goal(migrated_db, "Hill trip", Decimal("100"))

    with pytest.raises(ConfigError, match="already a goal"):
        add_goal(migrated_db, "HILL TRIP", Decimal("200"))


@pytest.mark.parametrize("budget", ["0", "-5", "0.001", "NaN", "Infinity", "1e15"])
def test_a_budget_is_a_positive_amount_in_rupees_and_paise(migrated_db, budget):
    with pytest.raises(ConfigError, match="budget"):
        add_goal(migrated_db, "Hill trip", Decimal(budget))


# --- rows --------------------------------------------------------------------------------


def test_progress_shows_each_month_and_the_total(trip):
    goal = add_goal(trip, "Hill trip", Decimal("60000"))
    added = assign(trip, str(goal), ids(trip, "FLIGHTS", "HOTEL", "TOURS"))

    progress = goal_progress(trip, "hill trip")

    assert (added.name, len(added.rows)) == ("Hill trip", 3)
    assert lines(progress) == [
        (JUL, 1, 20000, 20000, 40000),
        (AUG, 1, 25000, 45000, 15000),
        (SEP, 1, 10000, 55000, 5000),
    ]
    assert (progress.total.rows, progress.total.spent, progress.total.remaining) == (
        3, 55000, 5000,
    )  # fmt: skip
    assert progress.total.month is None


def test_a_refund_reduces_a_goals_spending(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))
    assign(trip, "Hill trip", ids(trip, "FLIGHTS", "HOTEL", "TOURS", "HOTEL REFUND"))

    progress = goal_progress(trip, "Hill trip")

    assert lines(progress)[-1] == (SEP, 2, 6000, 51000, 9000)
    assert progress.total.spent == 51000


def test_a_goal_with_no_rows_has_a_zero_total(trip):
    add_goal(trip, "New sofa", Decimal("25000"))

    progress = goal_progress(trip, "New sofa")

    assert progress.months == []
    assert (progress.total.rows, progress.total.spent, progress.total.remaining) == (
        0, 0, 25000,
    )  # fmt: skip
    assert [(g.name, g.spent, g.remaining, g.rows) for g in goals(trip)] == [
        ("New sofa", 0, 25000, 0)
    ]


def test_only_expense_rows_join_a_goal(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))

    with pytest.raises(ConfigError, match="not an expense"):
        assign(trip, "Hill trip", ids(trip, "FLIGHTS", "SALARY"))
    # Nothing is added when one row is refused.
    assert goal_progress(trip, "Hill trip").total.rows == 0


def test_a_row_belongs_to_one_goal(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))
    add_goal(trip, "Food", Decimal("5000"))
    assign(trip, "Hill trip", ids(trip, "FLIGHTS"))

    with pytest.raises(ConfigError, match='already in the goal "Hill trip"'):
        assign(trip, "Food", ids(trip, "FLIGHTS"))
    # Assigning it to the same goal again changes nothing.
    assert assign(trip, "Hill trip", ids(trip, "FLIGHTS")).rows
    assert goal_progress(trip, "Hill trip").total.rows == 1


def test_unassign_frees_a_row(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))
    add_goal(trip, "Food", Decimal("5000"))
    assign(trip, "Hill trip", ids(trip, "FLIGHTS", "HOTEL"))

    assert unassign(trip, ids(trip, "FLIGHTS")) == 1
    assign(trip, "Food", ids(trip, "FLIGHTS"))

    assert goal_progress(trip, "Hill trip").total.spent == 25000
    assert goal_progress(trip, "Food").total.spent == 20000


def test_unassign_refuses_a_row_in_no_goal(trip):
    with pytest.raises(ConfigError, match="in no goal"):
        unassign(trip, ids(trip, "FLIGHTS"))


@pytest.mark.parametrize("goal", ["7", "Beach trip"])
def test_an_unknown_goal_is_refused(trip, goal):
    add_goal(trip, "Hill trip", Decimal("60000"))

    with pytest.raises(ConfigError, match="No goal"):
        goal_progress(trip, goal)


def test_removing_a_goal_removes_its_rows_not_the_transactions(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))
    assign(trip, "Hill trip", ids(trip, "FLIGHTS", "HOTEL"))
    before = trip.execute("select count(*)::int as n from transactions")

    assert remove_goal(trip, "Hill trip") == "Hill trip"

    assert goals(trip) == []
    assert trip.execute("select count(*)::int as n from goal_rows") == [{"n": 0}]
    assert trip.execute("select count(*)::int as n from transactions") == before


def test_a_goal_row_whose_row_is_gone_is_listed(trip):
    goal = add_goal(trip, "Hill trip", Decimal("60000"))
    assign(trip, "Hill trip", ids(trip, "FLIGHTS", "HOTEL"))
    trip.execute("delete from transactions where narration = 'FLIGHTS'")

    progress = goal_progress(trip, "Hill trip")

    assert progress.total.spent == 25000
    [problem] = progress.problems
    assert (problem.what, problem.id, problem.state) == ("goal", goal, "not counted")
    assert (problem.date, problem.amount) == (date(2026, 7, 10), 20000)
    assert problems(trip) == progress.problems


def test_a_goal_row_that_is_no_longer_an_expense_is_listed(trip):
    add_goal(trip, "Hill trip", Decimal("60000"))
    assign(trip, "Hill trip", ids(trip, "TOURS"))
    trip.execute(
        "update categorisations set category = 'Other income' where txn_id in "
        "(select txn_id from transactions where narration = 'TOURS')"
    )

    progress = goal_progress(trip, "Hill trip")

    assert progress.total.spent == 0
    assert [p.state for p in progress.problems] == ["not an expense"]
