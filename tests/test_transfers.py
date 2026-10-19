from datetime import date
from decimal import Decimal

import pytest

from finos.errors import ConfigError
from finos.identify import SourceProfile
from finos.models import Extraction, PrintedTotals, SourceFile, Statement, Transaction
from finos.report import status
from finos.store import store_statement
from finos.transfers import (
    Row,
    add_handle,
    find,
    handles,
    load,
    rebuild,
    remove_handle,
)


def profile(id: str, kind: str, *markers: str) -> SourceProfile:
    return SourceProfile(
        id=id,
        kind=kind,  # type: ignore[arg-type]
        markers=(id,),
        password_secret=None,
        hints="-",
        transfer_markers=markers,
    )


PROFILES = [
    profile("axis-bank", "bank", "UTIB", "Axis"),
    profile("sbi-bank", "bank", "SBIN"),
    profile("sbi-card", "card", "SBI Card"),
    profile("canara-bank", "bank", "CNRB", "Canara"),
]

_ids = iter(range(10_000))


def row(source, day, amount, direction, narration, last4="", txn_id=None):
    return Row(
        txn_id=txn_id or f"t{next(_ids)}",
        source=source,
        account_last4=last4,
        date=date(2026, 9, day) if isinstance(day, int) else day,
        amount=Decimal(amount),
        direction=direction,
        narration=narration,
    )


def summary(report):
    return sorted(
        (p.debit.source, p.debit.date, p.credit.source, p.credit.date, p.debit.amount)
        for p in report.pairs
    )


# --- matching rule -----------------------------------------------------------------------


def test_a_card_bill_paid_from_the_bank_pairs():
    debit = row("axis-bank", 10, "12345.67", "debit", "BILLDESK SBI CARD PAYMENT")
    credit = row("sbi-card", 12, "12345.67", "credit", "PAYMENT RECEIVED THANK YOU", "04")

    report = find([debit, credit], PROFILES)

    assert [(p.debit, p.credit) for p in report.pairs] == [(debit, credit)]
    assert report.pairs[0].evidence == 'marker "SBI Card"'
    assert report.ambiguous == [] and report.unpaired == []


def test_a_neft_between_two_banks_pairs_on_the_ifs_prefix():
    debit = row("sbi-bank", 3, "50000", "debit", "NEFT UTIB0000123 SELF", "1111")
    credit = row("axis-bank", 3, "50000", "credit", "NEFT/N123/SELF")

    assert summary(find([debit, credit], PROFILES)) == [
        ("sbi-bank", date(2026, 9, 3), "axis-bank", date(2026, 9, 3), Decimal("50000"))
    ]


def test_evidence_on_the_credit_side_is_enough():
    debit = row("sbi-bank", 3, "700", "debit", "UPI/DR/12345/PAYEE", "1111")
    credit = row("canara-bank", 4, "700", "credit", "BY TRANSFER SBIN0001 FROM SBI", "2222")

    assert len(find([debit, credit], PROFILES).pairs) == 1


def test_a_lookalike_without_evidence_does_not_pair():
    debit = row("axis-bank", 5, "2000", "debit", "UPI/P2A/FRIEND")
    credit = row("sbi-bank", 6, "2000", "credit", "UPI/CR/SALARY ADVANCE", "1111")

    report = find([debit, credit], PROFILES)

    assert report.pairs == [] and report.ambiguous == [] and report.unpaired == []


def test_amount_direction_window_and_account_must_all_fit():
    debit = row("axis-bank", 10, "999", "debit", "SBI CARD PAYMENT")
    rows = [
        debit,
        row("sbi-card", 12, "999.01", "credit", "PAYMENT", "04"),  # amount differs
        row("sbi-card", 9, "999", "credit", "PAYMENT", "04"),  # credit before debit
        row("sbi-card", 16, "999", "credit", "PAYMENT", "04"),  # 6 days later
        row("sbi-card", 12, "999", "debit", "SBI CARD FEE", "04"),  # not a credit
        row("axis-bank", 11, "999", "credit", "SBI CARD REVERSAL"),  # same account
    ]

    report = find(rows, PROFILES)

    assert report.pairs == []
    # Rows that name another account but find no partner are reported, credits too.
    assert [u.row for u in report.unpaired] == [debit, rows[-1]]


def test_a_pair_split_across_statement_periods_pairs():
    debit = row("axis-bank", 30, "4000", "debit", "SBI CARD PAYMENT")
    credit = row("sbi-card", date(2026, 10, 2), "4000", "credit", "PAYMENT", "04")

    assert len(find([debit, credit], PROFILES).pairs) == 1


def test_two_equal_candidates_pair_nothing_and_are_reported():
    debit = row("axis-bank", 10, "1500", "debit", "SBI CARD PAYMENT")
    first = row("sbi-card", 11, "1500", "credit", "PAYMENT", "04")
    second = row("sbi-card", 12, "1500", "credit", "PAYMENT", "04")

    report = find([debit, first, second], PROFILES)

    assert report.pairs == []
    assert {(a.row.txn_id, a.candidates) for a in report.ambiguous} == {
        (debit.txn_id, 2),
        (first.txn_id, 1),
        (second.txn_id, 1),
    }


def test_a_debit_naming_an_account_not_yet_imported_is_unpaired():
    debit = row("axis-bank", 10, "321", "debit", "TO CANARA BANK A/C")

    report = find([debit], PROFILES)

    assert [(u.row, u.names) for u in report.unpaired] == [(debit, "canara-bank")]


def test_a_bank_naming_itself_is_not_evidence():
    debit = row("sbi-bank", 10, "321", "debit", "TRANSFER TO SBIN0001 SOMEONE", "1111")
    credit = row("sbi-bank", 11, "321", "credit", "FROM SBIN0002", "3333")

    report = find([debit, credit], PROFILES)

    assert report.pairs == [] and report.unpaired == []


def test_the_last_four_digits_of_an_account_are_evidence():
    debit = row("sbi-bank", 10, "321", "debit", "TRF TO A/C XXXXXXX2222", "1111")
    credit = row("canara-bank", 10, "321", "credit", "BY CLG", "2222")
    elsewhere = row("canara-bank", 10, "321", "credit", "BY CLG", "9999")

    report = find([debit, credit, elsewhere], PROFILES)

    assert [(p.debit, p.credit) for p in report.pairs] == [(debit, credit)]
    assert report.pairs[0].evidence == "account *2222"


def test_digits_inside_a_longer_number_are_not_evidence():
    debit = row("sbi-bank", 10, "321", "debit", "REF 22225555", "1111")
    credit = row("canara-bank", 10, "321", "credit", "BY CLG", "2222")

    assert find([debit, credit], PROFILES).pairs == []


def test_a_handle_is_evidence_for_any_of_your_accounts():
    debit = row("axis-bank", 10, "2500", "debit", "UPI/P2A/98XXXX7319@ybl/SELF")
    credit = row("sbi-bank", 10, "2500", "credit", "UPI/CR/NO NAME", "1111")

    report = find([debit, credit], PROFILES, handles=["7319"])

    assert len(report.pairs) == 1
    # The handle itself is personal, so the evidence does not repeat it.
    assert report.pairs[0].evidence == "your handle"
    assert "7319" not in str(report)


def test_a_handle_names_no_account_without_a_matching_credit():
    debit = row("axis-bank", 10, "2500", "debit", "UPI/9876547319@ybl")

    report = find([debit], PROFILES, handles=["7319"])

    assert [(u.row, u.names) for u in report.unpaired] == [(debit, "one of your accounts")]


def test_a_credit_that_names_only_you_is_not_reported():
    # Incoming payments print you as the beneficiary, so a handle alone says nothing about
    # where a credit came from. A credit that names a specific account is still reported.
    from_someone = row("sbi-bank", 10, "481", "credit", "NEFT FROM X TO ANN EXAMPLE", "1111")
    from_canara = row("sbi-bank", 11, "64220", "credit", "NEFT CNRB0001 ANN EXAMPLE", "1111")

    report = find([from_someone, from_canara], PROFILES, handles=["Ann Example"])

    assert [(u.row, u.names) for u in report.unpaired] == [(from_canara, "canara-bank")]


def test_a_handle_inside_a_longer_number_is_not_evidence():
    debit = row("axis-bank", 10, "2500", "debit", "UPI REF 73191234")
    credit = row("sbi-bank", 10, "2500", "credit", "UPI CR", "1111")

    assert find([debit, credit], PROFILES, handles=["7319"]).pairs == []


def test_markers_ignore_case_and_spacing():
    debit = row("axis-bank", 10, "10", "debit", "sbicard   payment")
    credit = row("sbi-card", 10, "10", "credit", "PAYMENT", "04")

    assert len(find([debit, credit], PROFILES).pairs) == 1


def test_no_report_text_contains_a_narration():
    secret_words = "RAMESH COOK SALARY"
    rows = [
        row("axis-bank", 10, "100", "debit", f"SBI CARD {secret_words}"),
        row("sbi-card", 11, "100", "credit", secret_words, "04"),
        row("axis-bank", 10, "200", "debit", f"CANARA {secret_words}"),
        row("axis-bank", 10, "300", "debit", f"SBI CARD {secret_words}"),
        row("sbi-card", 11, "300", "credit", secret_words, "04"),
        row("sbi-card", 12, "300", "credit", secret_words, "04"),
    ]

    report = find(rows, PROFILES)

    assert report.pairs and report.unpaired and report.ambiguous
    for line in report.lines():
        assert "RAMESH" not in line
    assert "RAMESH" not in repr(report)


def test_report_lines_name_rows_by_source_date_and_amount():
    debit = row("axis-bank", 10, "12345.6", "debit", "SBI CARD")
    credit = row("sbi-card", 12, "12345.6", "credit", "PAYMENT", "04")

    lines = find([debit, credit], PROFILES).lines()

    assert any(
        "axis-bank" in line
        and "2026-09-10" in line
        and "12345.60" in line
        and "sbi-card *04" in line
        and "2026-09-12" in line
        for line in lines
    )


# --- the record --------------------------------------------------------------------------

EXTRACTION = Extraction(model="m", prompt_version="v1", attempts=1, raw={})


def store(db, source, last4, start, end, *transactions, sha="", status_ok=True):
    sha = sha or (source + last4 + start.isoformat()).ljust(64, "0")
    statement = Statement(
        source=source,
        account_last4=last4,
        period_start=start,
        period_end=end,
        totals=PrintedTotals(opening=Decimal(0), closing=Decimal(0)),
        transactions=transactions,
    )
    file = SourceFile(drive_file_id=sha[:8], drive_md5=sha[:8], name=f"{source}.pdf", sha256=sha)
    return store_statement(db, file, statement, EXTRACTION, [] if status_ok else ["bad"])


SEP1, SEP30 = date(2026, 9, 1), date(2026, 9, 30)
OCT1, OCT31 = date(2026, 10, 1), date(2026, 10, 31)
CARD_BILL = Transaction(date(2026, 9, 30), Decimal("4000"), "debit", "SBI CARD PAYMENT")
CARD_PAID = Transaction(date(2026, 10, 2), Decimal("4000"), "credit", "PAYMENT RECEIVED")
NEFT_OUT = Transaction(date(2026, 9, 5), Decimal("900"), "debit", "NEFT UTIB000 SELF")
NEFT_IN = Transaction(date(2026, 9, 6), Decimal("900"), "credit", "NEFT SELF")


def import_month(db):
    store(db, "axis-bank", "", SEP1, SEP30, CARD_BILL, NEFT_IN)
    store(db, "sbi-card", "04", OCT1, OCT31, CARD_PAID)
    store(db, "sbi-bank", "1111", SEP1, SEP30, NEFT_OUT)


def links(db):
    return db.execute(
        "select d.txn_date as debit_date, c.txn_date as credit_date, d.amount, l.evidence "
        "from transfer_links l join transactions d on d.txn_id = l.debit_txn_id "
        "join transactions c on c.txn_id = l.credit_txn_id order by d.txn_date"
    )


def test_rebuild_stores_the_links(migrated_db):
    import_month(migrated_db)

    report = rebuild(migrated_db, PROFILES)

    assert len(report.pairs) == 2
    assert links(migrated_db) == [
        {
            "debit_date": date(2026, 9, 5),
            "credit_date": date(2026, 9, 6),
            "amount": Decimal("900.00"),
            "evidence": 'marker "UTIB"',
        },
        {
            "debit_date": date(2026, 9, 30),
            "credit_date": date(2026, 10, 2),
            "amount": Decimal("4000.00"),
            "evidence": 'marker "SBI Card"',
        },
    ]


def test_rebuilding_twice_changes_nothing(migrated_db):
    import_month(migrated_db)
    rebuild(migrated_db, PROFILES)
    first = links(migrated_db)

    rebuild(migrated_db, PROFILES)

    assert links(migrated_db) == first


def test_replacing_a_statement_and_rebuilding_gives_the_same_pairs(migrated_db):
    import_month(migrated_db)
    rebuild(migrated_db, PROFILES)
    before = links(migrated_db)

    outcome = store(
        migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID, sha="f" * 64
    )  # a new file for the same period
    assert outcome == "replaced"
    assert len(links(migrated_db)) == 1  # the replaced statement's link went with it

    rebuild(migrated_db, PROFILES)

    assert links(migrated_db) == before


def test_flagged_statements_are_left_out(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, CARD_BILL)
    store(migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID, status_ok=False)

    report = rebuild(migrated_db, PROFILES)

    assert report.pairs == []
    assert len(load(migrated_db)) == 1


def test_a_stored_handle_is_used_by_rebuild(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        Transaction(date(2026, 9, 8), Decimal("2500"), "debit", "UPI/9876547319@ybl"),
    )
    store(
        migrated_db,
        "sbi-bank",
        "1111",
        SEP1,
        SEP30,
        Transaction(date(2026, 9, 8), Decimal("2500"), "credit", "UPI/CR/NO NAME"),
    )
    assert rebuild(migrated_db, PROFILES).pairs == []

    add_handle(migrated_db, "7319")

    assert len(rebuild(migrated_db, PROFILES).pairs) == 1


def test_handles_are_added_once_and_removed(migrated_db):
    assert add_handle(migrated_db, "7319") is True
    assert add_handle(migrated_db, " 7319 ") is False
    assert handles(migrated_db) == ["7319"]

    assert remove_handle(migrated_db, "7319") is True
    assert remove_handle(migrated_db, "7319") is False
    assert handles(migrated_db) == []


@pytest.mark.parametrize("bad", ["", "  ", "123", "a b", "73\n19", "ann\texample"])
def test_a_handle_must_be_four_or_more_printable_characters(migrated_db, bad):
    with pytest.raises(ConfigError, match="handle"):
        add_handle(migrated_db, bad)


def test_a_name_handle_is_stored_with_single_spaces(migrated_db):
    assert add_handle(migrated_db, "  Ann   Example ") is True
    assert add_handle(migrated_db, "Ann Example") is False
    assert handles(migrated_db) == ["Ann Example"]


def test_your_name_is_evidence_for_any_of_your_accounts():
    # A transfer to your own account at another bank prints your name as the beneficiary.
    debit = row("sbi-bank", 8, "300000", "debit", "WDL TFR REF 123 OF Mr. ANN  EXAMPLE AT", "1111")
    credit = row("canara-bank", 8, "300000", "credit", "BY TRANSFER", "2222")

    report = find([debit, credit], PROFILES, handles=["Ann Example"])

    assert [p.evidence for p in report.pairs] == ["your handle"]
    assert "Example" not in str(report)


def test_your_name_marks_a_debit_to_an_account_not_in_the_record():
    debit = row("sbi-bank", 8, "300000", "debit", "WDL TFR OF Mr. ANN EXAMPLE AT", "1111")

    report = find([debit], PROFILES, handles=["Ann Example"])

    assert [(u.row, u.names) for u in report.unpaired] == [(debit, "one of your accounts")]


def test_status_counts_linked_and_unpaired_transfers(migrated_db):
    import_month(migrated_db)
    store(
        migrated_db,
        "canara-bank",
        "2222",
        SEP1,
        SEP30,
        Transaction(date(2026, 9, 9), Decimal("50"), "debit", "TO SBI CARD"),
    )

    # Live counts: they agree with each other before finos transfers stores any link.
    report = status(migrated_db, PROFILES)

    assert (report.transfers_linked, report.transfers_unpaired) == (2, 1)


def test_a_handle_on_the_credit_side_alone_is_not_evidence():
    # A friend repays you into another account: the credit names you, the debit names nobody.
    debit = row("axis-bank", 10, "500", "debit", "UPI/P2A/FRIEND DINNER")
    credit = row("sbi-bank", 12, "500", "credit", "UPI/CR/FRIEND TO ANN EXAMPLE", "1111")

    assert find([debit, credit], PROFILES, handles=["Ann Example"]).pairs == []


def test_a_name_handle_matches_whole_words_only():
    debit = row("axis-bank", 10, "500", "debit", "UPI/ANN EXAMPLESON STORES")
    joined = row("axis-bank", 11, "600", "debit", "TFR OF Mr.ANNEXAMPLE AT")

    report = find([debit, joined], PROFILES, handles=["Ann Example"])

    assert [u.row for u in report.unpaired] == [joined]
