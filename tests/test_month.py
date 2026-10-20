from datetime import date
from decimal import Decimal

import pytest

from finos.categorise import load_categories, sync_categories
from finos.models import Transaction
from finos.month import month_view, months, parse_month
from finos.transfers import load, rebuild

from .test_transfers import PROFILES, store

JUL, AUG, SEP, OCT = date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1), date(2026, 10, 1)
SEP30 = date(2026, 9, 30)


def txn(day, amount, direction, narration, month=9):
    return Transaction(date(2026, month, day), Decimal(amount), direction, narration)


def give(db, narration, category, *, review=False):
    """Categorise the row with this narration, as finos categorise stores it."""
    db.execute(
        "insert into categorisations (txn_id, counterparty, category, confidence, reason, "
        "origin, needs_review) select txn_id, 'Payee', %s, 'high', '-', 'ai', %s "
        "from transactions where narration = %s",
        [category, review, narration],
    )


# One made-up record with every kind of row. The narrations only name the rows for give().
BANK = [
    (txn(1, "150000", "credit", "SALARY"), "Salary"),
    (txn(2, "1200.50", "credit", "INTEREST"), "Interest & dividends"),
    (txn(3, "3456.75", "debit", "GROCER"), "Groceries"),
    (txn(4, "40000", "debit", "RENT"), "Rent"),
    (txn(5, "5000", "credit", "OLD LANDLORD"), "Rent"),  # a settlement: a refund of rent
    (txn(6, "30000", "debit", "LOAN EMI"), "Loan EMI"),
    (txn(7, "10000", "credit", "BUILDER"), "Loan EMI"),  # the builder pays part of the EMI
    (txn(8, "25000", "debit", "SIP"), "Investments"),
    (txn(9, "5000", "credit", "REDEMPTION"), "Investments"),
    # Paid to the card: linked to the card's credit, and still carrying an old category.
    (txn(11, "20000", "debit", "SBI CARD PAYMENT"), "Shopping"),
    (txn(13, "7000", "debit", "TO MY DEPOSIT"), "Own accounts"),
    (txn(14, "2000", "credit", "FROM MY OTHER BANK"), "Own accounts"),
    (txn(15, "15000", "debit", "UNSURE SHOP"), "Shopping"),  # waits for review
    (txn(16, "999", "debit", "NEW PAYEE"), None),  # no category yet
    (txn(17, "800", "credit", "GIFT RETURNED"), "Family & gifts"),  # a refund with no spending
]
CARD = [
    (txn(28, "500", "debit", "AUGUST DINNER", month=8), "Food & dining"),
    (txn(10, "1500", "debit", "SEPTEMBER DINNER"), "Food & dining"),
    (txn(12, "20000", "credit", "PAYMENT RECEIVED"), "Shopping"),
]


@pytest.fixture
def record(migrated_db):
    return build(migrated_db)


def build(db):
    """Store the made-up record, link its transfer and categorise its rows."""
    sync_categories(db, load_categories())
    store(db, "axis-bank", "", SEP, SEP30, *(t for t, _ in BANK))
    store(db, "sbi-card", "04", date(2026, 8, 22), date(2026, 9, 21), *(t for t, _ in CARD))
    store(db, "sbi-bank", "1111", SEP, SEP30, txn(3, "9999", "debit", "FLAGGED ROW"),
          status_ok=False)  # fmt: skip
    rebuild(db, PROFILES)
    for t, category in BANK + CARD:
        if category:
            give(db, t.narration, category, review=t.narration == "UNSURE SHOP")
    give(db, "FLAGGED ROW", "Groceries")
    return db


def by_category(view):
    return {line.category: (line.gross, line.offsets, line.net) for line in view.categories}


# --- the figures -------------------------------------------------------------------------


def test_income_is_money_earned(record):
    view = month_view(record, PROFILES, SEP)

    assert view.summary.income == Decimal("151200.50")
    assert by_category(view)["Salary"] == (Decimal("150000"), 0, Decimal("150000"))
    assert by_category(view)["Interest & dividends"] == (Decimal("1200.50"), 0, Decimal("1200.50"))


def test_a_refund_reduces_its_category_and_is_not_income(record):
    view = month_view(record, PROFILES, SEP)

    assert by_category(view)["Rent"] == (Decimal("40000"), Decimal("5000"), Decimal("35000"))
    assert by_category(view)["Loan EMI"] == (Decimal("30000"), Decimal("10000"), Decimal("20000"))


def test_refunds_larger_than_the_spending_give_a_negative_net(record):
    view = month_view(record, PROFILES, SEP)

    assert by_category(view)["Family & gifts"] == (0, Decimal("800"), Decimal("-800"))


def test_expenses_count_the_full_emi_and_leave_out_transfers(record):
    view = month_view(record, PROFILES, SEP)

    # Groceries + Rent + Loan EMI + Shopping (the unsure row only) + Food & dining - gifts back
    assert view.summary.expenses == Decimal("74156.75")
    assert by_category(view)["Shopping"] == (Decimal("15000"), 0, Decimal("15000"))
    assert by_category(view)["Food & dining"] == (Decimal("1500"), 0, Decimal("1500"))
    assert "Own accounts" not in by_category(view)


def test_savings_is_income_less_expenses(record):
    summary = month_view(record, PROFILES, SEP).summary

    assert summary.savings == Decimal("77043.75")


def test_investments_are_shown_apart_from_income_and_spending(record):
    view = month_view(record, PROFILES, SEP)

    assert (view.summary.investments_in, view.summary.investments_out) == (25000, 5000)
    assert view.summary.investments == Decimal("20000")
    assert by_category(view)["Investments"] == (Decimal("25000"), Decimal("5000"), 20000)


def test_a_linked_transfer_counts_as_neither_whatever_its_old_category(record):
    summary = month_view(record, PROFILES, SEP).summary

    assert (summary.linked_rows, summary.linked_out, summary.linked_in) == (2, 20000, 20000)


def test_own_accounts_rows_are_left_out_and_shown(record):
    summary = month_view(record, PROFILES, SEP).summary

    assert (summary.own_rows, summary.own_out, summary.own_in) == (2, 7000, 2000)


def test_rows_waiting_for_review_count_and_are_shown(record):
    summary = month_view(record, PROFILES, SEP).summary

    assert (summary.review_rows, summary.review_amount) == (1, 15000)


def test_rows_without_a_category_do_not_count_and_are_shown(record):
    summary = month_view(record, PROFILES, SEP).summary

    assert summary.uncategorised_rows == 1
    assert (summary.uncategorised_out, summary.uncategorised_in) == (999, 0)


def test_a_flagged_statement_counts_nowhere_and_is_reported(record):
    view = month_view(record, PROFILES, SEP)

    assert by_category(view)["Groceries"] == (Decimal("3456.75"), 0, Decimal("3456.75"))
    assert view.flagged == 1


def test_a_row_counts_in_the_month_of_its_date(record):
    view = month_view(record, PROFILES, AUG)

    assert view.summary.expenses == Decimal("500")
    assert view.summary.savings == Decimal("-500")
    assert by_category(view) == {"Food & dining": (Decimal("500"), 0, Decimal("500"))}
    assert view.flagged == 0


def test_categories_come_in_list_order(record):
    view = month_view(record, PROFILES, SEP)

    assert [line.category for line in view.categories] == [
        "Groceries", "Food & dining", "Rent", "Shopping", "Loan EMI", "Family & gifts",
        "Salary", "Interest & dividends", "Investments",
    ]  # fmt: skip


def test_the_transactions_view_holds_no_narration(record):
    columns = record.execute(
        "select column_name from information_schema.columns where table_name like 'v\\_%%'"
    )

    assert columns
    assert "narration" not in {c["column_name"] for c in columns}


def test_the_transactions_view_gives_each_row_its_kind_and_value(record):
    rows = record.execute(
        "select category, kind, refund, value, linked from v_transactions "
        "where txn_date = '2026-09-11' or txn_date = '2026-09-05' order by txn_date"
    )

    assert rows == [
        {"category": "Rent", "kind": "expense", "refund": True, "value": -5000, "linked": False},
        {"category": None, "kind": "transfer", "refund": False, "value": None, "linked": True},
    ]


# --- coverage ----------------------------------------------------------------------------


def coverage(view):
    return {(c.source, c.account_last4): (c.days_covered, c.days_in_month) for c in view.coverage}


def test_coverage_counts_the_days_each_account_covers(record):
    assert coverage(month_view(record, PROFILES, AUG)) == {
        ("axis-bank", ""): (0, 31),
        ("sbi-bank", "1111"): (0, 31),
        ("sbi-card", "04"): (10, 31),
    }
    assert coverage(month_view(record, PROFILES, SEP)) == {
        ("axis-bank", ""): (30, 30),
        ("sbi-bank", "1111"): (0, 30),  # flagged: covers nothing
        ("sbi-card", "04"): (21, 30),
    }


def test_overlapping_statements_count_each_day_once(migrated_db):
    store(migrated_db, "axis-bank", "", SEP, date(2026, 9, 20))
    store(migrated_db, "axis-bank", "", date(2026, 9, 10), SEP30)

    view = month_view(migrated_db, PROFILES, SEP)

    assert coverage(view) == {("axis-bank", ""): (30, 30)}
    assert view.summary.complete


def test_overlapping_statements_count_a_shared_day_once(migrated_db):
    db = migrated_db
    sync_categories(db, load_categories())
    salary = txn(15, "50000", "credit", "SALARY")
    store(db, "axis-bank", "", SEP, date(2026, 9, 20), txn(2, "100", "debit", "EARLY"), salary)
    store(db, "axis-bank", "", date(2026, 9, 10), SEP30, salary, txn(25, "300", "debit", "LATE"))
    for narration, category in (
        ("SALARY", "Salary"),
        ("EARLY", "Groceries"),
        ("LATE", "Groceries"),
    ):
        give(db, narration, category)

    summary = month_view(db, PROFILES, SEP).summary

    assert (summary.income, summary.expenses) == (50000, 400)
    # Linking and categorising see the same rows as the figures.
    assert sorted(row.amount for row in load(db)) == [100, 300, 50000]


def test_a_card_row_dated_before_its_period_gives_a_month_no_statement_covers(migrated_db):
    sync_categories(migrated_db, load_categories())
    store(migrated_db, "sbi-card", "04", SEP, SEP30, txn(29, "700", "debit", "LATE POST", month=8))
    give(migrated_db, "LATE POST", "Food & dining")

    view = month_view(migrated_db, PROFILES, AUG)

    assert coverage(view) == {("sbi-card", "04"): (0, 31)}
    assert view.summary.expenses == 700
    assert not view.summary.complete


def test_a_month_between_statements_is_listed_with_no_days_covered(migrated_db):
    store(migrated_db, "axis-bank", "", JUL, date(2026, 7, 31))
    store(migrated_db, "axis-bank", "", SEP, SEP30)

    listed = [(m.month, m.complete) for m in months(migrated_db)]

    assert listed == [(JUL, True), (AUG, False), (SEP, True)]
    assert coverage(month_view(migrated_db, PROFILES, AUG)) == {("axis-bank", ""): (0, 31)}


def test_a_row_in_two_links_appears_once(record):
    record.execute(
        "insert into transfer_links (debit_txn_id, credit_txn_id, evidence) "
        "select credit_txn_id, debit_txn_id, 'test' from transfer_links"
    )

    assert record.execute("select count(*)::int as n from v_transactions") == [{"n": 18}]


def test_a_month_is_complete_only_when_every_account_covers_every_day(record):
    assert [(m.month, m.complete) for m in months(record)] == [(AUG, False), (SEP, False)]


def test_the_month_list_has_each_months_figures(record):
    listed = {m.month: m for m in months(record)}

    assert listed[SEP] == month_view(record, PROFILES, SEP).summary
    assert (listed[AUG].income, listed[AUG].expenses) == (0, 500)


def test_a_month_with_no_statement_has_no_view(record):
    assert month_view(record, PROFILES, OCT) is None


def test_an_empty_record_has_no_months(migrated_db):
    assert months(migrated_db) == []


# --- transfer links ----------------------------------------------------------------------


def test_current_links_give_no_warning(record):
    assert not month_view(record, PROFILES, SEP).links_stale


def test_links_that_differ_from_a_live_match_give_a_warning(record):
    record.execute("delete from transfer_links")

    view = month_view(record, PROFILES, SEP)

    assert view.links_stale
    # The stored links decide the figures until finos transfers runs.
    assert view.summary.linked_rows == 0


def test_a_stored_link_a_fresh_match_does_not_give_is_stale(record):
    record.execute(
        "insert into transfer_links (debit_txn_id, credit_txn_id, evidence) "
        "select d.txn_id, c.txn_id, 'test' from transactions d, transactions c "
        "where d.narration = 'TO MY DEPOSIT' and c.narration = 'FROM MY OTHER BANK'"
    )

    assert month_view(record, PROFILES, SEP).links_stale


# --- the month argument ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [("2026-09", SEP), ("2026-12", date(2026, 12, 1)), ("2026-13", None), ("Sept", None),
     ("2026-9", None), ("2026-09-01", None), (" 2026-09", None), ("0000-01", None),
     ("\u0662\u0660\u0662\u0666-\u0660\u0669", None)],
)  # fmt: skip
def test_a_month_is_written_yyyy_mm(text, expected):
    assert parse_month(text) == expected
