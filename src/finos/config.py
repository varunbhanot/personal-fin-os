"""Non-secret settings, read from FINOS_* environment variables.

Secrets never come from here: see secrets.py. Anything in the cloud environment's
variables can be read by every session that uses it, so only hosts, IDs and limits live there.
"""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from finos.errors import ConfigError

DEFAULT_MODEL = "claude-opus-5-5"
# ep-<name>[.c-<cell>].<region>.<cloud>.neon.tech, and nothing that could steer the SQL URL
# elsewhere. Newer Neon projects carry the cell label.
_NEON_ENDPOINT = re.compile(r"^ep-[a-z0-9-]+(\.c-[0-9]+)?\.[a-z0-9-]+\.[a-z0-9-]+\.neon\.tech$")
DOPPLER_DOWNLOAD_URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json"

REQUIRED = {
    "FINOS_NEON_HOST": (
        "the host in the Neon connection string, "
        "e.g. ep-quiet-sky-123456.c-2.<region>.aws.neon.tech"
    ),
    "FINOS_DRIVE_FOLDER_ID": "the ID of the Google Drive folder holding statement PDFs",
}


@dataclass(frozen=True)
class Settings:
    neon_host: str
    drive_folder_id: str
    ai_budget_usd: Decimal = Decimal("10")
    model_extract: str = DEFAULT_MODEL
    model_categorise: str = DEFAULT_MODEL
    # An unsure category for a payment of at least this many rupees waits in finos review.
    review_min_inr: Decimal = Decimal("10000")
    doppler_url: str = DOPPLER_DOWNLOAD_URL

    @property
    def neon_sql_url(self) -> str:
        # Neon's own driver sends SQL over HTTPS to the endpoint host with its first label
        # replaced by "api". The network secret for that host carries the credential.
        _, _, region_domain = self.neon_host.partition(".")
        return f"https://api.{region_domain}/sql"


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    missing = [name for name in REQUIRED if not env.get(name, "").strip()]
    if missing:
        lines = [f"  {name}: {REQUIRED[name]}" for name in missing]
        raise ConfigError(
            "Missing settings. Add them as environment variables on the cloud environment:\n"
            + "\n".join(lines)
        )

    return Settings(
        neon_host=_neon_host(env["FINOS_NEON_HOST"].strip()),
        drive_folder_id=env["FINOS_DRIVE_FOLDER_ID"].strip(),
        ai_budget_usd=_budget(env.get("FINOS_AI_BUDGET_USD", "10")),
        model_extract=env.get("FINOS_MODEL_EXTRACT", "").strip() or DEFAULT_MODEL,
        model_categorise=env.get("FINOS_MODEL_CATEGORISE", "").strip() or DEFAULT_MODEL,
        review_min_inr=_rupees(env.get("FINOS_REVIEW_MIN_INR", "10000")),
    )


def _neon_host(value: str) -> str:
    # A connection string here would put the database password where every session can read it.
    if "@" in value or "://" in value:
        raise ConfigError(
            "FINOS_NEON_HOST looks like a connection string. Remove it from the environment "
            "variables now: the connection string belongs only in the network secret. "
            "FINOS_NEON_HOST is just the host, e.g. ep-quiet-sky-123456.c-2.<region>.aws.neon.tech"
        )
    if not _NEON_ENDPOINT.fullmatch(value):
        raise ConfigError(
            "FINOS_NEON_HOST should be a Neon endpoint host such as "
            "ep-quiet-sky-123456.c-2.<region>.aws.neon.tech"
        )
    return value


def _rupees(value: str) -> Decimal:
    try:
        amount = Decimal(value.strip())
    except InvalidOperation:
        raise ConfigError("FINOS_REVIEW_MIN_INR must be a number of rupees, e.g. 10000") from None
    if not amount.is_finite() or amount < 0:
        raise ConfigError("FINOS_REVIEW_MIN_INR must be 0 or more")
    return amount


def _budget(value: str) -> Decimal:
    try:
        budget = Decimal(value.strip())
    except InvalidOperation:
        raise ConfigError("FINOS_AI_BUDGET_USD must be a number of US dollars, e.g. 10") from None
    if not budget.is_finite() or budget <= 0:
        raise ConfigError("FINOS_AI_BUDGET_USD must be more than 0")
    return budget
