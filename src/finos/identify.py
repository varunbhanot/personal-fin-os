"""Works out which bank or card a statement comes from, using the profiles in finos/sources."""

from dataclasses import dataclass
from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import get_args

import yaml

from finos.errors import ConfigError, UnknownSource
from finos.models import StatementKind

DEFAULT_DATE_FORMATS = (
    "%d/%m/%Y",
    "%d/%m/%y",
    "%d-%m-%Y",
    "%d-%m-%y",
    "%d %b %Y",
    "%d-%b-%Y",
    "%d-%b-%y",
    "%d %b %y",
    "%d %B %Y",
    "%d.%m.%Y",
    "%Y-%m-%d",
)


@dataclass(frozen=True)
class SourceProfile:
    id: str
    kind: StatementKind
    markers: tuple[str, ...]  # text that appears on every statement from this source
    # The Doppler secret holding this source's statement password; None if its PDFs have none.
    password_secret: str | None
    hints: str  # layout notes for the extraction prompt
    date_formats: tuple[str, ...] = DEFAULT_DATE_FORMATS
    period_slack_days: int = 0  # how far a transaction date may fall outside the period
    closing_rounded_to_rupee: bool = False  # the closing is printed rounded to the nearest rupee
    account_digits: int = 4  # how many trailing digits of the account number are printed


def load_profiles(folder: Path | Traversable | None = None) -> list[SourceProfile]:
    folder = folder or resources.files("finos") / "sources"
    files = sorted((f for f in folder.iterdir() if f.name.endswith(".yaml")), key=lambda f: f.name)
    return [_profile(f.name, f.read_text()) for f in files]


def _folded(text: str) -> str:
    # Summary labels often wrap across lines in the text layer.
    return " ".join(text.casefold().split())


def identify(text: str, profiles: list[SourceProfile]) -> SourceProfile:
    haystack = _folded(text)
    matches = [p for p in profiles if all(_folded(m) in haystack for m in p.markers)]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        # Only the profiles' own marker text is named: statement text stays out of the output.
        missing = "; ".join(
            f"{p.id}: " + ", ".join(f'"{m}"' for m in p.markers if _folded(m) not in haystack)
            for p in profiles
        )
        raise UnknownSource(
            "This statement matches no source profile. If it is from a new bank or card, it "
            f"needs a profile in src/finos/sources. Missing markers: {missing}."
        )
    names = ", ".join(sorted(p.id for p in matches))
    raise UnknownSource(f"This statement matches more than one source profile: {names}")


def _profile(filename: str, text: str) -> SourceProfile:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise ConfigError(f"Source profile {filename} is not valid YAML: {error}") from None
    if not isinstance(data, dict):
        raise ConfigError(f"Source profile {filename} must be a mapping of settings")

    def require(key: str) -> object:
        if not data.get(key):
            raise ConfigError(f"Source profile {filename} needs a value for {key}")
        return data[key]

    kind = require("kind")
    if kind not in get_args(StatementKind):
        raise ConfigError(f"Source profile {filename}: kind must be card, bank or loan")
    markers = require("markers")
    if not isinstance(markers, list) or not all(isinstance(m, str) and m for m in markers):
        raise ConfigError(f"Source profile {filename}: markers must be a list of text")
    date_formats = data.get("date_formats") or list(DEFAULT_DATE_FORMATS)
    # extra_date_formats adds to the list; date_formats replaces it.
    extra = data.get("extra_date_formats") or []
    if not isinstance(extra, list) or not all(isinstance(f, str) and f for f in extra):
        raise ConfigError(
            f"Source profile {filename}: extra_date_formats must be a list of date formats"
        )
    try:
        slack = int(data.get("period_slack_days", 0))
    except (TypeError, ValueError):
        raise ConfigError(
            f"Source profile {filename}: period_slack_days must be a number"
        ) from None
    rounded = data.get("closing_rounded_to_rupee", False)
    if not isinstance(rounded, bool):
        raise ConfigError(
            f"Source profile {filename}: closing_rounded_to_rupee must be true or false"
        )

    # Leaving the key out means the PDFs have no password; a blank value is a mistake.
    secret = data.get("password_secret")
    if "password_secret" in data and not (isinstance(secret, str) and secret.strip()):
        raise ConfigError(
            f"Source profile {filename}: password_secret must be the name of a Doppler secret"
        )

    # Some issuers mask all but the last two digits, or every digit.
    digits = data.get("account_digits", 4)
    if isinstance(digits, bool) or not isinstance(digits, int) or not 0 <= digits <= 4:
        raise ConfigError(
            f"Source profile {filename}: account_digits must be a whole number from 0 to 4"
        )

    return SourceProfile(
        id=str(require("id")),
        kind=kind,
        markers=tuple(markers),
        password_secret=secret,
        hints=str(require("hints")).strip(),
        date_formats=tuple(str(f) for f in [*date_formats, *extra]),
        period_slack_days=slack,
        closing_rounded_to_rupee=rounded,
        account_digits=digits,
    )
