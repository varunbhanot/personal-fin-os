"""finos sync: every new PDF in the Drive folder becomes a checked statement in the database.

Each file is handled on its own and gets one outcome, reported as soon as it is known. A
failure, expected or not, is reported and the run moves on; nothing is stored for a failed
file, so the next run tries it again. Reaching the AI budget stops the run. A file whose
content was already imported under another Drive name is recognised without calling Claude.

finos identify runs the same first steps (unlock, read the text layer, match a profile) on
every file, without Claude or the database, so a profile's markers can be checked for free.
"""

import hashlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal

from finos.db import NeonHttpDb
from finos.errors import BadPdf, BudgetExceeded, FinosError
from finos.extract import StructuredClaude, extract
from finos.identify import SourceProfile, identify
from finos.inbox import Drive, DriveFile
from finos.models import SourceFile
from finos.pdftext import page_texts
from finos.secrets import Secret, Secrets
from finos.store import is_known_content, is_known_file, record_file, store_statement
from finos.unlock import unlock

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
    unlocked = unlock(content, passwords, name=name)
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
    passwords = _passwords(secrets)
    results: list[Identified] = []
    for file in drive.list_pdfs():
        try:
            opened = open_statement(drive.download(file), passwords, profiles, name=file.name)
            result = Identified(file.name, opened.profile.id)
        except FinosError as error:
            result = Identified(file.name, None, str(error))
        except Exception as error:  # one bad file must not hide the others
            log.debug("unexpected error on %s", file.name, exc_info=True)
            result = Identified(file.name, None, f"Unexpected {type(error).__name__}")
        results.append(result)
        on_result(result)
    return results


def sync(
    *,
    drive: Drive,
    db: NeonHttpDb,
    claude: StructuredClaude,
    secrets: Secrets,
    profiles: list[SourceProfile],
    model: str,
    on_result: Callable[[FileResult], None] = lambda result: None,
) -> list[FileResult]:
    passwords = _passwords(secrets)
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
    return results


def _passwords(secrets: Secrets) -> dict[str, Secret]:
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
