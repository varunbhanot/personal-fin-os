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
    password_secret: str  # the Doppler secret holding this source's statement password
    hints: str  # layout notes for the extraction prompt
    date_formats: tuple[str, ...] = DEFAULT_DATE_FORMATS
    period_slack_days: int = 0  # how far a transaction date may fall outside the period


def load_profiles(folder: Path | Traversable | None = None) -> list[SourceProfile]:
    folder = folder or resources.files("finos") / "sources"
    files = sorted((f for f in folder.iterdir() if f.name.endswith(".yaml")), key=lambda f: f.name)
    return [_profile(f.name, f.read_text()) for f in files]


def identify(text: str, profiles: list[SourceProfile]) -> SourceProfile:
    haystack = text.casefold()
    matches = [p for p in profiles if all(m.casefold() in haystack for m in p.markers)]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise UnknownSource(
            "This statement matches no source profile. If it is from a new bank or card, it "
            "needs a profile in src/finos/sources."
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
    try:
        slack = int(data.get("period_slack_days", 0))
    except (TypeError, ValueError):
        raise ConfigError(
            f"Source profile {filename}: period_slack_days must be a number"
        ) from None

    return SourceProfile(
        id=str(require("id")),
        kind=kind,
        markers=tuple(markers),
        password_secret=str(require("password_secret")),
        hints=str(require("hints")).strip(),
        date_formats=tuple(str(f) for f in date_formats),
        period_slack_days=slack,
    )
