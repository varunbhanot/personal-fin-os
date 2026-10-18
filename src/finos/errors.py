"""Errors finos reports to the user.

Messages say what went wrong and what to do about it. They never contain a secret value.
"""


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
