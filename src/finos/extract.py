"""Claude transcribes a statement; verify.py decides whether the transcription is trusted.

Claude sees the unlocked PDF and the source profile's layout notes, and returns JSON matching
SCHEMA. If the checks fail, it gets one more attempt, told exactly which checks failed and
told never to change a figure to make a check pass. Whatever still fails is returned as
problems, and the statement is stored as flagged.
"""

import base64
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from finos.ai import StructuredReply
from finos.errors import AiError, BudgetExceeded
from finos.identify import SourceProfile
from finos.models import Extraction, PrintedTotals, Statement, Transaction
from finos.verify import verify

PROMPT_VERSION = "extract-v1"
MAX_NARRATION = 200
_LARGEST_AMOUNT = Decimal("1000000000000")  # the database stores numeric(14, 2)

_MONEY = {"type": "string", "description": "Plain decimal with two places, e.g. 12345.60"}
_OPTIONAL_MONEY = {"anyOf": [_MONEY, {"type": "null"}]}
_DATE = {"type": "string", "format": "date"}

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "account_last4": {"type": "string"},
        "period_start": _DATE,
        "period_end": _DATE,
        "opening": _MONEY,
        "closing": _MONEY,
        "total_debits": _OPTIONAL_MONEY,
        "total_credits": _OPTIONAL_MONEY,
        "transactions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "date": _DATE,
                    "narration": {"type": "string"},
                    "amount": _MONEY,
                    "direction": {"type": "string", "enum": ["debit", "credit"]},
                    "balance": _OPTIONAL_MONEY,
                },
                "required": ["date", "narration", "amount", "direction", "balance"],
                "additionalProperties": False,
            },
        },
    },
    "required": [
        "account_last4",
        "period_start",
        "period_end",
        "opening",
        "closing",
        "total_debits",
        "total_credits",
        "transactions",
    ],
    "additionalProperties": False,
}

SYSTEM = (
    "You transcribe Indian bank, credit card and loan statements into JSON, exactly as printed. "
    "You are a careful copyist, not an analyst: every figure you return must be one printed on "
    "the statement. Never compute, round, adjust or invent a figure."
)

_INSTRUCTIONS = """\
Source: {source} ({kind} statement).
Layout notes: {hints}

Transcribe the attached statement:
- period_start, period_end: the statement period, as YYYY-MM-DD.
- account_last4: the last four digits of the account, card or loan number.
- opening, closing: {balances}
- total_debits, total_credits: the totals printed in the summary, or null if none are printed.
- transactions: every transaction row on every page, in the order printed, including fees,
  taxes, interest, reversals and refunds. Skip only rows that are not transactions, such as
  carried-forward lines or reward summaries.
  - amount: always positive.
  - direction: {directions}
  - balance: the running balance printed on that row, or null if the statement has none.
  - narration: the description as printed, on one line.
- Write amounts as plain decimals with two places, without commas or currency symbols:
  12345.60, not 12,345.60 or Rs. 12,345.60.
"""

_BALANCES = {
    "card": (
        "the previous balance and the total amount due, as amounts owed. A credit balance "
        "(marked Cr, money the bank owes the cardholder) is negative."
    ),
    "loan": "the loan amount outstanding at the start and the end of the period.",
    "bank": (
        "the opening and closing balances of the account. An overdrawn balance (marked Dr or "
        "with a minus sign) is negative; so is any running balance printed that way."
    ),
}
_DIRECTIONS = {
    "card": "debit for spending, fees and charges; credit for payments, refunds and reversals.",
    "loan": "debit for interest and charges added; credit for repayments and EMIs received.",
    "bank": "debit for money out (withdrawals); credit for money in (deposits).",
}

_FEEDBACK = """\
Your previous transcription of this statement {failure}:
{details}
Re-read the statement and correct any transcription mistakes: a missed or repeated row, a
misread digit, a credit recorded as a debit, or a wrong period. Never change a figure to make
a check pass; copy only what is printed. If the statement itself does not add up, transcribe
it as printed anyway.
"""


class StructuredClaude(Protocol):
    def structured(self, **kwargs: Any) -> StructuredReply: ...


@dataclass(frozen=True)
class ExtractionResult:
    statement: Statement
    extraction: Extraction
    problems: list[str]


class _Malformed(Exception):
    """Claude's reply did not describe a statement in the expected shape."""


def extract(
    claude: StructuredClaude,
    *,
    model: str,
    pdf: bytes,
    profile: SourceProfile,
    page_texts: list[str],
    effort: str = "medium",
) -> ExtractionResult:
    content: list[dict[str, Any]] = [
        {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": base64.b64encode(pdf).decode(),
            },
            # The retry re-sends the same document, so cache it.
            "cache_control": {"type": "ephemeral"},
        },
        {"type": "text", "text": _instructions(profile)},
    ]

    best: ExtractionResult | None = None
    feedback: str | None = None
    malformed: str | None = None
    for attempt in (1, 2):
        request = content if feedback is None else [*content, {"type": "text", "text": feedback}]
        try:
            reply = claude.structured(
                purpose="extract",
                model=model,
                system=SYSTEM,
                content=request,
                schema=SCHEMA,
                effort=effort,
            )
        except (AiError, BudgetExceeded) as error:
            if best is None:
                raise
            # Keep the paid first attempt rather than losing it; it is stored as flagged.
            return _finished(best, [*best.problems, f"retry: {error}"])
        try:
            statement = _parse(reply.data, profile)
        except _Malformed as error:
            malformed = str(error)
            feedback = _FEEDBACK.format(failure="could not be read", details=f"- {error}")
            continue

        problems = verify(statement, profile, page_texts)
        extraction = Extraction(
            model=reply.model, prompt_version=PROMPT_VERSION, attempts=attempt, raw=reply.data
        )
        if not problems:
            return ExtractionResult(statement, extraction, problems)
        if best is None or len(problems) < len(best.problems):
            best = ExtractionResult(statement, extraction, problems)
        details = "\n".join(f"- {p}" for p in problems)
        feedback = _FEEDBACK.format(failure="failed these checks", details=details)

    if best is not None:
        return _finished(best, best.problems)
    raise AiError(f"The statement transcription could not be read: {malformed}")


def _finished(best: ExtractionResult, problems: list[str]) -> ExtractionResult:
    """The attempt with the fewest problems, recorded as having taken both attempts."""
    extraction = Extraction(
        model=best.extraction.model,
        prompt_version=PROMPT_VERSION,
        attempts=2,
        raw=best.extraction.raw,
    )
    return ExtractionResult(best.statement, extraction, problems)


def _instructions(profile: SourceProfile) -> str:
    return _INSTRUCTIONS.format(
        source=profile.id,
        kind=profile.kind,
        hints=profile.hints or "none",
        balances=_BALANCES[profile.kind],
        directions=_DIRECTIONS[profile.kind],
    )


def _parse(data: dict[str, Any], profile: SourceProfile) -> Statement:
    try:
        transactions = tuple(
            Transaction(
                date=_date(row["date"]),
                amount=_money(row["amount"], positive=True),
                direction=_direction(row["direction"]),
                narration=_clean_text(row["narration"]),
                balance=None if row["balance"] is None else _money(row["balance"]),
            )
            for row in data["transactions"]
        )
        statement = Statement(
            source=profile.id,
            account_last4=_last4(data["account_last4"]),
            period_start=_date(data["period_start"]),
            period_end=_date(data["period_end"]),
            totals=PrintedTotals(
                opening=_money(data["opening"]),
                closing=_money(data["closing"]),
                total_debits=_optional_money(data["total_debits"]),
                total_credits=_optional_money(data["total_credits"]),
            ),
            transactions=transactions,
        )
    except KeyError as error:
        raise _Malformed(f"the field {error} is missing") from None
    except (TypeError, ValueError, ArithmeticError) as error:
        raise _Malformed(str(error)) from None
    if statement.period_start > statement.period_end:
        raise _Malformed("period_start is after period_end")
    return statement


def _clean_text(value: Any) -> str:
    """Narrations hold third-party text (UPI remarks): keep it printable, one line, short."""
    printable = "".join(ch if ch.isprintable() else " " for ch in str(value))
    return " ".join(printable.split())[:MAX_NARRATION]


def _date(value: Any) -> date:
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ValueError(f"{value!r} is not a date written as YYYY-MM-DD") from None


def _last4(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value))
    if len(digits) < 4:
        raise ValueError(f"account_last4 {value!r} must hold the last four digits")
    return digits[-4:]


def _money(value: Any, *, positive: bool = False) -> Decimal:
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        raise ValueError(f"{value!r} is not a plain decimal amount") from None
    if not amount.is_finite() or amount.as_tuple().exponent < -2:  # type: ignore[operator]
        raise ValueError(f"{value!r} is not an amount with at most two decimal places")
    if abs(amount) >= _LARGEST_AMOUNT:
        raise ValueError(f"{value!r} is larger than any statement amount can be")
    if positive and amount <= 0:
        raise ValueError(f"transaction amount {value!r} must be positive")
    return amount.quantize(Decimal("0.01"))


def _optional_money(value: Any) -> Decimal | None:
    return None if value is None else _money(value)


def _direction(value: Any) -> Any:
    if value not in ("debit", "credit"):
        raise ValueError(f"direction {value!r} must be debit or credit")
    return value
