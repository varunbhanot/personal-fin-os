"""finos status: what is in the record, month by month, own-account transfers, and what the AI
has cost."""

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
    transfers_linked: int = 0  # pairs stored by the last rebuild
    transfers_unpaired: int = 0  # rows that name another account and have no partner yet


def status(db: NeonHttpDb, profiles: Sequence[SourceProfile] = ()) -> Status:
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
    linked = db.execute("select count(*)::int as n from transfer_links")[0]["n"]
    unpaired = len(find(load(db), profiles, handles(db)).unpaired) if profiles else 0
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
        transfers_linked=linked,
        transfers_unpaired=unpaired,
    )
