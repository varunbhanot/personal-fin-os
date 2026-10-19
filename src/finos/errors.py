"""Errors finos reports to the user.

Messages say what went wrong and what to do about it. They never contain a secret value.
"""

import re


class FinosError(Exception):
    """Base class for every error finos reports instead of a traceback."""


class ConfigError(FinosError):
    """A FINOS_* setting is missing or malformed."""


class SecretsError(FinosError):
    """Secrets could not be fetched from Doppler, or one is missing."""


class DbError(FinosError):
    """The database rejected a query or could not be reached."""


class DriveError(FinosError):
    """The statements folder in Google Drive could not be listed or read."""


class WrongPassword(FinosError):
    """None of the statement passwords opens a PDF."""


class BadPdf(FinosError):
    """A file is not a readable PDF."""


class UnknownSource(FinosError):
    """A statement matches no source profile, or more than one."""


class AiError(FinosError):
    """The Claude API refused or failed a request."""


class BudgetExceeded(FinosError):
    """This month's AI spend has reached FINOS_AI_BUDGET_USD."""


def proxy_refused(host: str, error: Exception) -> str:
    """The message for a request the session's network proxy would not pass.

    With Custom network access, the proxy passes only allowed domains and hosts that have a
    network secret, so a lasting refusal almost always means one of those is missing or
    misspelled. The proxy also fails brief outages this way, so the status is shown too.
    """
    # httpcore words a failed CONNECT as "<status> <reason>". Only the digits are kept: the
    # rest of an exception's text could carry the proxy's own credentials.
    status = re.match(r"\d{3}\b", str(error))
    shown = f" (proxy status {status.group()})" if status else ""
    return (
        f"The session's network proxy did not pass the connection to {host}{shown}. If this "
        f"repeats, check in the cloud environment that {host} has a network secret or is an "
        "allowed domain, spelled exactly like this. A new session picks up the change."
    )
