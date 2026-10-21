"""The finos command line.

Every command reads its non-secret settings from FINOS_* variables. Secrets come from Doppler
into memory, and requests to Neon and Doppler carry no credential of their own: the cloud
environment's network secrets add them. No command ever prints a secret value.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation

import httpx
import typer

from finos.ai import Claude, spent_this_month
from finos.categorise import Correction, add_note, group_rows, load_categories, plan, remove_note
from finos.categorise import Result as Categorised
from finos.categorise import accept as accept_counterparties
from finos.categorise import categorise as run_categorise
from finos.categorise import correct as correct_counterparty
from finos.categorise import notes as list_notes
from finos.categorise import recategorise as recategorise_rows
from finos.categorise import review as review_queue
from finos.config import Settings, load_settings
from finos.db import NeonHttpDb
from finos.errors import FinosError
from finos.evaluate import Checked, EvalResult, eval_plan, run_eval
from finos.goals import add_goal, assign, goal_progress, goals, remove_goal, unassign
from finos.identify import load_profiles
from finos.inbox import Drive, no_auth, service_account_auth
from finos.migrate import migrate
from finos.month import MonthView, month_view, months, parse_month, spread_problems
from finos.month import rows as list_rows
from finos.report import status as load_status
from finos.secrets import Secrets, load_secrets
from finos.spread import SHOWN_ID, Problem, Spread, add_spread, problems, remove_spread, spreads
from finos.store import forget_flagged
from finos.sync import FileResult, Identified, identify_files
from finos.sync import sync as run_sync
from finos.transfers import add_handle, find, handles, load, rebuild, remove_handle

app = typer.Typer(
    no_args_is_help=True,
    help=(
        "Statement pipeline: check, identify, sync, status, transfers, accounts, the "
        "categories (categorise, review, correct, recategorise, accept, notes), the monthly "
        "figures (month, sql), the rows, spread costs and goals (rows, spread, goal), and a model "
        "comparison (eval)."
    ),
    # Tracebacks must never print local variables: some of them hold secrets.
    pretty_exceptions_show_locals=False,
)


def _plain(text: object, limit: int = 600) -> str:
    """Keep printed text printable and bounded.

    File names, statement-derived problems and server messages can carry third-party text, and
    this output lands in the Claude Code transcript.
    """
    printable = "".join(ch if ch.isprintable() or ch == "\n" else " " for ch in str(text))
    return printable if len(printable) <= limit else printable[: limit - 1] + "…"


def _account(digits: str) -> str:
    """The printed digits of an account, or nothing when the statement masks them all."""
    return f"*{_plain(digits, 4)}" if digits else ""


def _http_client() -> httpx.Client:
    # Statement downloads and Claude extractions can take a while.
    return httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))


@contextmanager
def _session() -> Iterator[tuple[Settings, httpx.Client]]:
    try:
        settings = load_settings()
        with _http_client() as http:
            yield settings, http
    except FinosError as error:
        typer.echo(_plain(error), err=True)
        raise typer.Exit(1) from None


@contextmanager
def _db() -> Iterator[NeonHttpDb]:
    """The database, migrated, for commands that use nothing else."""
    with _session() as (settings, http):
        db = NeonHttpDb(settings.neon_sql_url, http)
        migrate(db)
        yield db


def _drive(settings: Settings, http: httpx.Client, secrets: Secrets) -> Drive:
    auth: Callable[[], dict[str, str]] = no_auth
    if "GDRIVE_SA_JSON" in secrets.names():
        auth = service_account_auth(secrets.get("GDRIVE_SA_JSON"))
    return Drive(http, settings.drive_folder_id, auth=auth)


@app.command()
def check() -> None:
    """Check settings, secrets, the database and the Drive folder. Prints names, never values.

    Each part is checked even when an earlier one fails, so one run shows every problem.
    """
    with _session() as (settings, http):
        # The Neon network secret's allowed website must be exactly this host.
        typer.echo(f"settings   ok  (Neon SQL host {httpx.URL(settings.neon_sql_url).host})")
        ok = True

        secrets: Secrets | None = None
        try:
            secrets = load_secrets(http, settings.doppler_url)
        except FinosError as error:
            ok = False
            typer.echo(f"secrets    FAILED  {_plain(error)}")
        else:
            expected = {"ANTHROPIC_KEY"} | {
                p.password_secret for p in load_profiles() if p.password_secret
            }
            for name in sorted(expected):
                found = name in secrets.names()
                ok = ok and found
                typer.echo(f"secret     {'ok' if found else 'MISSING':<8}{name}")
            drive_mode = "service account key" if "GDRIVE_SA_JSON" in secrets.names() else "proxy"
            typer.echo(f"drive auth     {drive_mode}")

        try:
            applied = migrate(NeonHttpDb(settings.neon_sql_url, http))
        except FinosError as error:
            ok = False
            typer.echo(f"database   FAILED  {_plain(error)}")
        else:
            typer.echo(f"database   ok  ({len(applied)} migration(s) applied now)")

        if secrets is None:
            # Drive may need GDRIVE_SA_JSON from Doppler, so its result would mislead.
            typer.echo("drive      skipped (needs the Doppler secrets)")
        else:
            try:
                pdfs = _drive(settings, http, secrets).list_pdfs()
            except FinosError as error:
                ok = False
                typer.echo(f"drive      FAILED  {_plain(error)}")
            else:
                typer.echo(f"drive      ok  ({len(pdfs)} PDF(s) in the statements folder)")

        if not ok:
            raise typer.Exit(1)


@app.command()
def identify() -> None:
    """Show which source profile each PDF in the Drive folder matches.

    Free: no Claude call, and the database is not used. Run it after changing a profile's
    markers, before a sync that would pay for extraction.
    """
    with _session() as (settings, http):
        secrets = load_secrets(http, settings.doppler_url)

        def show(result: Identified) -> None:
            line = f"{result.source or 'failed':<14}{_plain(result.name, 200)}"
            if result.opened_with == "no password":
                line += "  (no password)"
            elif result.opened_with:
                line += f"  (opened with {_plain(result.opened_with, 100)})"
            typer.echo(f"{line}\n              {_plain(result.detail)}" if result.detail else line)

        results = identify_files(
            drive=_drive(settings, http, secrets),
            secrets=secrets,
            profiles=load_profiles(),
            on_result=show,
        )
        if not results:
            # Drive lists nothing, rather than refusing, when the ID is wrong or not shared.
            typer.echo(
                "No PDFs in the statements folder. Check that FINOS_DRIVE_FOLDER_ID is the ID of "
                "the Statements folder, that the folder is shared with the service account, and "
                "that the PDFs are directly in it."
            )
            raise typer.Exit(1)
        failed = sum(r.source is None for r in results)
        typer.echo(f"\n{len(results)} file(s); {failed} failed.")
        if failed:
            raise typer.Exit(1)


@app.command()
def sync(
    retry_flagged: bool = typer.Option(
        False,
        "--retry-flagged",
        help="Re-extract flagged statements, e.g. after a source profile was fixed.",
    ),
) -> None:
    """Import every new statement from the Drive folder."""
    with _session() as (settings, http):
        secrets = load_secrets(http, settings.doppler_url)
        db = NeonHttpDb(settings.neon_sql_url, http)
        migrate(db)
        if retry_flagged:
            typer.echo(f"Retrying {forget_flagged(db)} flagged statement(s).")
        claude = Claude.from_key(
            secrets.get("ANTHROPIC_KEY"), db, budget_usd=settings.ai_budget_usd
        )

        def show(result: FileResult) -> None:
            line = f"{result.outcome:<10}{_plain(result.name, 200)}"
            typer.echo(f"{line}\n          {_plain(result.detail)}" if result.detail else line)

        categorised: list[Categorised] = []
        results = run_sync(
            drive=_drive(settings, http, secrets),
            db=db,
            claude=claude,
            secrets=secrets,
            profiles=load_profiles(),
            model=settings.model_extract,
            on_result=show,
            categorise_model=settings.model_categorise,
            review_min=settings.review_min_inr,
            on_categorised=categorised.append,
        )
        for outcome in categorised:
            typer.echo("")
            for line in _categorised_lines(outcome):
                typer.echo(line)
        counts = {o: sum(r.outcome == o for r in results) for o in ("failed", "flagged")}
        typer.echo(
            f"\n{len(results)} file(s); {counts['flagged']} flagged, {counts['failed']} failed. "
            f"AI spend this month: ${claude.spent_this_month()}"
        )
        if counts["failed"]:
            raise typer.Exit(1)


@app.command()
def status() -> None:
    """Show which statements are in the record, and AI spend."""
    with _session() as (settings, http):
        db = NeonHttpDb(settings.neon_sql_url, http)
        migrate(db)
        report = load_status(db, load_profiles())
        if not report.statements:
            typer.echo("No statements yet. Run finos sync.")
        for line in report.statements:
            typer.echo(
                f"{line.month}  {line.source:<14} {_account(line.account_last4):<5}  "
                f"{line.status:<8}"
                f"{line.transactions:>4} transactions"
            )
            for problem in line.problems:
                typer.echo(f"          {_plain(problem)}")
        typer.echo(
            f"\nTransfers: {report.transfers_linked} linked, {report.transfers_unpaired} unpaired"
        )
        typer.echo(
            f"Categories: {report.categorised} categorised, {report.to_review} to review, "
            f"{report.uncategorised} not categorised yet; "
            f"{report.corrections_this_month} correction(s) this month"
        )
        typer.echo(
            f"AI spend: ${report.spent_this_month} this month, ${report.spent_total} in total"
        )


@app.command()
def transfers() -> None:
    """Link the debits and credits that move money between your own accounts, and list them.

    Free: the database only, no Claude call. Rows are named by source, date and amount; a
    narration is never printed.
    """
    with _db() as db:
        for line in rebuild(db, load_profiles()).lines():
            typer.echo(_plain(line))


accounts_app = typer.Typer(help="Your accounts, as seen in statements, and your handles.")
app.add_typer(accounts_app, name="accounts")


@accounts_app.callback(invoke_without_command=True)
def accounts(ctx: typer.Context) -> None:
    """List the accounts in the record and your handles."""
    if ctx.invoked_subcommand:
        return
    with _db() as db:
        rows = db.execute(
            "select source, account_last4, count(*)::int as statements, "
            "min(period_start) as first, max(period_end) as last "
            "from statements group by source, account_last4 order by source, account_last4"
        )
        if not rows:
            typer.echo("No accounts yet. Run finos sync.")
        for row in rows:
            name = f"{row['source']} {_account(row['account_last4'])}".strip()
            typer.echo(
                f"{name:<20} {row['statements']:>3} statement(s), "
                f"{row['first'].isoformat()} to {row['last'].isoformat()}"
            )
        stored = handles(db)
        typer.echo(f"\nHandles: {_plain(', '.join(stored)) if stored else 'none'}")


@accounts_app.command("add")
def accounts_add(handle: str) -> None:
    """Add a handle: text that names you in a narration, such as your UPI phone digits."""
    with _db() as db:
        added = add_handle(db, handle)
        typer.echo("Added the handle." if added else "That handle is already stored.")
        typer.echo("Run finos transfers to link with it.")


@accounts_app.command("remove")
def accounts_remove(handle: str) -> None:
    """Remove a handle."""
    with _db() as db:
        removed = remove_handle(db, handle)
        typer.echo("Removed the handle." if removed else "That handle is not stored.")


def _categorised_lines(result: Categorised) -> list[str]:
    lines = [
        f"Categorised {result.from_memory + result.from_ai} row(s): {result.from_memory} from "
        f"memory, {result.from_ai} by Claude in {result.calls} call(s) costing "
        f"${result.cost_usd}."
    ]
    if result.to_review:
        lines.append(f"To review: {result.to_review} row(s). Run finos review.")
    if result.rejected:
        lines.append(
            f"Rejected: {result.rejected} answer(s) from Claude failed the checks; "
            "their rows stay uncategorised."
        )
    if result.left:
        lines.append(f"Not categorised: {result.left}. Run finos categorise to try again.")
    if result.error:
        lines.append(f"Stopped: {_plain(result.error)}")
    return lines


@app.command()
def categorise(
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Count the rows and estimate the cost. No Claude call."
    ),
) -> None:
    """Give each new transaction a category: from memory first, then from Claude.

    Linked transfers are skipped. A narration is never printed.
    """
    with _session() as (settings, http):
        db = NeonHttpDb(settings.neon_sql_url, http)
        migrate(db)
        profiles = load_profiles()
        categories = load_categories()
        if dry_run:
            planned = plan(db, categories=categories, report=find(load(db), profiles, handles(db)))
            by_claude = planned.rows - planned.from_memory
            shared = (
                f", which also answer {by_claude - planned.to_send} row(s) with the same payee"
                if by_claude > planned.to_send
                else ""
            )
            estimate = planned.estimated_usd(settings.model_categorise)
            typer.echo(f"Rows to categorise: {planned.rows}")
            typer.echo(f"  From memory: {planned.from_memory} row(s)")
            typer.echo(
                f"  To Claude: {planned.to_send} row(s) in {planned.batches} call(s){shared}"
            )
            typer.echo(
                f"  Estimated cost: about ${estimate:.2f} with {settings.model_categorise} "
                "(a rough figure; finos status shows the real spend afterwards)"
            )
            typer.echo("No Claude call was made.")
            return

        secrets = load_secrets(http, settings.doppler_url)
        claude = Claude.from_key(
            secrets.get("ANTHROPIC_KEY"), db, budget_usd=settings.ai_budget_usd
        )
        result = run_categorise(
            db,
            claude,
            model=settings.model_categorise,
            categories=categories,
            profiles=profiles,
            report=rebuild(db, profiles),
            review_min=settings.review_min_inr,
        )
        for line in _categorised_lines(result):
            typer.echo(line)
        typer.echo(f"AI spend this month: ${claude.spent_this_month()}")
        if result.error:
            raise typer.Exit(1)


@app.command("review")
def review_command(
    group: str | None = typer.Argument(
        None, help="A group's ID: list its rows by date, account and amount."
    ),
) -> None:
    """List the rows waiting for you, by counterparty, least certain first.

    Each line starts with an ID for finos accept and finos correct. The names come from Claude
    and hold only letters, digits and simple punctuation; a narration is never printed.
    """
    with _db() as db:
        if group is not None:
            found = group_rows(db, group)
            typer.echo(f"{found.id}  {_line(found.counterparty, 40)}  {_line(found.category, 40)}")
            for row in found.entries:
                account = f"{row.source} {_account(row.account_last4)}".strip()
                typer.echo(
                    f"  {row.date.isoformat()}  {_line(account, 30):<22} {row.direction:<6} "
                    f"{row.amount:>12.2f}"
                )
            return
        groups = review_queue(db)
        if not groups:
            typer.echo("Nothing to review.")
            return
        names = len({g.counterparty.lower() for g in groups})
        typer.echo(f"To review: {sum(g.rows for g in groups)} row(s), {names} counterparties\n")
        for g in groups:
            money = f"{'out' if g.direction == 'debit' else 'in'} {g.amount:.2f}"
            typer.echo(
                f"{g.id}  {_line(g.counterparty, 40):<40} {_line(g.category, 40):<29} "
                f"{g.rows:>3} row(s)  {money:<16} {g.confidence}"
            )
            if g.problem:
                typer.echo(f"        problem: {_line(g.problem, 200)}")
        typer.echo("\nAccept as shown:   finos accept <id> ... (or --all)")
        typer.echo('Change a category: finos correct <id> "<category>"')


def _line(text: object, limit: int) -> str:
    """_plain on one line: a review line must not break into lines that look like others."""
    return " ".join(_plain(text, limit).split())


@app.command()
def correct(
    counterparty: str,
    category: str,
    once: bool = typer.Option(
        False,
        "--once",
        help="Change these rows only; do not remember the payee's name. For a generic name such "
        "as 'Bank' or 'Credit Card'.",
    ),
    direction: str | None = typer.Option(
        None,
        "--direction",
        help="With a name: change only money 'in' or money 'out'. An ID already has one.",
    ),
) -> None:
    """Set a counterparty's category on all its rows, and remember it for later rows.

    Name the counterparty by its ID from finos review (or by its name). The ID of an Unknown
    group, or of a group in your own name, changes only that group's rows and remembers
    nothing. For single rows, use finos recategorise.
    """
    ways = {"in": "credit", "out": "debit", None: None}
    if direction not in ways:
        typer.echo("--direction must be 'in' or 'out'.", err=True)
        raise typer.Exit(1)
    with _db() as db:
        result = correct_counterparty(
            db, load_categories(), counterparty, category, once=once, direction=ways[direction]
        )
        typer.echo(
            f"{_plain(result.counterparty, 40)}: {result.rows} row(s) now {result.category}. "
            f"{_counted(result)}"
        )


def _counted(result: Correction) -> str:
    return (
        "Counted as a correction."
        if result.counted
        else "It already had that category, so it is not counted as a correction."
    )


@app.command()
def recategorise(
    row_ids: list[str] = typer.Argument(  # noqa: B008
        ..., metavar="ROW-ID...", help="Row IDs from finos rows."
    ),
    category: str = typer.Argument(..., metavar="CATEGORY", help="The category for these rows."),
) -> None:
    """Set the category of single rows only, such as one row of Unknown.

    The counterparty's other rows keep their category, and nothing is remembered by name. An
    income category on money out still waits for review.
    """
    with _db() as db:
        result = recategorise_rows(db, load_categories(), row_ids, category)
        typer.echo(f"{result.rows} row(s) now {result.category}. {_counted(result)}")


@app.command()
def accept(
    counterparties: list[str] | None = typer.Argument(  # noqa: B008
        None, help="IDs from finos review (or counterparty names)."
    ),
    all_: bool = typer.Option(
        False,
        "--all",
        help=(
            "Accept every counterparty with one category and no problem, unsure answers "
            "included, so read finos review first. Unknown is left for you."
        ),
    ),
) -> None:
    """Confirm the category Claude gave each counterparty, and remember it for later rows."""
    if bool(counterparties) == all_:
        typer.echo("Name the counterparties to accept, or use --all (not both).", err=True)
        raise typer.Exit(1)
    with _db() as db:
        result = accept_counterparties(db, None if all_ else counterparties)
        accepted = ", ".join(_plain(name, 40) for name in result.accepted)
        typer.echo(f"Accepted: {accepted or 'none'}")
        for name, why in result.skipped:
            typer.echo(f"Skipped {_plain(name, 40)}: {_plain(why)}")


notes_app = typer.Typer(
    help="Facts about your household that help Claude categorise, such as who the cook is."
)
app.add_typer(notes_app, name="notes")


@notes_app.callback(invoke_without_command=True)
def notes_list(ctx: typer.Context) -> None:
    """List your household notes. They live in the database, never in the repository."""
    if ctx.invoked_subcommand:
        return
    with _db() as db:
        stored = list_notes(db)
        if not stored:
            typer.echo('No notes yet. Add one with finos notes add "<text>".')
        for note_id, note in stored:
            typer.echo(f"{note_id:>3}  {_plain(note, 300)}")


@notes_app.command("add")
def notes_add(text: str) -> None:
    """Add a note, such as "UPI to R. Kumar is the cook's salary"."""
    with _db() as db:
        typer.echo(f"Added note {add_note(db, text)}.")


@notes_app.command("remove")
def notes_remove(note_id: int) -> None:
    """Remove a note by its number."""
    with _db() as db:
        typer.echo(
            f"Removed note {note_id}." if remove_note(db, note_id) else f"No note {note_id}."
        )


def _inr(value: Decimal) -> str:
    """An amount in rupees with Indian digit grouping, such as 1,08,000.00."""
    whole, paise = f"{abs(value):.2f}".split(".")
    head, groups = whole[:-3], [whole[-3:]]
    while head:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return f"{'-' if value < 0 else ''}{','.join(groups)}.{paise}"


def _figure(label: str, amount: Decimal) -> str:
    return f"{label:<32}{_inr(amount):>15}"


@app.command()
def month(
    which: str | None = typer.Argument(
        None, metavar="[YYYY-MM]", help="A month to show in full, such as 2026-09."
    ),
    spread: bool = typer.Option(
        False,
        "--spread",
        help="Count each spread row in equal parts across its months (finos spread).",
    ),
) -> None:
    """Income, expenses by category, savings and investments, month by month.

    With no month, list every month. Transfers between your own accounts are left out. A month
    is partial while an account's statements do not cover every day of it. With --spread, a
    spread row counts in parts across its months, and the months it reaches are listed too.
    """
    first = parse_month(which) if which is not None else None
    if which is not None and first is None:
        typer.echo("Write the month as YYYY-MM, for example 2026-09.", err=True)
        raise typer.Exit(1)
    with _db() as db:
        if spread:
            typer.echo(SPREAD_HEADING)
        if first is None:
            listed = months(db, spread=spread)
            if not listed:
                typer.echo("No statements yet. Run finos sync.")
                return
            typer.echo(
                f"{'Month':<9}{'Covered':<9}{'Income':>15}{'Expenses':>15}{'Savings':>15}"
                f"{'Investments':>15}"
            )
            for m in listed:
                typer.echo(
                    f"{m.month:%Y-%m}  {'complete' if m.complete else 'partial':<9}"
                    f"{_inr(m.income):>15}{_inr(m.expenses):>15}{_inr(m.savings):>15}"
                    f"{_inr(m.investments):>15}"
                )
            if spread and (count := spread_problems(db)):
                typer.echo(_spread_warning(count))
            typer.echo(
                f"\nShow one month in full: finos month YYYY-MM{' --spread' if spread else ''}"
            )
            return
        view = month_view(db, load_profiles(), first, spread=spread)
        if view is None:
            typer.echo(f"No statement covers {first:%Y-%m}.")
            return
        for line in [*_coverage_lines(view), "", *_figure_lines(view), "", *_left_out_lines(view)]:
            typer.echo(line)


SPREAD_HEADING = "Spread figures: a spread row counts in equal parts across its months."


def _spread_warning(count: int) -> str:
    return f"Spread problems: {count} spread(s) do not count. Run finos spread list."


def _coverage_lines(view: MonthView) -> list[str]:
    """How many days of the month each account's statements cover."""
    state = "complete" if view.summary.complete else "partial"
    if not view.coverage:
        # A month that only a spread reaches.
        return [f"{view.summary.month:%Y-%m}  {state}: no statement covers this month"]
    whole = sum(c.days_covered == c.days_in_month for c in view.coverage)
    lines = [
        f"{view.summary.month:%Y-%m}  {state}: "
        f"{whole} of {len(view.coverage)} accounts cover the whole month"
    ]
    for c in view.coverage:
        name = f"{c.source} {_account(c.account_last4)}".strip()
        lines.append(f"  {_line(name, 30):<20} {c.days_covered:>2} of {c.days_in_month} days")
    return lines


def _figure_lines(view: MonthView) -> list[str]:
    """Income and expenses by category, then savings and investments."""
    s = view.summary
    lines = []
    for heading, kind, total, less in (
        ("Income", "income", s.income, "paid back"),
        ("Expenses", "expense", s.expenses, "refunds"),
    ):
        lines.append(_figure(heading, total))
        for c in view.categories:
            if c.kind == kind:
                offsets = f"  ({_inr(c.gross)} less {less} {_inr(c.offsets)})" if c.offsets else ""
                lines.append(_figure(f"  {_line(c.category, 40)}", c.net) + offsets)
    rate = f"  ({s.savings / s.income:.0%} of income)" if s.income > 0 else ""
    lines.append(_figure("Savings", s.savings) + rate)
    lines.append(
        _figure("Investments", s.investments)
        + f"  (in {_inr(s.investments_in)}, out {_inr(s.investments_out)})"
    )
    return lines


def _left_out_lines(view: MonthView) -> list[str]:
    """What the figures leave out, and what needs you."""
    s = view.summary
    lines = [
        "Not counted:",
        f"  Linked transfers: {s.linked_rows} row(s), {_inr(s.linked_out)} out and "
        f"{_inr(s.linked_in)} in",
        f"  Own accounts: {s.own_rows} row(s), {_inr(s.own_out)} out and {_inr(s.own_in)} in",
    ]
    if s.uncategorised_rows:
        lines.append(
            f"  No category: {s.uncategorised_rows} row(s), {_inr(s.uncategorised_out)} out and "
            f"{_inr(s.uncategorised_in)} in. Run finos categorise."
        )
    if s.review_rows:
        lines.append(
            f"Waiting for review: {s.review_rows} row(s), {_inr(s.review_amount)}. Their "
            "category stands until you decide. Run finos review."
        )
    if view.flagged:
        lines.append(
            f"Flagged: {view.flagged} statement(s) in this month are not counted. Run finos status."
        )
    if view.links_stale:
        lines.append("The transfer links differ from a new match. Run finos transfers.")
    if view.spread_problems:
        lines.append(_spread_warning(view.spread_problems))
    return lines


@app.command("eval")
def eval_command(
    model: str = typer.Option(
        ..., "--model", help="The model to compare, such as claude-haiku-5-5."
    ),
    with_categories: bool = typer.Option(
        False, "--categories", help="Also ask the categories again, without memory."
    ),
    limit: int | None = typer.Option(None, "--limit", help="Only the first N statements."),
    source: str | None = typer.Option(
        None, "--source", help="Only this source, such as axis-bank."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="List the statements and the estimate. No Drive or Claude call."
    ),
    yes: bool = typer.Option(False, "--yes", help="Make the paid Claude calls."),
) -> None:
    """Compare another model with the verified record. Writes nothing to the record.

    Each verified statement is downloaded and transcribed again with --model, and its rows are
    compared by date, direction and amount. Every call is paid and counts against the monthly
    AI budget, so the command shows its estimate and calls Claude only with --yes. A narration
    is never printed.
    """
    with _session() as (settings, http):
        db = NeonHttpDb(settings.neon_sql_url, http)
        migrate(db)
        profiles = load_profiles()
        categories = load_categories()
        planned = eval_plan(
            db,
            profiles=profiles,
            categories=categories if with_categories else None,
            limit=limit,
            source=source,
        )
        shown_model = _line(model, 60)
        if not planned.statements:
            typer.echo("No verified statements to compare. Run finos sync first.")
            return
        typer.echo(f"Statements to transcribe again with {shown_model}: {len(planned.statements)}")
        for c in planned.statements:
            missing = "" if c.file else "  (no Drive file recorded: will be skipped)"
            typer.echo(
                f"  {_line(c.label(), 80):<48} {c.rows:>4} row(s)  "
                f"reference {_line(c.reference_model, 40)}{missing}"
            )
        if planned.blind is not None:
            typer.echo(
                f"Categories to ask again: {len(planned.category_rows)} row(s) in "
                f"{planned.blind.batches} call(s)"
            )
        estimate = planned.estimated_usd(model)
        left = settings.ai_budget_usd - spent_this_month(db)
        typer.echo(
            f"Estimated cost: up to ${estimate:.2f} with {shown_model}. "
            f"AI budget left this month: ${left:.2f}."
        )
        if dry_run:
            typer.echo("No Claude call was made.")
            return
        if not yes:
            typer.echo("No Claude call was made. Run again with --yes to make these calls.")
            return
        if estimate > left:
            typer.echo(
                f"The estimate is more than the ${left:.2f} left of this month's AI budget "
                "(FINOS_AI_BUDGET_USD). Narrow the run with --limit or --source, or raise the "
                "budget.",
                err=True,
            )
            raise typer.Exit(1)

        secrets = load_secrets(http, settings.doppler_url)
        claude = Claude.from_key(
            secrets.get("ANTHROPIC_KEY"), db, budget_usd=settings.ai_budget_usd
        )
        typer.echo("")
        result = run_eval(
            db,
            claude,
            drive=_drive(settings, http, secrets),
            secrets=secrets,
            profiles=profiles,
            categories=categories,
            planned=planned,
            model=model,
            on_statement=lambda checked: typer.echo(_checked_line(checked)),
        )
        for line in _eval_lines(result):
            typer.echo(line)
        typer.echo(f"AI spend this month: ${claude.spent_this_month()}")
        if result.stopped:
            raise typer.Exit(1)


def _checked_line(checked: Checked) -> str:
    """One statement's result: counts only, never a row's text."""
    name = _line(checked.candidate.label(), 80)
    c = checked.comparison
    if checked.outcome == "compared" and c is not None:
        return (
            f"{'compared':<9}{name}: {c.matched} of {max(c.stored, c.new)} row(s) match "
            f"({c.match_rate:.0%}); {c.amount_mismatches} amount mismatch(es), {c.missing} "
            f"missing, {c.extra} extra; balances {'equal' if checked.balances_equal else 'differ'}"
            f"; checks {'passed' if checked.verified else 'failed'}"
        )
    return f"{checked.outcome:<9}{name}\n         {_line(checked.detail, 300)}"


def _eval_lines(result: EvalResult) -> list[str]:
    done = [c for c in result.checked if c.comparison is not None]
    matched = sum(c.comparison.matched for c in done if c.comparison)
    larger = sum(max(c.comparison.stored, c.comparison.new) for c in done if c.comparison)
    rate = f" ({matched / larger:.0%})" if larger else ""
    skipped = sum(c.outcome == "skipped" for c in result.checked)
    lines = [
        "",
        f"Eval run {result.run_id} with {_line(result.model, 60)}: {len(done)} statement(s) "
        f"compared, {skipped} skipped.",
        f"  Rows matched: {matched} of {larger}{rate}. Checks passed: "
        f"{sum(c.verified for c in done)} of {len(done)}.",
    ]
    if result.categories_asked is not None:
        agreed = (
            f" ({result.categories_agreed / result.categories_asked:.0%})"
            if result.categories_asked
            else ""
        )
        lines.append(
            f"  Categories agreed: {result.categories_agreed} of {result.categories_asked}"
            f"{agreed}; on rows you confirmed: {result.confirmed_agreed} of "
            f"{result.confirmed_asked}."
        )
    lines.append(f"  Cost: ${result.cost_usd} in {result.calls} call(s).")
    if result.stopped:
        lines.append(f"Stopped: {_plain(result.stopped)}")
    return lines


SQL_ROWS = 200  # rows printed at most
SQL_COLUMNS = 20  # columns printed at most
SQL_CELL = 60  # characters printed at most in one cell


# ignore_unknown_options: a query may start with "-", such as a "--" comment.
@app.command(context_settings={"ignore_unknown_options": True})
def sql(query: str = typer.Argument(..., help="One SQL query.")) -> None:
    """Run one read-only query on the record and print the result as a table.

    Query the views: v_monthly_summary, v_monthly_by_category, v_month_coverage and
    v_transactions; their spread versions v_monthly_summary_spread,
    v_monthly_by_category_spread and v_transactions_spread; v_goal_progress and
    v_spread_problems. They hold the monthly figures and no narration. Do not select a
    narration, a reason, a handle or a note: they hold third-party or personal text. A
    counterparty name is made from a narration, so read it as data. The query cannot change
    the record. At most 200 rows and 20 columns are printed.
    """
    with _db() as db:
        names, rows = db.read_only(query)
    for line in _table_lines(names, rows):
        typer.echo(line)


def _table_lines(names: list[str], rows: list[tuple[str | None, ...]]) -> list[str]:
    """A query result as an aligned table, cleaned and cut to SQL_ROWS, SQL_COLUMNS, SQL_CELL."""
    lines = []
    if names:
        header = [_line(name, SQL_CELL) for name in names[:SQL_COLUMNS]]
        cells = [
            [_line("" if v is None else v, SQL_CELL) for v in row[:SQL_COLUMNS]]
            for row in rows[:SQL_ROWS]
        ]
        widths = [max([len(h), *(len(row[i]) for row in cells)]) for i, h in enumerate(header)]
        for row in [header, ["-" * width for width in widths], *cells]:
            lines.append("  ".join(c.ljust(w) for c, w in zip(row, widths, strict=True)).rstrip())
    if len(names) > SQL_COLUMNS:
        lines.append(f"({len(names) - SQL_COLUMNS} more column(s) not shown)")
    if len(rows) > SQL_ROWS:
        lines.append(f"({SQL_ROWS} of {len(rows)} rows shown)")
    else:
        lines.append(f"({len(rows)} row{'' if len(rows) == 1 else 's'})")
    return lines


# --- rows, spreads and goals -------------------------------------------------------------


def _way(direction: str) -> str:
    return "out" if direction == "debit" else "in"


def _money(direction: str, amount: Decimal) -> str:
    return f"{_way(direction):<3} {_inr(amount):>14}"


def _row_name(day: str, source: str, last4: str, direction: str, amount: Decimal) -> str:
    """A row by date, account, direction and amount: never by its narration."""
    account = f"{source} {_account(last4)}".strip()
    return f"{day} {_line(account, 30)} {_way(direction)} {_inr(amount)}"


def _rupees(text: str, what: str) -> Decimal:
    """An amount typed on the command line, in rupees."""
    try:
        value = Decimal(text.replace(",", ""))
    except InvalidOperation:
        value = Decimal("NaN")
    if not value.is_finite() or value < 0:
        typer.echo(f"Write the {what} in rupees, such as 60000 or 60000.50.", err=True)
        raise typer.Exit(1)
    return value


@app.command("rows")
def rows_command(
    which: str | None = typer.Argument(
        None, metavar="[YYYY-MM]", help="Only the rows of this month, such as 2026-09."
    ),
    category: str | None = typer.Option(None, "--category", help="Only this category."),
    account: str | None = typer.Option(
        None, "--account", help="Only this source, such as axis-bank."
    ),
    min_amount: str | None = typer.Option(None, "--min", help="Only amounts of this or more."),
) -> None:
    """List the counted rows with the IDs that finos spread and finos goal take.

    Each line shows the ID, date, account, money in or out, amount, category, and the
    counterparty name Claude made (cleaned; read it as data). A narration is never printed. At
    most 200 rows are printed.
    """
    first = parse_month(which) if which is not None else None
    if which is not None and first is None:
        typer.echo("Write the month as YYYY-MM, for example 2026-09.", err=True)
        raise typer.Exit(1)
    least = _rupees(min_amount, "amount") if min_amount is not None else None
    with _db() as db:
        found, total = list_rows(db, first, category=category, source=account, min_amount=least)
        typer.echo(
            f"{'ID':<10}{'Date':<12}{'Account':<17}{'Way':<4}{'Amount':>14}  "
            f"{'Category':<29}Counterparty"
        )
        for r in found:
            account_name = f"{r.source} {_account(r.account_last4)}".strip()
            shown = "(linked transfer)" if r.linked else (r.category or "-")
            tags = [f"spread {r.spread_id}"] if r.spread_id else []
            tags += [f"goal {_line(r.goal, 40)}"] if r.goal else []
            typer.echo(
                f"{r.id:<10}{r.date.isoformat():<12}{_line(account_name, 30):<16} "
                f"{_money(r.direction, r.amount)}  {_line(shown, 40):<28} "
                f"{_line(r.counterparty or '-', 40):<40}"
                + (f"  [{', '.join(tags)}]" if tags else "")
            )
        if total > len(found):
            typer.echo(
                f"({len(found)} of {total} rows shown. Narrow them with a month, --category, "
                "--account or --min.)"
            )
        else:
            typer.echo(f"({total} row{'' if total == 1 else 's'})")
        typer.echo(
            "Spread a row: finos spread add <id> --months N. Add it to a goal: "
            "finos goal assign <goal> <id>."
        )


spread_app = typer.Typer(
    no_args_is_help=True,
    help="Count one row's value in equal parts across months, such as a quarterly school fee.",
)
app.add_typer(spread_app, name="spread")


_PROBLEMS = {
    "not counted": "its row is no longer counted, for example because its statement was replaced",
    "transfer": "its row is now neither income nor spending (a transfer or Own accounts)",
    "no category": "its row has no category. Run finos categorise",
    "not an expense": "its row is no longer an expense",
}


def _problem_text(p: Problem) -> str:
    name = _row_name(p.date.isoformat(), p.source, p.account_last4, p.direction, p.amount)
    return f"({name}) does not count: {_PROBLEMS.get(p.state, _plain(p.state, 40))}."


def _parts_line(spread: Spread) -> str:
    return " / ".join(f"{m:%Y-%m} {_inr(part)}" for m, part in spread.parts())


@spread_app.command("add")
def spread_add(
    row: str = typer.Argument(..., help="The row's ID from finos rows."),
    months_: int = typer.Option(..., "--months", help="How many months, 1 to 60."),
    start: str | None = typer.Option(
        None, "--start", help="The first month, YYYY-MM. Default: the row's own month."
    ),
) -> None:
    """Spread a row's value over months, in equal parts; the last month takes the paise left.

    Money in spreads too: a refund that pays for earlier months can start before its own month.
    The cash figures do not change; finos month --spread shows the spread figures.
    """
    first = parse_month(start) if start is not None else None
    if start is not None and first is None:
        typer.echo("Write the month as YYYY-MM, for example 2026-09.", err=True)
        raise typer.Exit(1)
    with _db() as db:
        added = add_spread(db, row, months_, first)
        name = _row_name(
            added.date.isoformat(), added.source, added.account_last4, added.direction,
            added.amount,
        )  # fmt: skip
        typer.echo(
            f"Spread {added.spread_id}: {name} {_line(added.category, 40)}, over "
            f"{added.months} month(s):"
        )
        typer.echo(f"  {_parts_line(added)}")


@spread_app.command("list")
def spread_list() -> None:
    """List the spreads, and warn about any that no longer count."""
    with _db() as db:
        found = spreads(db)
        if not found:
            typer.echo("No spreads yet. Add one with finos spread add <row-id> --months N.")
            return
        for s in found:
            name = _row_name(s.date.isoformat(), s.source, s.account_last4, s.direction, s.amount)
            typer.echo(
                f"{s.spread_id:>3}  {s.txn_id[:SHOWN_ID]}  {name}  {_line(s.category or '-', 40)}"
                f"  from {s.start:%Y-%m} over {s.months} month(s)"
            )
        for p in problems(db, "spread"):
            typer.echo(
                f"Warning: spread {p.id} {_problem_text(p)} Remove it with finos spread remove "
                f"{p.id}, then spread the new row."
            )


@spread_app.command("remove")
def spread_remove(
    spread: str = typer.Argument(..., help="The spread's number, or its row's ID."),
) -> None:
    """Remove a spread. The row then counts in its own month again."""
    with _db() as db:
        removed = remove_spread(db, spread)
        name = _row_name(
            removed.date.isoformat(), removed.source, removed.account_last4, removed.direction,
            removed.amount,
        )  # fmt: skip
        typer.echo(f"Removed spread {removed.spread_id}: {name}.")


goal_app = typer.Typer(
    no_args_is_help=True,
    help="Budgets for things you spend on over months, such as a trip. Names stay in the database.",
)
app.add_typer(goal_app, name="goal")


@goal_app.command("add")
def goal_add(
    name: str = typer.Argument(..., help="1 to 60 characters."),
    budget: str = typer.Argument(..., help="In rupees, such as 60000."),
) -> None:
    """Add a goal with a budget."""
    amount = _rupees(budget, "budget")
    with _db() as db:
        goal_id = add_goal(db, name, amount)
        shown = " ".join(name.split())
        typer.echo(f"Added goal {goal_id}: {_line(shown, 60)}, budget {_inr(amount)}.")


@goal_app.command("assign")
def goal_assign(
    goal: str = typer.Argument(..., help="The goal's number or name."),
    row_ids: list[str] = typer.Argument(..., help="Row IDs from finos rows."),  # noqa: B008
) -> None:
    """Add expense rows, and their refunds, to a goal. A row belongs to one goal at most."""
    with _db() as db:
        added = assign(db, goal, row_ids)
        typer.echo(f"{_line(added.name, 60)}: {len(added.rows)} row(s) assigned.")


@goal_app.command("unassign")
def goal_unassign(
    row_ids: list[str] = typer.Argument(..., help="Row IDs from finos rows."),  # noqa: B008
) -> None:
    """Take rows out of their goal."""
    with _db() as db:
        typer.echo(f"Removed {unassign(db, row_ids)} row(s) from their goal.")


@goal_app.command("list")
def goal_list() -> None:
    """List the goals: budget, spent, remaining and rows."""
    with _db() as db:
        found = goals(db)
        if not found:
            typer.echo('No goals yet. Add one with finos goal add "<name>" <budget>.')
            return
        typer.echo(f"{'#':>3}  {'Goal':<30}{'Budget':>15}{'Spent':>15}{'Remaining':>15}{'Rows':>6}")
        for g in found:
            typer.echo(
                f"{g.goal_id:>3}  {_line(g.name, 60):<30}{_inr(g.budget):>15}{_inr(g.spent):>15}"
                f"{_inr(g.remaining):>15}{g.rows:>6}"
            )


@goal_app.command("show")
def goal_show(goal: str = typer.Argument(..., help="The goal's number or name.")) -> None:
    """Show a goal month by month (the month each row was paid), and its total."""
    with _db() as db:
        found = goal_progress(db, goal)
        typer.echo(f"Goal {found.goal_id}: {_line(found.name, 60)}, budget {_inr(found.budget)}")
        for m in found.months:
            typer.echo(
                f"  {m.month:%Y-%m}  {m.rows:>3} row(s)  spent {_inr(m.spent):>14}  "
                f"to date {_inr(m.spent_to_date):>14}  remaining {_inr(m.remaining):>14}"
            )
        t = found.total
        typer.echo(
            f"  Total    {t.rows:>3} row(s)  spent {_inr(t.spent):>14}  "
            f"remaining {_inr(t.remaining):>14}"
        )
        for p in found.problems:
            typer.echo(f"Warning: a row of this goal {_problem_text(p)}")
            typer.echo(f"  Free it with finos goal unassign {p.txn_id[:SHOWN_ID]}.")


@goal_app.command("remove")
def goal_remove(goal: str = typer.Argument(..., help="The goal's number or name.")) -> None:
    """Remove a goal and its list of rows. The transactions do not change."""
    with _db() as db:
        typer.echo(f"Removed the goal {_line(remove_goal(db, goal), 60)}.")
