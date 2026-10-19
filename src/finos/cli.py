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

app = typer.Typer(
    no_args_is_help=True,
    help="Statement pipeline: check, identify, sync and status.",
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
            expected = {"ANTHROPIC_KEY"} | {p.password_secret for p in load_profiles()}
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
            typer.echo(f"{line}\n              {_plain(result.detail)}" if result.detail else line)

        results = identify_files(
            drive=_drive(settings, http, secrets),
            secrets=secrets,
            profiles=load_profiles(),
            on_result=show,
        )
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

        results = run_sync(
            drive=_drive(settings, http, secrets),
            db=db,
            claude=claude,
            secrets=secrets,
            profiles=load_profiles(),
            model=settings.model_extract,
            on_result=show,
        )
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
        report = load_status(db)
        if not report.statements:
            typer.echo("No statements yet. Run finos sync.")
        for line in report.statements:
            typer.echo(
                f"{line.month}  {line.source:<14} *{_plain(line.account_last4, 4):<4}  "
                f"{line.status:<8}"
                f"{line.transactions:>4} transactions"
            )
            for problem in line.problems:
                typer.echo(f"          {_plain(problem)}")
        typer.echo(
            f"\nAI spend: ${report.spent_this_month} this month, ${report.spent_total} in total"
        )
