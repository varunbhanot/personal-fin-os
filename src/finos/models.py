"""The shapes a statement takes on its way from PDF to database."""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Literal

Direction = Literal["debit", "credit"]
StatementKind = Literal["card", "bank", "loan"]


@dataclass(frozen=True)
class Transaction:
    date: date
    amount: Decimal  # always positive; direction says which way the money went
    direction: Direction
    narration: str
    balance: Decimal | None = None  # running balance, where the statement prints one


@dataclass(frozen=True)
class PrintedTotals:
    """The summary the statement prints, which the transactions must agree with.

    For a card or loan, opening and closing are amounts owed. For a bank account they are
    balances held.
    """

    opening: Decimal
    closing: Decimal
    total_debits: Decimal | None = None
    total_credits: Decimal | None = None
    # When the summary prints debits on several lines (purchases, then fees and taxes) instead
    # of one total, the printed subtotals; total_debits is then their sum.
    debit_parts: tuple[Decimal, ...] = ()


@dataclass(frozen=True)
class Statement:
    source: str
    account_last4: str
    period_start: date
    period_end: date
    totals: PrintedTotals
    transactions: tuple[Transaction, ...]


@dataclass(frozen=True)
class SourceFile:
    drive_file_id: str
    drive_md5: str
    name: str
    sha256: str  # of the file as downloaded, still password-protected


@dataclass(frozen=True)
class Extraction:
    """Where a statement's figures came from, kept so every run can be explained."""

    model: str
    prompt_version: str
    attempts: int
    raw: dict[str, Any] = field(default_factory=dict)
