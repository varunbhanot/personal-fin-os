"""Calls to Claude for structured answers, with spend tracking and a monthly budget.

The API key comes from Doppler at run time and goes straight to the SDK. The base URL is
pinned because cloud sessions set ANTHROPIC_BASE_URL for Claude Code's own traffic.
Calls carry no tools, so text inside a statement cannot make anything run.
"""

import json
import logging
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import anthropic
import httpx2

from finos.db import NeonHttpDb
from finos.errors import AiError, BudgetExceeded
from finos.secrets import Secret

API_URL = "https://api.anthropic.com"
FALLBACK_BETA = "server-side-fallback-2026-07-01"

log = logging.getLogger(__name__)

# USD per million tokens: input, output, cache write (5 minute), cache read.
PRICES: dict[str, tuple[Decimal, Decimal, Decimal, Decimal]] = {
    "claude-opus-5-5": (Decimal("4"), Decimal("20"), Decimal("5"), Decimal("0.20")),
    "claude-opus-5": (Decimal("5"), Decimal("25"), Decimal("6.25"), Decimal("0.50")),
    "claude-opus-4-8": (Decimal("5"), Decimal("25"), Decimal("6.25"), Decimal("0.50")),
    "claude-sonnet-5-5": (Decimal("2"), Decimal("10"), Decimal("2.50"), Decimal("0.20")),
    "claude-sonnet-5": (Decimal("2"), Decimal("10"), Decimal("2.50"), Decimal("0.20")),
    "claude-haiku-5-5": (Decimal("0.10"), Decimal("0.50"), Decimal("0.125"), Decimal("0.01")),
}
_MOST_EXPENSIVE = max(PRICES.values(), key=lambda p: p[1])
_SNAPSHOT_DATE = re.compile(r"-\d{8}$")


@dataclass(frozen=True)
class StructuredReply:
    data: dict[str, Any]
    model: str
    cost_usd: Decimal


def cost_usd(model: str, usage: Any) -> Decimal:
    model = _SNAPSHOT_DATE.sub("", model)  # claude-opus-5-5-20261001 costs as claude-opus-5-5
    if model not in PRICES:
        log.warning("No price known for %s; costing it at the most expensive known rate", model)
    price_in, price_out, price_write, price_read = PRICES.get(model, _MOST_EXPENSIVE)
    total = (
        _tokens(usage, "input_tokens") * price_in
        + _tokens(usage, "output_tokens") * price_out
        + _tokens(usage, "cache_creation_input_tokens") * price_write
        + _tokens(usage, "cache_read_input_tokens") * price_read
    )
    return (total / Decimal(1_000_000)).quantize(Decimal("0.0001"))


class Claude:
    def __init__(self, messages_api: Any, db: NeonHttpDb, *, budget_usd: Decimal) -> None:
        self.messages = messages_api
        self.db = db
        self.budget_usd = budget_usd
        self.client: anthropic.Anthropic | None = None

    @classmethod
    def from_key(cls, key: Secret, db: NeonHttpDb, *, budget_usd: Decimal) -> "Claude":
        client = anthropic.Anthropic(api_key=key.reveal(), base_url=API_URL, max_retries=3)
        claude = cls(client.beta.messages, db, budget_usd=budget_usd)
        claude.client = client
        return claude

    def __repr__(self) -> str:
        return f"Claude(budget_usd={self.budget_usd})"

    def spent_this_month(self) -> Decimal:
        rows = self.db.execute(
            "select coalesce(sum(cost_usd), 0) as spent from ai_usage "
            "where at >= date_trunc('month', now())"
        )
        return Decimal(rows[0]["spent"])

    def structured(
        self,
        *,
        purpose: str,
        model: str,
        system: str,
        content: list[dict[str, Any]],
        schema: dict[str, Any],
        effort: str = "medium",
        max_tokens: int = 64000,
    ) -> StructuredReply:
        """Ask for an answer matching a JSON schema. No tools are offered."""
        spent = self.spent_this_month()
        if spent >= self.budget_usd:
            raise BudgetExceeded(
                f"AI spend this month is ${spent}, at the FINOS_AI_BUDGET_USD limit of "
                f"${self.budget_usd}. Raise the limit or wait for next month."
            )

        try:
            with self.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": content}],
                output_config={
                    "effort": effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                betas=[FALLBACK_BETA],
                fallbacks="default",
            ) as stream:
                message = stream.get_final_message()
        except anthropic.APIStatusError as error:
            raise AiError(_status_message(error)) from None
        except (anthropic.APIConnectionError, httpx2.HTTPError):
            # httpx2 errors arrive when a streamed reply breaks off part way. The tokens
            # streamed before the break are not reported, so they are not in ai_usage.
            raise AiError("The connection to the Claude API dropped; try again shortly") from None

        served_by = getattr(message, "model", None) or model
        cost = cost_usd(served_by, message.usage)
        self._record(purpose, served_by, message.usage, cost)

        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            category = getattr(details, "category", None) or "unspecified"
            raise AiError(f"Claude declined the {purpose} request (category: {category})")
        if message.stop_reason == "max_tokens":
            raise AiError(f"Claude's {purpose} reply was cut off at {max_tokens} tokens")

        text = next((b.text for b in message.content if getattr(b, "type", "") == "text"), "")
        try:
            data = json.loads(text)
        except ValueError:
            raise AiError(f"Claude's {purpose} reply was not valid JSON") from None
        if not isinstance(data, dict):
            raise AiError(f"Claude's {purpose} reply was not a JSON object")
        return StructuredReply(data=data, model=served_by, cost_usd=cost)

    def _record(self, purpose: str, model: str, usage: Any, cost: Decimal) -> None:
        self.db.execute(
            "insert into ai_usage (purpose, model, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens, cost_usd) values (%s, %s, %s, %s, %s, %s, %s)",
            [
                purpose,
                model,
                _tokens(usage, "input_tokens"),
                _tokens(usage, "output_tokens"),
                _tokens(usage, "cache_read_input_tokens"),
                _tokens(usage, "cache_creation_input_tokens"),
                cost,
            ],
        )


def _tokens(usage: Any, field: str) -> int:
    return int(getattr(usage, field, 0) or 0)


def _status_message(error: anthropic.APIStatusError) -> str:
    if isinstance(error, anthropic.AuthenticationError | anthropic.PermissionDeniedError):
        return (
            f"The Claude API refused the key (HTTP {error.status_code}). Check ANTHROPIC_KEY in "
            "Doppler: it may have been revoked, or its workspace may have hit its spend limit."
        )
    if isinstance(error, anthropic.RateLimitError):
        return "The Claude API rate limit was reached; try again in a few minutes"
    if isinstance(error, anthropic.BadRequestError):
        return f"The Claude API rejected the request: {error.message}"
    return f"The Claude API returned HTTP {error.status_code}; try again shortly"
