"""finos transfers: links the two halves of a move between two of your own accounts.

A card bill paid from a bank account, or money sent from one bank account to another, shows
up twice: as a debit in one account and a credit in another. Linked, the pair is neither
income nor expense.

A debit and a credit are linked only when all of these hold:
- they are in different accounts, and the amounts are equal to the paisa;
- the credit is dated 0 to MAX_DAYS days after the debit;
- one narration names the other account: a transfer marker from the other account's profile,
  the other account's last four digits, or one of your handles;
- each is the other's only candidate. When two fit equally, nothing is linked and both are
  reported, so a coincidence is never guessed into a transfer.

Only statements that passed their checks take part. Output names a row by source, date,
amount and direction; narrations hold third-party text and never appear in it.
"""

import re
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from finos.db import NeonHttpDb, Query
from finos.errors import ConfigError
from finos.identify import SourceProfile
from finos.models import Direction

MAX_DAYS = 5  # a card payment can post on the card a few days after the bank debit
MIN_HANDLE_LENGTH = 4


@dataclass(frozen=True)
class Row:
    """A transaction as the matcher sees it."""

    txn_id: str
    source: str
    account_last4: str
    date: date
    amount: Decimal
    direction: Direction
    narration: str = field(repr=False)  # third-party text: kept out of every printout

    @property
    def account(self) -> tuple[str, str]:
        return (self.source, self.account_last4)

    def label(self) -> str:
        return f"{self.date.isoformat()}  {_account_name(*self.account):<17} {self.amount:>12.2f}"


@dataclass(frozen=True)
class Pair:
    debit: Row
    credit: Row
    evidence: str  # which text named the other account; a handle is never repeated


@dataclass(frozen=True)
class Ambiguous:
    row: Row
    candidates: int


@dataclass(frozen=True)
class Unpaired:
    row: Row
    names: str  # the account the narration names


@dataclass(frozen=True)
class Report:
    pairs: list[Pair]
    ambiguous: list[Ambiguous]
    unpaired: list[Unpaired]

    def lines(self) -> list[str]:
        out = [f"Linked transfers: {len(self.pairs)}"]
        out += [
            f"  {p.debit.label()} debit  ->  {p.credit.label()} credit  ({p.evidence})"
            for p in self.pairs
        ]
        if self.ambiguous:
            out.append(f"\nAmbiguous, not linked: {len(self.ambiguous)}")
            out += [
                f"  {a.row.label()} {a.row.direction:<6}  {a.candidates} candidate(s)"
                for a in self.ambiguous
            ]
        if self.unpaired:
            out.append(f"\nUnpaired, the other half is not in the record: {len(self.unpaired)}")
            out += [
                f"  {u.row.label()} {u.row.direction:<6}  names {u.names}" for u in self.unpaired
            ]
        return out


def find(
    rows: Iterable[Row], profiles: Sequence[SourceProfile], handles: Sequence[str] = ()
) -> Report:
    """Apply the matching rule. Reads nothing and writes nothing."""
    namer = _Namer(profiles, handles)
    rows = sorted(rows, key=_order)
    credits: dict[Decimal, list[Row]] = defaultdict(list)
    for row in rows:
        if row.direction == "credit":
            credits[row.amount].append(row)

    candidates: dict[str, list[tuple[Row, str]]] = defaultdict(list)
    for debit in rows:
        if debit.direction != "debit":
            continue
        for credit in credits[debit.amount]:
            if credit.account == debit.account:
                continue
            if not 0 <= (credit.date - debit.date).days <= MAX_DAYS:
                continue
            evidence = namer.names(debit, credit) or namer.names(credit, debit)
            if evidence:
                candidates[debit.txn_id].append((credit, evidence))
                candidates[credit.txn_id].append((debit, evidence))

    accounts = sorted({row.account for row in rows})
    pairs, ambiguous, unpaired = [], [], []
    for row in rows:
        found = candidates[row.txn_id]
        if not found:
            if names := namer.mentions(row, accounts):
                unpaired.append(Unpaired(row, names))
        elif len(found) == 1 and len(candidates[found[0][0].txn_id]) == 1:
            if row.direction == "debit":
                pairs.append(Pair(row, found[0][0], found[0][1]))
        else:
            ambiguous.append(Ambiguous(row, len(found)))
    return Report(pairs, ambiguous, unpaired)


def load(db: NeonHttpDb) -> list[Row]:
    """Every transaction of a statement that passed its checks."""
    return [
        Row(
            txn_id=r["txn_id"],
            source=r["source"],
            account_last4=r["account_last4"],
            date=r["txn_date"],
            amount=r["amount"],
            direction=r["direction"],
            narration=r["narration"],
        )
        for r in db.execute(
            "select t.txn_id, s.source, s.account_last4, t.txn_date, t.amount, t.direction, "
            "t.narration from transactions t join statements s using (statement_id) "
            "where s.status = 'ok' order by t.txn_date, t.txn_id"
        )
    ]


def rebuild(db: NeonHttpDb, profiles: Sequence[SourceProfile]) -> Report:
    """Find the pairs in the record and replace every stored link with them, in one batch."""
    report = find(load(db), profiles, handles(db))
    queries: list[Query] = [("delete from transfer_links", [])]
    queries += [
        (
            "insert into transfer_links (debit_txn_id, credit_txn_id, evidence) "
            "values (%s, %s, %s)",
            [p.debit.txn_id, p.credit.txn_id, p.evidence],
        )
        for p in report.pairs
    ]
    db.batch(queries)
    return report


def handles(db: NeonHttpDb) -> list[str]:
    return [r["handle"] for r in db.execute("select handle from owner_handles order by handle")]


def add_handle(db: NeonHttpDb, handle: str) -> bool:
    """Store a handle. Returns False when it was already stored."""
    rows = db.execute(
        "insert into owner_handles (handle) values (%s) on conflict do nothing returning handle",
        [_valid_handle(handle)],
    )
    return bool(rows)


def remove_handle(db: NeonHttpDb, handle: str) -> bool:
    """Forget a handle. Returns False when it was not stored."""
    rows = db.execute(
        "delete from owner_handles where handle = %s returning handle", [" ".join(handle.split())]
    )
    return bool(rows)


class _Namer:
    """Decides whether a narration names one of your other accounts."""

    def __init__(self, profiles: Sequence[SourceProfile], handles: Sequence[str]) -> None:
        self.markers = {
            p.id: [(m, _squash(m)) for m in p.transfer_markers if _squash(m)] for p in profiles
        }
        self.handles = [_handle_matcher(h) for h in handles]

    def names(self, row: Row, other: Row) -> str | None:
        """The evidence that row's narration names other's account, or None."""
        text = _squash(row.narration)
        if other.source != row.source:
            # Within one source the markers cannot tell two accounts apart.
            for marker, squashed in self.markers.get(other.source, []):
                if squashed in text:
                    return f'marker "{marker}"'
        if _names_digits(row.narration, other.account_last4):
            return f"account *{other.account_last4}"
        if self._has_handle(row.narration):
            return "your handle"
        return None

    def mentions(self, row: Row, accounts: Sequence[tuple[str, str]]) -> str | None:
        """The account, other than its own, that row's narration names, or None."""
        text = _squash(row.narration)
        for source, markers in self.markers.items():
            if source != row.source and any(squashed in text for _, squashed in markers):
                return source
        for account in accounts:
            if account != row.account and _names_digits(row.narration, account[1]):
                return _account_name(*account)
        if self._has_handle(row.narration):
            return "one of your accounts"
        return None

    def _has_handle(self, narration: str) -> bool:
        return any(matches(narration) for matches in self.handles)


def _handle_matcher(handle: str) -> Callable[[str], bool]:
    # A numeric handle (phone digits) must end a run of digits, as in 98XXXX7319@ybl, so it is
    # not found inside a reference number. Other handles match as text.
    if handle.isdigit():
        pattern = _digits_end(handle)
        return lambda narration: bool(pattern.search(narration))
    squashed = _squash(handle)
    return lambda narration: squashed in _squash(narration)


def _names_digits(narration: str, last4: str) -> bool:
    # Two printed digits match too many unrelated numbers to count as evidence.
    if len(last4) != 4 or not last4.isdigit():
        return False
    return bool(_digits_end(last4).search(narration))


def _digits_end(digits: str) -> re.Pattern[str]:
    return re.compile(rf"(?<!\d)\d*{re.escape(digits)}(?!\d)")


def _squash(text: str) -> str:
    # Narrations wrap and space words unevenly: "SBI CARD", "SBICARD", "Sbi  Card".
    return "".join(text.casefold().split())


def _valid_handle(handle: str) -> str:
    # A name is stored with single spaces; matching ignores spacing anyway.
    if not handle.isprintable() or len(_squash(handle)) < MIN_HANDLE_LENGTH:
        raise ConfigError(
            f"A handle must be {MIN_HANDLE_LENGTH} or more printable characters, such as the "
            "last four digits of the phone number in your UPI IDs, or your name as your bank "
            "prints it."
        )
    return " ".join(handle.split())


def _account_name(source: str, last4: str) -> str:
    return f"{source} *{last4}" if last4 else source


def _order(row: Row) -> tuple[date, str, str, str, Decimal, str]:
    return (row.date, row.source, row.account_last4, row.direction, row.amount, row.txn_id)
