"""finos sync: every new PDF in the Drive folder becomes a checked statement in the database.

Each file is handled on its own and gets one outcome, reported as soon as it is known. A
failure, expected or not, is reported and the run moves on; nothing is stored for a failed
file, so the next run tries it again. Reaching the AI budget stops the run. A file whose
content was already imported under another Drive name is recognised without calling Claude.
"""

import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from finos.db import NeonHttpDb
from finos.errors import BudgetExceeded, FinosError
from finos.extract import StructuredClaude, extract
from finos.identify import SourceProfile, identify
from finos.inbox import Drive, DriveFile
from finos.models import SourceFile
from finos.pdftext import page_texts
from finos.secrets import Secrets
from finos.store import is_known_content, is_known_file, record_file, store_statement
from finos.unlock import unlock

Outcome = Literal["imported", "replaced", "unchanged", "flagged", "failed", "skipped"]

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FileResult:
    name: str
    outcome: Outcome
    detail: str = ""


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
    passwords = {name: secrets.get(name) for name in secrets.with_prefix("PW_")}
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


def _sync_file(
    file: DriveFile,
    drive: Drive,
    db: NeonHttpDb,
    claude: StructuredClaude,
    passwords: dict,
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

    unlocked = unlock(content, passwords, name=file.name)
    texts = page_texts(unlocked.pdf)
    if not any(texts):
        return FileResult(
            file.name,
            "failed",
            "This PDF has no text layer (a scanned image?), so its figures cannot be checked.",
        )
    profile = identify("\n".join(texts), profiles)

    result = extract(claude, model=model, pdf=unlocked.pdf, profile=profile, page_texts=texts)
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
