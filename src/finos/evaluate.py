"""finos eval: how another model, usually a cheaper one, compares with the verified record.

The reference is the record itself: statements that passed their checks, and categories you
confirmed or that need no review. Each statement's PDF is downloaded from Drive again, checked
against the stored SHA-256, unlocked and transcribed by the model under test, exactly as
finos sync would. Its rows are compared with the stored rows by date, direction and amount;
no narration is compared or printed. With categories, each counted row is asked again, on its
own and without memory, in the same request finos categorise sends.

Nothing is written to statements, transactions, extractions or categorisations. Every call
goes through Claude.structured, so it is recorded in ai_usage (as eval-extract or
eval-categorise) and counts against FINOS_AI_BUDGET_USD. Each run leaves one row in eval_runs.
"""

import hashlib
import logging
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Literal

from finos.ai import StructuredReply, cost_usd
from finos.categorise import BATCH_SIZE, Category, Plan, answers, ask_batch, blind_plan
from finos.db import NeonHttpDb
from finos.errors import BudgetExceeded, ConfigError, FinosError
from finos.extract import StructuredClaude, extract
from finos.identify import SourceProfile
from finos.inbox import Drive, DriveFile
from finos.secrets import Secrets
from finos.sync import open_statement, statement_passwords
from finos.transfers import find, handles, load

EXTRACT_PURPOSE = "eval-extract"
CATEGORISE_PURPOSE = "eval-categorise"
# A typical extraction call, in tokens, for the estimate when ai_usage has none yet.
_INPUT_PER_STATEMENT = 30_000
_OUTPUT_PER_STATEMENT = 8_000
_ATTEMPTS = 2  # extract() retries once when the checks fail

log = logging.getLogger(__name__)

Key = tuple[date, str, Decimal]  # a row as compared: date, direction, amount


# --- comparing rows ------------------------------------------------------------------------


@dataclass(frozen=True)
class Comparison:
    stored: int
    new: int
    matched: int  # same date, direction and amount
    amount_mismatches: int  # same date and direction, another amount
    missing: int  # stored rows the new transcription does not have
    extra: int  # new rows the record does not have

    @property
    def match_rate(self) -> Decimal:
        larger = max(self.stored, self.new)
        return Decimal(self.matched) / larger if larger else Decimal(1)


def compare_rows(stored: Sequence[Key], new: Sequence[Key]) -> Comparison:
    """Match the rows as multisets. What is left over is paired on date and direction first,
    as an amount misread; the rest is missing or extra."""
    left, right = Counter(stored), Counter(new)
    matched = sum((left & right).values())
    left_over = Counter((d, way) for (d, way, _), n in (left - right).items() for _ in range(n))
    right_over = Counter((d, way) for (d, way, _), n in (right - left).items() for _ in range(n))
    misread = sum((left_over & right_over).values())
    return Comparison(
        stored=len(stored),
        new=len(new),
        matched=matched,
        amount_mismatches=misread,
        missing=sum(left_over.values()) - misread,
        extra=sum(right_over.values()) - misread,
    )


# --- the plan ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Candidate:
    """A verified statement to transcribe again. Named by period and account, not file name."""

    statement_id: str
    source: str
    account_last4: str
    period_start: date
    period_end: date
    reference_model: str
    rows: int
    file: DriveFile | None  # where the PDF was last seen in Drive

    def label(self) -> str:
        account = f" *{self.account_last4}" if self.account_last4 else ""
        return f"{self.period_start} to {self.period_end} {self.source}{account}"


@dataclass(frozen=True)
class CategoryRow:
    txn_id: str
    category: str  # the reference
    confirmed: bool  # you confirmed or corrected it


@dataclass(frozen=True)
class EvalPlan:
    statements: list[Candidate]
    category_rows: list[CategoryRow]
    blind: Plan | None = field(default=None, repr=False)  # the category requests, if asked
    _usage: tuple[int, int, int, int] = (_INPUT_PER_STATEMENT, _OUTPUT_PER_STATEMENT, 0, 0)

    def estimated_usd(self, model: str) -> Decimal:
        """An upper figure: every statement takes both attempts, at the average size of the
        extract calls in ai_usage, plus the category batches."""
        tokens_in, tokens_out, cache_read, cache_write = self._usage
        usage = SimpleNamespace(
            input_tokens=tokens_in,
            output_tokens=tokens_out,
            cache_read_input_tokens=cache_read,
            cache_creation_input_tokens=cache_write,
        )
        total = cost_usd(model, usage) * _ATTEMPTS * len(self.statements)
        if self.blind is not None:
            total += self.blind.estimated_usd(model)
        return total


def eval_plan(
    db: NeonHttpDb,
    *,
    profiles: Sequence[SourceProfile],
    categories: Sequence[Category] | None = None,
    limit: int | None = None,
    source: str | None = None,
    batch_size: int = BATCH_SIZE,
) -> EvalPlan:
    """What a run would compare, and its estimate. Reads the database; no Drive, no Claude.

    Statements are taken by period, oldest first; limit and source narrow them. With
    categories, the rows of those statements that count, are not linked transfers, and have a
    category that you confirmed or that needs no review, are asked again.
    """
    if limit is not None and limit < 1:
        raise ConfigError("The limit must be 1 or more statements.")
    found = db.execute(
        "select s.statement_id, s.source, s.account_last4, s.period_start, s.period_end, "
        "e.model, (select count(*)::int from transactions t "
        "where t.statement_id = s.statement_id) as n, "
        "f.drive_file_id, f.drive_md5, f.name "
        "from statements s join extractions e using (statement_id) "
        "left join lateral (select d.drive_file_id, d.drive_md5, sf.name from drive_files d "
        "join source_files sf using (sha256) where d.sha256 = s.statement_id "
        "order by d.seen_at desc, d.drive_file_id limit 1) f on true "
        "where s.status = 'ok' and (%s::text is null or s.source = %s) "
        "order by s.period_start, s.source, s.account_last4, s.statement_id limit %s",
        [source, source, limit],
    )
    statements = [
        Candidate(
            statement_id=r["statement_id"],
            source=r["source"],
            account_last4=r["account_last4"],
            period_start=r["period_start"],
            period_end=r["period_end"],
            reference_model=r["model"],
            rows=r["n"],
            file=(
                DriveFile(id=r["drive_file_id"], name=r["name"], md5=r["drive_md5"])
                if r["drive_file_id"]
                else None
            ),
        )
        for r in found
    ]
    rows: list[CategoryRow] = []
    blind = None
    if categories is not None:
        chosen = {c.statement_id for c in statements}
        rows = [
            CategoryRow(r["txn_id"], r["category"], r["confirmed"])
            for r in db.execute(
                "select v.txn_id, v.category, n.statement_id, g.origin = 'user' as confirmed "
                "from v_transactions v join v_counted_transactions n using (txn_id) "
                "join categorisations g using (txn_id) "
                "where not v.linked and v.category is not null and g.problem is null "
                "and (g.origin = 'user' or not g.needs_review) "
                "order by v.txn_date, v.txn_id"
            )
            if r["statement_id"] in chosen
        ]
        wanted = {r.txn_id for r in rows}
        everything = load(db)
        blind = blind_plan(
            db,
            [row for row in everything if row.txn_id in wanted],
            categories=categories,
            report=find(everything, profiles, handles(db)),
            batch_size=batch_size,
        )
    return EvalPlan(statements, rows, blind, _extract_usage(db))


def _extract_usage(db: NeonHttpDb) -> tuple[int, int, int, int]:
    """The average size of past extract calls, or typical figures when there are none."""
    row = db.execute(
        "select count(*)::int as n, avg(input_tokens)::int as tokens_in, "
        "avg(output_tokens)::int as tokens_out, avg(cache_read_tokens)::int as cache_read, "
        "avg(cache_write_tokens)::int as cache_write from ai_usage where purpose = 'extract'"
    )[0]
    if not row["n"]:
        return (_INPUT_PER_STATEMENT, _OUTPUT_PER_STATEMENT, 0, 0)
    return (row["tokens_in"], row["tokens_out"], row["cache_read"], row["cache_write"])


# --- a run ---------------------------------------------------------------------------------

Outcome = Literal["compared", "failed", "skipped", "stopped"]


@dataclass(frozen=True)
class Checked:
    """One statement's result. "failed": the model under test gave no usable transcription."""

    candidate: Candidate
    outcome: Outcome
    detail: str = ""
    comparison: Comparison | None = None
    balances_equal: bool = False  # the opening and closing the record holds
    verified: bool = False  # the new transcription passed every check


@dataclass(frozen=True)
class EvalResult:
    model: str
    checked: list[Checked]
    calls: int
    cost_usd: Decimal
    categories_asked: int | None = None
    categories_agreed: int | None = None
    confirmed_asked: int | None = None  # of those, the rows you confirmed or corrected
    confirmed_agreed: int | None = None
    stopped: str | None = None  # why the run ended early
    run_id: int | None = None


class _Metered:
    """Counts the calls that came back, and what they cost."""

    def __init__(self, claude: StructuredClaude) -> None:
        self.claude = claude
        self.calls = 0
        self.cost = Decimal(0)

    def structured(self, **kwargs: Any) -> StructuredReply:
        reply = self.claude.structured(**kwargs)
        self.calls += 1
        self.cost += reply.cost_usd
        return reply


def run_eval(
    db: NeonHttpDb,
    claude: StructuredClaude,
    *,
    drive: Drive,
    secrets: Secrets,
    profiles: Sequence[SourceProfile],
    categories: Sequence[Category],
    planned: EvalPlan,
    model: str,
    effort: str = "medium",
    on_statement: Callable[[Checked], None] = lambda checked: None,
) -> EvalResult:
    """Transcribe each planned statement with model and compare; then ask the categories.

    A file that is gone from Drive, or whose bytes changed, is skipped and named. Reaching the
    budget stops the run; what was done is still reported and stored in eval_runs.
    """
    metered = _Metered(claude)
    passwords = statement_passwords(secrets)
    checked: list[Checked] = []
    stopped: str | None = None

    for candidate in planned.statements:
        if stopped is not None:
            result = Checked(candidate, "stopped", "AI budget reached")
        else:
            try:
                result = _check(db, metered, drive, passwords, profiles, candidate, model, effort)
            except BudgetExceeded as error:
                stopped = str(error)
                result = Checked(candidate, "stopped", stopped)
        checked.append(result)
        on_statement(result)

    asked = agreed = confirmed_asked = confirmed_agreed = None
    if planned.blind is not None and stopped is None:
        asked = agreed = confirmed_asked = confirmed_agreed = 0
        reference = {r.txn_id: r for r in planned.category_rows}
        blind = planned.blind
        for start in range(0, blind.to_send, blind.batch_size):
            batch = blind.groups[start : start + blind.batch_size]
            try:
                reply = ask_batch(
                    metered, blind, batch, model=model, categories=categories,
                    profiles=profiles, effort=effort, purpose=CATEGORISE_PURPOSE,
                )  # fmt: skip
                given = {
                    group[0].row.txn_id: answer.category
                    for group, answer in answers(reply, batch, categories, blind.memory)
                }
            except FinosError as error:  # the budget, or the API
                stopped = str(error)
                break
            for group in batch:
                row = reference[group[0].row.txn_id]
                same = given.get(row.txn_id) == row.category
                asked, agreed = asked + 1, agreed + same
                if row.confirmed:
                    confirmed_asked, confirmed_agreed = confirmed_asked + 1, confirmed_agreed + same

    result = EvalResult(
        model=model,
        checked=checked,
        calls=metered.calls,
        cost_usd=metered.cost,
        categories_asked=asked,
        categories_agreed=agreed,
        confirmed_asked=confirmed_asked,
        confirmed_agreed=confirmed_agreed,
        stopped=stopped,
    )
    return replace(result, run_id=_store_run(db, result))


def _check(
    db: NeonHttpDb,
    claude: StructuredClaude,
    drive: Drive,
    passwords: Any,
    profiles: Sequence[SourceProfile],
    candidate: Candidate,
    model: str,
    effort: str,
) -> Checked:
    if candidate.file is None:
        return Checked(candidate, "skipped", "no Drive file is recorded for this statement")
    try:
        content = drive.download(candidate.file)
        if hashlib.sha256(content).hexdigest() != candidate.statement_id:
            return Checked(
                candidate,
                "skipped",
                "the file in Drive has changed since it was imported, so it is not the "
                "statement in the record",
            )
        opened = open_statement(content, passwords, profiles, name=candidate.file.name)
    except FinosError as error:
        return Checked(candidate, "skipped", str(error))
    if opened.profile.id != candidate.source:
        return Checked(
            candidate,
            "skipped",
            f"the file now matches the profile {opened.profile.id}, not {candidate.source}",
        )

    stored = db.execute(
        "select txn_date, direction, amount from transactions where statement_id = %s order by seq",
        [candidate.statement_id],
    )
    stored_keys = [(r["txn_date"], r["direction"], r["amount"]) for r in stored]
    try:
        result = extract(
            claude,
            model=model,
            pdf=opened.pdf,
            profile=opened.profile,
            page_texts=opened.texts,
            effort=effort,
            purpose=EXTRACT_PURPOSE,
        )
    except BudgetExceeded:
        raise
    except FinosError as error:
        return Checked(candidate, "failed", str(error), compare_rows(stored_keys, []))

    totals = db.execute(
        "select printed_totals from statements where statement_id = %s", [candidate.statement_id]
    )[0]["printed_totals"]
    new = result.statement
    return Checked(
        candidate,
        "compared",
        comparison=compare_rows(
            stored_keys, [(t.date, t.direction, t.amount) for t in new.transactions]
        ),
        balances_equal=(
            Decimal(totals["opening"]) == new.totals.opening
            and Decimal(totals["closing"]) == new.totals.closing
        ),
        verified=not result.problems,
    )


def _store_run(db: NeonHttpDb, result: EvalResult) -> int:
    done = [c for c in result.checked if c.comparison is not None]
    comparisons = [c.comparison for c in done if c.comparison is not None]
    references = sorted({c.candidate.reference_model for c in done})
    return db.execute(
        "insert into eval_runs (model, reference_model, statements, skipped, rows_stored, "
        "rows_matched, amount_mismatches, rows_missing, rows_extra, verified, categories_asked, "
        "categories_agreed, cost_usd) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "returning id",
        [
            result.model,
            ", ".join(references) or "-",
            len(done),
            sum(c.outcome == "skipped" for c in result.checked),
            sum(c.stored for c in comparisons),
            sum(c.matched for c in comparisons),
            sum(c.amount_mismatches for c in comparisons),
            sum(c.missing for c in comparisons),
            sum(c.extra for c in comparisons),
            sum(c.verified for c in done),
            result.categories_asked,
            result.categories_agreed,
            result.cost_usd,
        ],
    )[0]["id"]
