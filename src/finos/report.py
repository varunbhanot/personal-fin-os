"""finos status: what is in the record, month by month, own-account transfers, categories,
and what the AI has cost."""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from finos.db import NeonHttpDb
from finos.identify import SourceProfile
from finos.transfers import find, handles, load


@dataclass(frozen=True)
class StatementLine:
    month: str  # YYYY-MM of the statement's period end
    source: str
    account_last4: str
    status: str
    transactions: int
    problems: list[str]


@dataclass(frozen=True)
class Status:
    statements: list[StatementLine]
    spent_this_month: Decimal
    spent_total: Decimal
    # Both from one live match of the record, so they agree even before finos transfers runs.
    transfers_linked: int
    transfers_unpaired: int  # rows that name another account and have no partner yet
    # Rows of ok statements that are not half of a linked transfer.
    categorised: int  # with a category you have no need to check
    to_review: int  # waiting in finos review
    uncategorised: int  # no category yet: run finos categorise
    corrections_this_month: int


def status(db: NeonHttpDb, profiles: Sequence[SourceProfile]) -> Status:
    rows = db.execute(
        "select to_char(s.period_end, 'YYYY-MM') as month, s.source, s.account_last4, s.status, "
        "s.problems, count(t.txn_id)::int as transactions "
        "from statements s left join transactions t on t.statement_id = s.statement_id "
        "group by s.statement_id order by month, s.source, s.account_last4"
    )
    spend = db.execute(
        "select coalesce(sum(cost_usd) filter (where at >= date_trunc('month', now())), 0) "
        "as this_month, coalesce(sum(cost_usd), 0) as total from ai_usage"
    )[0]
    txns = load(db)
    transfers = find(txns, profiles, handles(db))
    linked = {p.debit.txn_id for p in transfers.pairs} | {p.credit.txn_id for p in transfers.pairs}
    review_state = {
        r["txn_id"]: r["needs_review"]
        for r in db.execute("select txn_id, needs_review from categorisations")
    }
    open_rows = [txn.txn_id for txn in txns if txn.txn_id not in linked]
    corrections = db.execute(
        "select count(*)::int as n from corrections where at >= date_trunc('month', now())"
    )[0]["n"]
    return Status(
        statements=[
            StatementLine(
                month=row["month"],
                source=row["source"],
                account_last4=row["account_last4"],
                status=row["status"],
                transactions=row["transactions"],
                problems=list(row["problems"]),
            )
            for row in rows
        ],
        spent_this_month=Decimal(spend["this_month"]),
        spent_total=Decimal(spend["total"]),
        transfers_linked=len(transfers.pairs),
        transfers_unpaired=len(transfers.unpaired),
        categorised=sum(review_state.get(t) is False for t in open_rows),
        to_review=sum(review_state.get(t) is True for t in open_rows),
        uncategorised=sum(t not in review_state for t in open_rows),
        corrections_this_month=corrections,
    )
