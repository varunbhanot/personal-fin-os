import random
from datetime import date
from decimal import Decimal

import pytest

from finos.categorise import load_categories, sync_categories
from finos.errors import ConfigError
from finos.month import month_view, months
from finos.spread import add_months, add_spread, find_row, parts, problems, remove_spread, spreads

from .test_month import AUG, OCT, SEP, build, by_category, give, txn
from .test_transfers import PROFILES, store

APR, MAY, JUN, JUL = date(2026, 4, 1), date(2026, 5, 1), date(2026, 6, 1), date(2026, 7, 1)


def row_id(db, narration):
    """The first 8 characters of a row's ID, as finos rows prints them."""
    return db.execute("select txn_id from transactions where narration = %s", [narration])[0][
        "txn_id"
    ][:8]


@pytest.fixture
def record(migrated_db):
    return build(migrated_db)


@pytest.fixture
def school(migrated_db):
    """A made-up April with one quarterly school fee."""
    db = migrated_db
    sync_categories(db, load_categories())
    store(db, "axis-bank", "", APR, date(2026, 4, 30),
          txn(10, "45000", "debit", "SCHOOL FEE", month=4),
          txn(12, "2000", "debit", "BOOKS", month=4))  # fmt: skip
    give(db, "SCHOOL FEE", "Education")
    give(db, "BOOKS", "Education")
    return db


# --- parts -------------------------------------------------------------------------------


def test_parts_are_equal_and_the_last_month_takes_the_remaining_paise():
    assert parts(Decimal("100.00"), 3) == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]
    assert parts(Decimal("45000"), 3) == [Decimal("15000.00")] * 3


def test_parts_of_money_in_are_negative_the_same_way():
    assert parts(Decimal("-100.00"), 3) == [
        Decimal("-33.33"), Decimal("-33.33"), Decimal("-33.34"),
    ]  # fmt: skip


def test_parts_always_add_up_to_the_value():
    pick = random.Random(7)  # noqa: S311 - made-up amounts, not security
    for _ in range(500):
        value = Decimal(pick.randint(-10_000_000, 10_000_000)) / 100
        n = pick.randint(1, 60)
        found = parts(value, n)
        assert len(found) == n
        assert sum(found) == value
        assert all(p == found[0] for p in found[:-1])
        assert all(p.as_tuple().exponent >= -2 for p in found)


# --- the spread views --------------------------------------------------------------------


def test_a_school_fee_spreads_over_three_months(school):
    spread = add_spread(school, row_id(school, "SCHOOL FEE"), 3)

    assert spread.parts() == [(APR, Decimal("15000.00")), (MAY, 15000), (JUN, 15000)]
    for m in (APR, MAY, JUN):
        view = month_view(school, PROFILES, m, spread=True)
        assert by_category(view)["Education"][2] == (17000 if m == APR else 15000)
    # The cash figures do not change.
    cash = month_view(school, PROFILES, APR)
    assert by_category(cash)["Education"] == (47000, 0, 47000)
    assert month_view(school, PROFILES, MAY) is None


def test_months_a_spread_reaches_beyond_the_record_are_partial_with_no_coverage(school):
    add_spread(school, row_id(school, "SCHOOL FEE"), 3)

    listed = [(m.month, m.complete, m.expenses) for m in months(school, spread=True)]

    assert listed == [(APR, True, 17000), (MAY, False, 15000), (JUN, False, 15000)]
    assert month_view(school, PROFILES, JUN, spread=True).coverage == []


def test_the_spread_summary_equals_the_cash_summary_without_spreads(record):
    cash = record.execute("select * from v_monthly_summary order by month")
    spread = record.execute("select * from v_monthly_summary_spread order by month")

    assert cash and spread == cash
    assert months(record, spread=True) == months(record)
    for m in (AUG, SEP):
        assert month_view(record, PROFILES, m, spread=True).categories == (
            month_view(record, PROFILES, m).categories
        )


def test_a_refund_spread_back_reduces_the_months_it_pays_for(migrated_db):
    db = migrated_db
    sync_categories(db, load_categories())
    store(db, "axis-bank", "", OCT, date(2026, 10, 31),
          txn(5, "30000", "debit", "LOAN EMI", month=10),
          txn(7, "30000", "credit", "BUILDER", month=10))  # fmt: skip
    give(db, "LOAN EMI", "Loan EMI")
    give(db, "BUILDER", "Loan EMI")

    spread = add_spread(db, row_id(db, "BUILDER"), 3, start=JUL)

    assert spread.parts() == [(JUL, Decimal("-10000.00")), (AUG, -10000), (SEP, -10000)]
    for m in (JUL, AUG, SEP):
        view = month_view(db, PROFILES, m, spread=True)
        assert by_category(view)["Loan EMI"] == (0, Decimal("10000.00"), Decimal("-10000.00"))
    october = month_view(db, PROFILES, OCT, spread=True)
    assert by_category(october)["Loan EMI"] == (30000, 0, 30000)
    assert october.summary.expenses == 30000


def test_the_views_and_parts_agree(school):
    for narration, n in (("SCHOOL FEE", 7), ("BOOKS", 3)):
        add_spread(school, row_id(school, narration), n)
    stored = school.execute(
        "select t.narration, v.value from v_transactions_spread v "
        "join transactions t using (txn_id) where v.spread_id is not null order by v.month"
    )

    for narration, value, n in (("SCHOOL FEE", Decimal(45000), 7), ("BOOKS", Decimal(2000), 3)):
        assert [r["value"] for r in stored if r["narration"] == narration] == parts(value, n)


def test_a_row_that_becomes_a_transfer_adds_nothing_and_is_listed(record):
    spread = add_spread(record, row_id(record, "GROCER"), 2)
    record.execute(
        "insert into transfer_links (debit_txn_id, credit_txn_id, evidence) "
        "select d.txn_id, c.txn_id, 'test' from transactions d, transactions c "
        "where d.narration = 'GROCER' and c.narration = 'INTEREST'"
    )

    view = month_view(record, PROFILES, SEP, spread=True)

    assert "Groceries" not in by_category(view)
    assert view.spread_problems == 1
    assert [(p.what, p.id, p.state) for p in problems(record)] == [
        ("spread", spread.spread_id, "transfer")
    ]


def test_a_row_that_loses_its_category_adds_nothing_and_is_listed(record):
    add_spread(record, row_id(record, "GROCER"), 2)
    record.execute(
        "delete from categorisations where txn_id in "
        "(select txn_id from transactions where narration = 'GROCER')"
    )

    assert "Groceries" not in by_category(month_view(record, PROFILES, SEP, spread=True))
    assert [p.state for p in problems(record)] == ["no category"]


def test_a_spread_whose_row_is_gone_adds_nothing_and_keeps_its_copy(record):
    spread = add_spread(record, row_id(record, "GROCER"), 2)
    record.execute("delete from transactions where narration = 'GROCER'")

    view = month_view(record, PROFILES, SEP, spread=True)

    assert "Groceries" not in by_category(view)
    [problem] = problems(record)
    assert (problem.what, problem.id, problem.state) == ("spread", spread.spread_id, "not counted")
    assert (problem.date, problem.source, problem.account_last4) == (
        date(2026, 9, 3), "axis-bank", ""
    )  # fmt: skip
    assert (problem.direction, problem.amount) == ("debit", Decimal("3456.75"))
    [listed] = spreads(record)
    assert listed.value is None and listed.problem == "not counted"
    assert listed.parts() == []


def test_rows_that_do_not_count_stay_out_of_the_spread_views(record):
    # A spread stored for a row of a flagged statement, as if the statement became flagged.
    record.execute(
        "insert into spreads (txn_id, txn_date, source, account_last4, direction, amount, "
        "start_month, months) select txn_id, txn_date, 'sbi-bank', '1111', direction, amount, "
        "'2026-09-01', 3 from transactions where narration = 'FLAGGED ROW'"
    )

    assert record.execute(
        "select count(*)::int as n from v_transactions_spread v join transactions t "
        "using (txn_id) where t.narration = 'FLAGGED ROW'"
    ) == [{"n": 0}]
    assert [p.state for p in problems(record)] == ["not counted"]
    with pytest.raises(ConfigError, match="No counted row"):
        find_row(record, row_id(record, "FLAGGED ROW"))


def test_an_overlapped_day_stays_out_of_the_spread_views(migrated_db):
    db = migrated_db
    sync_categories(db, load_categories())
    store(db, "axis-bank", "", SEP, date(2026, 9, 20), txn(15, "600", "debit", "EARLY COPY"))
    store(db, "axis-bank", "", date(2026, 9, 10), date(2026, 9, 30),
          txn(15, "600", "debit", "LATE COPY"))  # fmt: skip
    give(db, "EARLY COPY", "Groceries")
    give(db, "LATE COPY", "Groceries")

    with pytest.raises(ConfigError, match="No counted row"):
        find_row(db, row_id(db, "EARLY COPY"))
    add_spread(db, row_id(db, "LATE COPY"), 2)

    assert sum(m.expenses for m in months(db, spread=True)) == 600


def test_an_investment_spread_stays_apart_from_income_and_expenses(record):
    add_spread(record, row_id(record, "SIP"), 2)

    sep = month_view(record, PROFILES, SEP, spread=True).summary
    oct_ = month_view(record, PROFILES, OCT, spread=True).summary

    assert (sep.investments_in, sep.investments_out, sep.investments) == (12500, 5000, 7500)
    assert (oct_.investments_in, oct_.investments, oct_.income, oct_.expenses) == (
        12500, 12500, 0, 0,
    )  # fmt: skip
    assert sep.income == month_view(record, PROFILES, SEP).summary.income


def test_no_spread_view_has_a_narration_column(record):
    columns = record.execute(
        "select table_name, column_name from information_schema.columns "
        "where table_name in ('v_transactions_spread', 'v_monthly_by_category_spread', "
        "'v_monthly_summary_spread', 'v_goal_progress', 'v_spread_problems')"
    )

    assert {c["table_name"] for c in columns} == {
        "v_transactions_spread", "v_monthly_by_category_spread", "v_monthly_summary_spread",
        "v_goal_progress", "v_spread_problems",
    }  # fmt: skip
    assert "narration" not in {c["column_name"] for c in columns}


# --- naming a row ------------------------------------------------------------------------


def test_a_row_is_found_by_six_or_more_characters_of_its_id(record):
    full = record.execute("select txn_id from transactions where narration = 'GROCER'")[0]["txn_id"]

    for text in (full[:6], full[:8], full.upper()[:10], f" {full[:8]} "):
        found = find_row(record, text)
        assert (found.txn_id, found.category, found.amount) == (full, "Groceries", 3456.75)


@pytest.mark.parametrize("text", ["abc12", "", "ghijklmn", "12-456"])
def test_a_row_id_must_be_six_or_more_hex_characters(record, text):
    with pytest.raises(ConfigError, match="6 or more"):
        find_row(record, text)


def test_an_unknown_row_id_is_refused(record):
    with pytest.raises(ConfigError, match="No counted row"):
        find_row(record, "ffffffffff")


def test_an_id_that_matches_two_rows_is_refused(migrated_db):
    db = migrated_db
    store(db, "axis-bank", "", SEP, date(2026, 9, 30),
          txn(1, "10", "debit", "ONE"), txn(2, "20", "debit", "TWO"))  # fmt: skip
    db.execute("update transactions set txn_id = 'abcdef0' || seq")

    with pytest.raises(ConfigError, match="matches 2 rows"):
        find_row(db, "abcdef")
    assert find_row(db, "abcdef01").amount == 20


# --- adding and removing -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("narration", "why"),
    [("SBI CARD PAYMENT", "linked transfer"), ("TO MY DEPOSIT", "Own accounts"),
     ("NEW PAYEE", "no category")],
)  # fmt: skip
def test_a_row_without_a_value_cannot_be_spread(record, narration, why):
    with pytest.raises(ConfigError, match=why):
        add_spread(record, row_id(record, narration), 3)


@pytest.mark.parametrize("n", [0, -1, 61])
def test_a_spread_is_1_to_60_months(record, n):
    with pytest.raises(ConfigError, match="1 to 60"):
        add_spread(record, row_id(record, "GROCER"), n)


def test_a_start_must_be_the_first_day_of_a_month(record):
    with pytest.raises(ConfigError, match="first day"):
        add_spread(record, row_id(record, "GROCER"), 2, start=date(2026, 9, 2))


@pytest.mark.parametrize(
    "start", [date(9999, 12, 1), date(1, 1, 1), date(2021, 8, 1), date(2031, 10, 1)]
)
def test_a_start_far_from_the_rows_month_is_refused_and_nothing_is_stored(record, start):
    with pytest.raises(ConfigError, match="at most 60 months"):
        add_spread(record, row_id(record, "GROCER"), 2, start=start)

    assert spreads(record) == []


def test_a_start_60_months_from_the_rows_month_is_accepted(record):
    early = add_spread(record, row_id(record, "GROCER"), 2, start=date(2021, 9, 1))
    late = add_spread(record, row_id(record, "RENT"), 2, start=date(2031, 9, 1))

    assert early.parts()[0][0] == date(2021, 9, 1)
    assert late.parts()[-1][0] == date(2031, 10, 1)


def test_a_row_too_small_for_its_months_is_refused(migrated_db):
    db = migrated_db
    sync_categories(db, load_categories())
    store(db, "axis-bank", "", APR, date(2026, 4, 30), txn(3, "0.50", "debit", "TIP", month=4))
    give(db, "TIP", "Food & dining")

    with pytest.raises(ConfigError, match="too small"):
        add_spread(db, row_id(db, "TIP"), 51)
    assert add_spread(db, row_id(db, "TIP"), 50).parts()[-1] == (
        add_months(APR, 49),
        Decimal("0.01"),
    )
    assert spreads(db)[0].months == 50


def test_a_row_is_spread_once(record):
    first = add_spread(record, row_id(record, "GROCER"), 2)

    with pytest.raises(ConfigError, match=f"already spread \\(spread {first.spread_id}\\)"):
        add_spread(record, row_id(record, "GROCER"), 3)


def test_a_spread_starts_in_the_rows_month_unless_told(record):
    plain = add_spread(record, row_id(record, "GROCER"), 2)
    earlier = add_spread(record, row_id(record, "RENT"), 1, start=JUL)

    assert (plain.start, plain.months) == (SEP, 2)
    assert earlier.parts() == [(JUL, Decimal("40000.00"))]
    # A one-month move takes the row out of its own month.
    assert by_category(month_view(record, PROFILES, SEP, spread=True))["Rent"] == (
        0, 5000, -5000,
    )  # fmt: skip


def test_spreads_are_listed_with_their_current_value(record):
    first = add_spread(record, row_id(record, "GROCER"), 2)
    second = add_spread(record, row_id(record, "OLD LANDLORD"), 2)

    listed = spreads(record)

    assert [(s.spread_id, s.value, s.category, s.problem) for s in listed] == [
        (first.spread_id, Decimal("3456.75"), "Groceries", None),
        (second.spread_id, Decimal("-5000"), "Rent", None),
    ]
    assert listed[1].parts() == [(SEP, Decimal("-2500.00")), (OCT, Decimal("-2500.00"))]


def test_a_spread_is_removed_by_its_number_or_its_row(record):
    first = add_spread(record, row_id(record, "GROCER"), 2)
    add_spread(record, row_id(record, "RENT"), 2)

    assert remove_spread(record, str(first.spread_id)).spread_id == first.spread_id
    assert remove_spread(record, row_id(record, "RENT")).category == "Rent"
    assert spreads(record) == []


def test_a_gone_rows_spread_can_still_be_removed_by_its_row(record):
    rid = row_id(record, "GROCER")
    add_spread(record, rid, 2)
    record.execute("delete from transactions where narration = 'GROCER'")

    assert remove_spread(record, rid).problem == "not counted"
    assert problems(record) == []


@pytest.mark.parametrize("text", ["99", "ffffffff", "xyz"])
def test_removing_an_unknown_spread_says_so(record, text):
    with pytest.raises(ConfigError, match="No spread"):
        remove_spread(record, text)
