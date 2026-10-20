"""The finos command line.

Every command reads its non-secret settings from FINOS_* variables. Secrets come from Doppler
into memory, and requests to Neon and Doppler carry no credential of their own: the cloud
environment's network secrets add them. No command ever prints a secret value.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager

import httpx
import typer

from finos.ai import Claude
from finos.categorise import Result as Categorised
from finos.categorise import accept as accept_counterparties
from finos.categorise import add_note, group_rows, load_categories, plan, remove_note
from finos.categorise import categorise as run_categorise
from finos.categorise import correct as correct_counterparty
from finos.categorise import notes as list_notes
from finos.categorise import review as review_queue
from finos.config import Settings, load_settings
from finos.db import NeonHttpDb
from finos.errors import FinosError
from finos.identify import load_profiles
from finos.inbox import Drive, no_auth, service_account_auth
from finos.migrate import migrate
from finos.report import status as load_status
from finos.secrets import Secrets, load_secrets
from finos.store import forget_flagged
from finos.sync import FileResult, Identified, identify_files
from finos.sync import sync as run_sync
from finos.transfers import add_handle, find, handles, load, rebuild, remove_handle

app = typer.Typer(
    no_args_is_help=True,
    help=(
        "Statement pipeline: check, identify, sync, status, transfers, accounts, and the "
        "categories (categorise, review, correct, accept, notes)."
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

    Name the counterparty by its ID from finos review (or by its name).
    """
    ways = {"in": "credit", "out": "debit", None: None}
    if direction not in ways:
        typer.echo("--direction must be 'in' or 'out'.", err=True)
        raise typer.Exit(1)
    with _db() as db:
        result = correct_counterparty(
            db, load_categories(), counterparty, category, once=once, direction=ways[direction]
        )
        counted = (
            "Counted as a correction."
            if result.counted
            else "It already had that category, so it is not counted as a correction."
        )
        typer.echo(
            f"{_plain(result.counterparty, 40)}: {result.rows} row(s) now {result.category}. "
            f"{counted}"
        )


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
