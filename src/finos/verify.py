"""The checks that decide whether a transcribed statement can be trusted.

Each check compares Claude's transcription with something it cannot fake: the statement's own
printed totals and running balances, and the PDF's text layer as read by pdfplumber. A
statement with no problems is stored as ok; otherwise it is stored as flagged, with the
problems, and never silently accepted.
"""

import re
from collections import Counter
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from finos.identify import DEFAULT_DATE_FORMATS, SourceProfile
from finos.models import Statement, Transaction

# 1,00,000.00 / 1,499.50 / 12.00, also after "Rs." or "₹"; signs and Dr/Cr are ignored.
_DECIMAL = re.compile(r"(?<![\d,])(\d[\d,]*)\.(\d{2})(?!\d)")
# Comma-grouped whole numbers (1,500), for statements that drop the paise.
_GROUPED_INTEGER = re.compile(r"(?<![\d,.])(\d{1,3}(?:,\d{2,3})+)(?![\d,]|\.\d)")
_LEADING_ZERO = re.compile(r"(?<!\d)0(\d)")
# Formats tried only to explain a date that a profile's formats miss, so the message can name
# the one to add. They never make a date count as grounded.
_OTHER_DATE_FORMATS = (
    *DEFAULT_DATE_FORMATS,
    "%d %b, %Y",
    "%d %B, %Y",
    "%b %d, %Y",
    "%B %d, %Y",
    "%d/%b/%Y",
    "%d-%B-%Y",
    "%d %B %y",
    "%d.%m.%y",
    "%Y/%m/%d",
)


def verify(statement: Statement, profile: SourceProfile, page_texts: Sequence[str]) -> list[str]:
    text = "\n".join(page_texts)
    return [
        *_check_totals(statement, profile),
        *_check_running_balance(statement, profile),
        *_check_grounding(statement, profile, text),
        *_check_period(statement, profile),
    ]


def _owed(profile: SourceProfile) -> bool:
    """Cards and loans track an amount owed: debits raise it and credits lower it."""
    return profile.kind in ("card", "loan")


def _apply(balance: Decimal, txn: Transaction, owed: bool) -> Decimal:
    increases = (txn.direction == "debit") == owed
    return balance + txn.amount if increases else balance - txn.amount


def _check_totals(statement: Statement, profile: SourceProfile) -> list[str]:
    problems = []
    debits = sum((t.amount for t in statement.transactions if t.direction == "debit"), Decimal(0))
    credits = sum((t.amount for t in statement.transactions if t.direction == "credit"), Decimal(0))
    totals = statement.totals

    for label, actual, printed in (
        ("debits", debits, totals.total_debits),
        ("credits", credits, totals.total_credits),
    ):
        if printed is not None and actual != printed:
            problems.append(
                f"totals: {label} add up to {_money(actual)} but the statement prints "
                f"{_money(printed)} (gap {_money(abs(printed - actual))})"
            )

    if _owed(profile):
        expected = totals.opening + debits - credits
        working = f"debits {_money(debits)} - credits {_money(credits)}"
    else:
        expected = totals.opening + credits - debits
        working = f"credits {_money(credits)} - debits {_money(debits)}"
    if not _closing_matches(statement, expected, profile):
        problems.append(
            f"totals: opening {_money(totals.opening)} + {working} = {_money(expected)}, but the "
            f"statement prints closing {_money(totals.closing)} "
            f"(gap {_money(abs(totals.closing - expected))})"
        )
    return problems


def _closing_matches(statement: Statement, expected: Decimal, profile: SourceProfile) -> bool:
    totals = statement.totals
    if totals.closing == expected:
        return True
    # Some issuers print the amount due rounded to the nearest rupee. That is trusted only when
    # the printed debit and credit totals were transcribed, because they still check every row
    # exactly: without them a dropped row worth under 50 paise would go unnoticed.
    return (
        profile.closing_rounded_to_rupee
        and totals.total_debits is not None
        and totals.total_credits is not None
        and totals.closing == expected.quantize(Decimal(1), ROUND_HALF_UP)
    )


def _check_running_balance(statement: Statement, profile: SourceProfile) -> list[str]:
    if not any(t.balance is not None for t in statement.transactions):
        return []
    forward = _walk_balances(statement.transactions, statement.totals.opening, profile)
    if not forward:
        return []
    # Some banks print the newest transaction first.
    backward = _walk_balances(statement.transactions[::-1], statement.totals.opening, profile)
    return [] if not backward else forward


def _walk_balances(
    rows: Sequence[Transaction], opening: Decimal, profile: SourceProfile
) -> list[str]:
    problems = []
    balance = opening
    for number, txn in enumerate(rows, start=1):
        expected = _apply(balance, txn, _owed(profile))
        if txn.balance is not None and txn.balance != expected:
            problems.append(
                f"running balance: {_row(number, txn)} should leave {_money(expected)} but the "
                f"statement prints {_money(txn.balance)}"
            )
        # Carry on from the printed balance so one error is reported once.
        balance = txn.balance if txn.balance is not None else expected
    return problems


def _check_grounding(statement: Statement, profile: SourceProfile, text: str) -> list[str]:
    problems = []
    available = _amounts_in(text)

    needed: Counter[Decimal] = Counter()
    for txn in statement.transactions:
        needed[txn.amount] += 1
    for amount, count in sorted(needed.items()):
        if amount and available[amount] < count:
            problems.append(
                f"grounding: amount {_money(amount)} appears {count} time(s) in the "
                f"transcription but {available[amount]} time(s) in the statement text"
            )

    totals = statement.totals
    printed = [
        ("opening", totals.opening),
        ("closing", totals.closing),
        ("total debits", totals.total_debits),
        ("total credits", totals.total_credits),
    ]
    printed += [
        (f"balance on {t.date.isoformat()}", t.balance)
        for t in statement.transactions
        if t.balance is not None
    ]
    for label, value in printed:
        # The text layer carries no sign: a Cr or overdrawn balance prints as its size.
        if value and abs(value) not in available:
            problems.append(
                f"grounding: {label} {_money(value)} does not appear in the statement text"
            )

    folded = text.casefold()
    for number, txn in enumerate(statement.transactions, start=1):
        if not _date_appears(txn.date, profile.date_formats, folded):
            problems.append(
                f"grounding: the date of {_row(number, txn)} does not appear in the statement text"
                + _other_format(txn.date, profile, folded)
            )

    # The account and period decide which earlier statement a new file replaces.
    last4 = statement.account_last4
    if not (last4.isdigit() and len(last4) == 4 and re.search(rf"{last4}(?!\d)", text)):
        problems.append(
            f"grounding: account ending {statement.account_last4} does not appear in the "
            "statement text"
        )
    for label, day in (("start", statement.period_start), ("end", statement.period_end)):
        if not _date_appears(day, profile.date_formats, folded):
            problems.append(
                f"grounding: period {label} {day.isoformat()} does not appear in the statement text"
                + _other_format(day, profile, folded)
            )
    return problems


def _other_format(day: date, profile: SourceProfile, folded_text: str) -> str:
    """Name the other formats in which a date the profile's formats miss does appear.

    Every match is named, because the first may come from another line of the statement. Only
    format patterns are named, never statement text.
    """
    found = [fmt for fmt in _OTHER_DATE_FORMATS if _date_appears(day, (fmt,), folded_text)]
    if not found:
        return ""
    return (
        " in the profile's date formats; it appears as "
        + " or ".join(f'"{fmt}"' for fmt in found)
        + ", which extra_date_formats could add"
    )


def _check_period(statement: Statement, profile: SourceProfile) -> list[str]:
    slack = timedelta(days=profile.period_slack_days)
    start, end = statement.period_start, statement.period_end
    return [
        f"period: {_row(number, t)} is outside {start.isoformat()} to {end.isoformat()}"
        for number, t in enumerate(statement.transactions, start=1)
        if not start - slack <= t.date <= end + slack
    ]


def _amounts_in(text: str) -> Counter[Decimal]:
    found: Counter[Decimal] = Counter()
    for whole, paise in _DECIMAL.findall(text):
        found[Decimal(f"{whole.replace(',', '')}.{paise}")] += 1
    for whole in _GROUPED_INTEGER.findall(text):
        found[Decimal(f"{whole.replace(',', '')}.00")] += 1
    return found


def _date_appears(day: date, formats: Sequence[str], folded_text: str) -> bool:
    renderings = {day.strftime(fmt).casefold() for fmt in formats}
    renderings |= {_LEADING_ZERO.sub(r"\1", r) for r in renderings}
    return any(
        re.search(rf"(?<!\d){re.escape(rendering)}(?!\d)", folded_text) for rendering in renderings
    )


def _row(number: int, txn: Transaction) -> str:
    # Rows are named by position, date and amount, never by narration: narrations hold
    # third-party text (UPI remarks) that must not reach the session's transcript.
    return f"row {number} ({txn.date.isoformat()}, {_money(txn.amount)} {txn.direction})"


def _money(value: Decimal) -> str:
    return f"{value:.2f}"
