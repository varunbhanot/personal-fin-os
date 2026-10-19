"""Opens password-protected statements in memory. Nothing unlocked is written to disk."""

import io
from collections.abc import Mapping
from dataclasses import dataclass

import pikepdf

from finos.errors import BadPdf, WrongPassword
from finos.secrets import Secret


@dataclass(frozen=True)
class Unlocked:
    pdf: bytes  # the same document, without encryption
    password_name: str | None  # which Doppler secret opened it; None if it had no password


def unlock(pdf: bytes, passwords: Mapping[str, Secret], *, name: str) -> Unlocked:
    """Open the PDF with no password, or with whichever of the passwords works."""
    attempts: list[tuple[str | None, str]] = [(None, "")]
    attempts += [(key, passwords[key].reveal()) for key in sorted(passwords)]

    for key, password in attempts:
        try:
            with pikepdf.open(io.BytesIO(pdf), password=password) as document:
                out = io.BytesIO()
                document.save(out)  # saved without encryption
                return Unlocked(pdf=out.getvalue(), password_name=key)
        except pikepdf.PasswordError:
            continue
        except pikepdf.PdfError as error:
            raise BadPdf(f"{name} is not a readable PDF: {type(error).__name__}") from None

    raise WrongPassword(
        f"None of the {len(passwords)} statement passwords in Doppler opens {name}. "
        "Check the password for this bank or card in Doppler (PW_* secrets)."
    )
