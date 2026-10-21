"""finos sync: every new PDF in the Drive folder becomes a checked statement in the database.

Each file is handled on its own and gets one outcome, reported as soon as it is known. A
failure, expected or not, is reported and the run moves on; nothing is stored for a failed
file, so the next run tries it again. Reaching the AI budget stops the run. A file whose
content was already imported under another Drive name is recognised without calling Claude.
When a run imports or replaces a statement, the own-account transfer links are rebuilt, and
then, if asked, the new rows are categorised.

finos identify runs the same first steps (unlock, read the text layer, match a profile) on
every file, without Claude or the database, so a profile's markers can be checked for free.
"""

import hashlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from finos.categorise import REVIEW_MIN, categorise, load_categories
from finos.categorise import Result as Categorised
from finos.db import NeonHttpDb
from finos.errors import BadPdf, BudgetExceeded, ConfigError, FinosError
from finos.extract import StructuredClaude, extract
from finos.identify import SourceProfile, identify
from finos.inbox import Drive, DriveFile
from finos.models import SourceFile
from finos.pdftext import page_texts
from finos.secrets import Secret, Secrets
from finos.store import is_known_content, is_known_file, record_file, store_statement
from finos.transfers import rebuild
from finos.unlock import Unlocked, unlock

Outcome = Literal["imported", "replaced", "unchanged", "flagged", "failed", "skipped"]

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FileResult:
    name: str
    outcome: Outcome
    detail: str = ""


@dataclass(frozen=True)
class Identified:
    name: str
    source: str | None  # the matched profile; None when the file could not be identified
    detail: str = ""
    # The name of the Doppler secret that opened the file, "no password", or "" if it did not
    # open. Only the name: never the value.
    opened_with: str = ""


@dataclass(frozen=True)
class Opened:
    pdf: bytes  # unlocked, in memory only
    texts: list[str]  # the text layer of each page
    profile: SourceProfile


def open_statement(
    content: bytes,
    passwords: Mapping[str, Secret],
    profiles: list[SourceProfile],
    *,
    name: str,
) -> Opened:
    return read_statement(unlock(content, passwords, name=name), profiles)


def read_statement(unlocked: Unlocked, profiles: list[SourceProfile]) -> Opened:
    """Read the text layer of an unlocked PDF and match it to its source profile."""
    texts = page_texts(unlocked.pdf)
    if not any(texts):
        raise BadPdf(
            "This PDF has no text layer (a scanned image?), so its figures cannot be checked."
        )
    profile = identify("\n".join(texts), profiles)
    return Opened(pdf=unlocked.pdf, texts=texts, profile=profile)


def identify_files(
    *,
    drive: Drive,
    secrets: Secrets,
    profiles: list[SourceProfile],
    on_result: Callable[[Identified], None] = lambda result: None,
) -> list[Identified]:
    passwords = statement_passwords(secrets)
    results: list[Identified] = []
    for file in drive.list_pdfs():
        # The same two steps as open_statement, kept apart so that a file that matches no
        # profile still shows how it opened.
        opened_with = ""
        try:
            unlocked = unlock(drive.download(file), passwords, name=file.name)
            opened_with = unlocked.password_name or "no password"
            opened = read_statement(unlocked, profiles)
            result = Identified(file.name, opened.profile.id, opened_with=opened_with)
        except FinosError as error:
            result = Identified(file.name, None, str(error), opened_with=opened_with)
        except Exception as error:  # one bad file must not hide the others
            log.debug("unexpected error on %s", file.name, exc_info=True)
            result = Identified(
                file.name, None, f"Unexpected {type(error).__name__}", opened_with=opened_with
            )
        results.append(result)
        on_result(result)
    return results


def file_lines(
    *, drive: Drive, secrets: Secrets, name: str, text: str, context: int = 1
) -> list[list[str]]:
    """The lines of one Drive PDF that contain text, each with context lines around it.

    For fixing a source profile when a check fails: the PDF's own text layer, read without
    Claude. Each group is a list of "p<page>  <line>" strings; groups that overlap are merged.
    """
    files = [f for f in drive.list_pdfs() if f.name == name]
    if not files:
        raise ConfigError(f'No PDF named "{name}" is in the statements folder.')
    unlocked = unlock(drive.download(files[0]), statement_passwords(secrets), name=name)
    lines = [
        (page, line)
        for page, page_text in enumerate(page_texts(unlocked.pdf), start=1)
        for line in page_text.splitlines()
    ]
    wanted = text.casefold()
    spans: list[list[int]] = []
    for i, (_, line) in enumerate(lines):
        if wanted in line.casefold():
            start, end = max(0, i - context), min(len(lines), i + context + 1)
            if spans and start <= spans[-1][1]:
                spans[-1][1] = end
            else:
                spans.append([start, end])
    return [[f"p{page}  {line}" for page, line in lines[start:end]] for start, end in spans]


def sync(
    *,
    drive: Drive,
    db: NeonHttpDb,
    claude: StructuredClaude,
    secrets: Secrets,
    profiles: list[SourceProfile],
    model: str,
    on_result: Callable[[FileResult], None] = lambda result: None,
    categorise_model: str | None = None,
    review_min: Decimal = REVIEW_MIN,
    on_categorised: Callable[[Categorised], None] = lambda result: None,
) -> list[FileResult]:
    """Import every new file. With categorise_model, also categorise the rows it imported."""
    passwords = statement_passwords(secrets)
    files = drive.list_pdfs()
    results: list[FileResult] = []

    def report(result: FileResult) -> None:
        results.append(result)
        log.info("%s: %s", result.name, result.outcome)
        on_result(result)

    for index, file in enumerate(files):
        try:
            report(_sync_file(file, drive, db, claude, passwords, profiles, model))
        except BudgetExceeded as error:
            report(FileResult(file.name, "failed", str(error)))
            for rest in files[index + 1 :]:
                report(FileResult(rest.name, "skipped", "AI budget reached"))
            break
        except FinosError as error:
            report(FileResult(file.name, "failed", str(error)))
        except Exception as error:  # one bad file must not lose the rest of the run
            log.debug("unexpected error on %s", file.name, exc_info=True)
            report(FileResult(file.name, "failed", f"Unexpected {type(error).__name__}"))
    if any(r.outcome in ("imported", "replaced") for r in results):
        # A replaced statement's transactions have new IDs, so links are rebuilt, not patched.
        try:
            links = rebuild(db, profiles)
        except FinosError as error:
            # The statements are stored and paid for; their results must still be reported.
            log.warning("Transfer links were not rebuilt (%s). Run finos transfers.", error)
            return results
        if categorise_model:
            # After the links, so that neither half of a transfer is sent to Claude.
            try:
                categorised = categorise(
                    db,
                    claude,
                    model=categorise_model,
                    categories=load_categories(),
                    profiles=profiles,
                    report=links,
                    review_min=review_min,
                )
            except FinosError as error:
                log.warning("Transactions were not categorised (%s). Run finos categorise.", error)
            else:
                on_categorised(categorised)
    return results


def statement_passwords(secrets: Secrets) -> dict[str, Secret]:
    """The statement passwords by secret name, held in memory only."""
    return {name: secrets.get(name) for name in secrets.with_prefix("PW_")}


def _sync_file(
    file: DriveFile,
    drive: Drive,
    db: NeonHttpDb,
    claude: StructuredClaude,
    passwords: Mapping[str, Secret],
    profiles: list[SourceProfile],
    model: str,
) -> FileResult:
    if is_known_file(db, file.id, file.md5):
        return FileResult(file.name, "unchanged")

    content = drive.download(file)
    source_file = SourceFile(
        drive_file_id=file.id,
        drive_md5=file.md5,
        name=file.name,
        sha256=hashlib.sha256(content).hexdigest(),
    )
    if is_known_content(db, source_file.sha256):
        record_file(db, source_file)
        return FileResult(file.name, "unchanged", "Same content as a file already imported.")

    opened = open_statement(content, passwords, profiles, name=file.name)
    result = extract(
        claude, model=model, pdf=opened.pdf, profile=opened.profile, page_texts=opened.texts
    )
    stored = store_statement(db, source_file, result.statement, result.extraction, result.problems)

    if stored == "kept":
        return FileResult(
            file.name,
            "flagged",
            "Kept the earlier verified statement for this period; this file failed its checks: "
            + "; ".join(result.problems),
        )
    if result.problems:
        return FileResult(file.name, "flagged", "; ".join(result.problems))
    return FileResult(file.name, stored)
