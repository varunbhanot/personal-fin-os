from datetime import date
from decimal import Decimal

from finos.migrate import migrate
from finos.models import Extraction, PrintedTotals, SourceFile, Statement, Transaction
from finos.store import is_known_file, store_statement

FILE_A = SourceFile(
    drive_file_id="drive-1", drive_md5="md5-a", name="hdfc-mar.pdf", sha256="a" * 64
)
FILE_B = SourceFile(
    drive_file_id="drive-2", drive_md5="md5-b", name="hdfc-mar-v2.pdf", sha256="b" * 64
)
EXTRACTION = Extraction(model="claude-opus-5-5", prompt_version="v1", attempts=1, raw={"k": 1})


def statement(*transactions: Transaction) -> Statement:
    return Statement(
        source="hdfc-tataneu",
        account_last4="4321",
        period_start=date(2026, 2, 13),
        period_end=date(2026, 3, 12),
        totals=PrintedTotals(opening=Decimal("0"), closing=Decimal("1500.00")),
        transactions=transactions,
    )


SWIGGY = Transaction(date(2026, 2, 20), Decimal("500.00"), "debit", "SWIGGY BANGALORE")
ZEPTO = Transaction(date(2026, 3, 1), Decimal("1000.00"), "debit", "ZEPTO MARKETPLACE")


def count(db, table):
    return db.execute(f"select count(*) as n from {table}")[0]["n"]  # noqa: S608


def test_migrate_is_idempotent(db):
    migrate(db)
    migrate(db)

    versions = db.execute("select version from schema_migrations order by version")
    assert [v["version"] for v in versions] == [
        "0001_init",
        "0002_transfers",
        "0003_categories",
        "0004_memory_by_direction",
        "0005_views",
        "0006_views_one_statement_per_day",
        "0007_spreads_goals",
        "0008_ui_access",
    ]


def test_first_import_stores_everything(migrated_db):
    outcome = store_statement(migrated_db, FILE_A, statement(SWIGGY, ZEPTO), EXTRACTION, [])

    assert outcome == "imported"
    assert count(migrated_db, "statements") == 1
    assert count(migrated_db, "transactions") == 2
    row = migrated_db.execute("select status, problems, printed_totals from statements")[0]
    assert row["status"] == "ok"
    assert row["problems"] == []
    assert row["printed_totals"]["closing"] == "1500.00"
    assert is_known_file(migrated_db, "drive-1", "md5-a")
    assert not is_known_file(migrated_db, "drive-1", "md5-changed")


def test_importing_the_same_file_again_changes_nothing(migrated_db):
    store_statement(migrated_db, FILE_A, statement(SWIGGY, ZEPTO), EXTRACTION, [])
    ids = migrated_db.execute("select txn_id from transactions order by txn_id")

    outcome = store_statement(migrated_db, FILE_A, statement(SWIGGY, ZEPTO), EXTRACTION, [])

    assert outcome == "unchanged"
    assert migrated_db.execute("select txn_id from transactions order by txn_id") == ids


def test_a_new_file_for_the_same_period_replaces_the_old_rows(migrated_db):
    store_statement(migrated_db, FILE_A, statement(SWIGGY), EXTRACTION, [])

    outcome = store_statement(migrated_db, FILE_B, statement(SWIGGY, ZEPTO), EXTRACTION, [])

    assert outcome == "replaced"
    assert count(migrated_db, "statements") == 1
    assert count(migrated_db, "transactions") == 2
    assert count(migrated_db, "extractions") == 1
    assert is_known_file(migrated_db, "drive-1", "md5-a")


def test_identical_rows_get_distinct_stable_ids(migrated_db):
    store_statement(migrated_db, FILE_A, statement(SWIGGY, SWIGGY), EXTRACTION, [])
    first = migrated_db.execute("select txn_id from transactions order by seq")

    migrate(migrated_db)
    migrated_db.execute("delete from statements")
    store_statement(migrated_db, FILE_A, statement(SWIGGY, SWIGGY), EXTRACTION, [])
    second = migrated_db.execute("select txn_id from transactions order by seq")

    assert len({r["txn_id"] for r in first}) == 2
    assert first == second


def test_a_flagged_statement_records_its_problems(migrated_db):
    problems = ["totals: rows add up to 1500.00 but the statement prints 1600.00 (gap 100.00)"]

    store_statement(migrated_db, FILE_A, statement(SWIGGY, ZEPTO), EXTRACTION, problems)

    row = migrated_db.execute("select status, problems from statements")[0]
    assert row == {"status": "flagged", "problems": problems}


def test_a_flagged_file_never_replaces_a_verified_statement(migrated_db):
    store_statement(migrated_db, FILE_A, statement(SWIGGY, ZEPTO), EXTRACTION, [])

    outcome = store_statement(
        migrated_db, FILE_B, statement(SWIGGY), EXTRACTION, ["totals: gap 1000.00"]
    )

    assert outcome == "kept"
    assert migrated_db.execute("select statement_id, status from statements") == [
        {"statement_id": FILE_A.sha256, "status": "ok"}
    ]
    assert count(migrated_db, "transactions") == 2
    # Recorded as seen, so the next sync does not extract it again.
    assert is_known_file(migrated_db, "drive-2", "md5-b")


def test_a_flagged_file_may_replace_a_flagged_statement(migrated_db):
    store_statement(migrated_db, FILE_A, statement(SWIGGY), EXTRACTION, ["totals: gap 1.00"])

    outcome = store_statement(
        migrated_db, FILE_B, statement(SWIGGY, ZEPTO), EXTRACTION, ["totals: gap 2.00"]
    )

    assert outcome == "replaced"


def test_migrations_ignore_comments_at_the_end_of_a_line():
    from finos.migrate import _statements

    sql = "create table a (x int); -- first\ncreate table b (y text default '--'); -- second\n"

    assert _statements(sql) == ["create table a (x int)", "create table b (y text default '--')"]


def test_an_account_with_no_printed_digits_and_split_debits_is_stored(migrated_db):
    from dataclasses import replace

    from finos.report import status

    original = statement(SWIGGY, ZEPTO)
    totals = replace(original.totals, debit_parts=(Decimal("1000.00"), Decimal("500.00")))
    masked = replace(original, account_last4="", totals=totals)

    assert store_statement(migrated_db, FILE_A, masked, EXTRACTION, []) == "imported"

    row = migrated_db.execute("select account_last4, printed_totals from statements")[0]
    assert row["account_last4"] == ""
    assert row["printed_totals"]["debit_parts"] == ["1000.00", "500.00"]
    assert status(migrated_db, []).statements[0].account_last4 == ""
