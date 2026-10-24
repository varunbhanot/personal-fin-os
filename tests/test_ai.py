import json
from decimal import Decimal
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from finos.ai import API_URL, Claude, check_budget, cost_usd, spent_this_month
from finos.errors import AiError, BudgetExceeded
from finos.secrets import Secret

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}


def usage(input_tokens=1000, output_tokens=200, cache_read=0, cache_write=0):
    return SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_input_tokens=cache_read,
        cache_creation_input_tokens=cache_write,
    )


def message(text='{"ok": true}', stop_reason="end_turn", model="claude-opus-5-5", **extra):
    blocks = [
        SimpleNamespace(type="thinking", thinking=""),
        SimpleNamespace(type="text", text=text),
    ]
    return SimpleNamespace(
        content=blocks, stop_reason=stop_reason, model=model, usage=usage(), **extra
    )


class FakeStream:
    def __init__(self, reply):
        self.reply = reply

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


class FakeMessages:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return FakeStream(self.replies.pop(0))


def ask(claude, **overrides):
    args = {
        "purpose": "extract",
        "model": "claude-opus-5-5",
        "system": "You read statements.",
        "content": [{"type": "text", "text": "hello"}],
        "schema": SCHEMA,
    }
    return claude.structured(**(args | overrides))


def test_returns_the_parsed_json_and_sends_the_expected_request(migrated_db):
    api = FakeMessages(message())
    claude = Claude(api, migrated_db, budget_usd=Decimal("10"))

    reply = ask(claude, effort="low")

    assert reply.data == {"ok": True}
    call = api.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["system"] == "You read statements."
    assert call["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
    assert call["output_config"] == {
        "effort": "low",
        "format": {"type": "json_schema", "schema": SCHEMA},
    }
    assert call["fallbacks"] == "default"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert "tools" not in call


def test_records_usage_and_cost(migrated_db):
    claude = Claude(FakeMessages(message()), migrated_db, budget_usd=Decimal("10"))

    reply = ask(claude)

    rows = migrated_db.execute(
        "select purpose, model, input_tokens, output_tokens, cost_usd from ai_usage"
    )
    # 1000 input at $4/M + 200 output at $20/M
    assert rows == [
        {
            "purpose": "extract",
            "model": "claude-opus-5-5",
            "input_tokens": 1000,
            "output_tokens": 200,
            "cost_usd": Decimal("0.0080"),
        }
    ]
    assert reply.cost_usd == Decimal("0.0080")
    assert claude.spent_this_month() == Decimal("0.0080")


def test_refuses_to_call_once_the_monthly_budget_is_spent(migrated_db):
    migrated_db.execute(
        "insert into ai_usage (purpose, model, input_tokens, output_tokens, cost_usd) "
        "values ('extract', 'claude-opus-5-5', 1, 1, 10.0000)"
    )
    api = FakeMessages(message())
    claude = Claude(api, migrated_db, budget_usd=Decimal("10"))

    with pytest.raises(BudgetExceeded, match="FINOS_AI_BUDGET_USD"):
        ask(claude)
    assert api.calls == []


def test_check_budget_refuses_at_the_limit_and_passes_below_it(migrated_db):
    migrated_db.execute(
        "insert into ai_usage (at, purpose, model, input_tokens, output_tokens, cost_usd) "
        "values (now(), 'chat', 'claude-sonnet-5-5', 1, 1, 4.0000), "
        "(now() - interval '40 days', 'extract', 'claude-opus-5-5', 1, 1, 9.0000)"
    )

    assert spent_this_month(migrated_db) == Decimal("4.0000")
    assert check_budget(migrated_db, Decimal("4.0001")) == Decimal("4.0000")
    with pytest.raises(BudgetExceeded, match=r"\$4.0000, at the FINOS_AI_BUDGET_USD limit of \$4"):
        check_budget(migrated_db, Decimal("4"))


def test_the_spend_this_month_reads_v_ai_spend(migrated_db, neon):
    spent_this_month(migrated_db)

    query = json.loads(neon.requests[-1].content)["query"]
    assert "from v_ai_spend" in query and "ai_usage" not in query


def test_a_refusal_is_an_error_and_still_recorded(migrated_db):
    refused = message(
        text="", stop_reason="refusal", stop_details=SimpleNamespace(category="cyber")
    )
    claude = Claude(FakeMessages(refused), migrated_db, budget_usd=Decimal("10"))

    with pytest.raises(AiError, match="declined"):
        ask(claude)
    assert migrated_db.execute("select count(*) as n from ai_usage") == [{"n": 1}]


def test_a_cut_off_reply_is_an_error(migrated_db):
    claude = Claude(
        FakeMessages(message(text='{"ok":', stop_reason="max_tokens")),
        migrated_db,
        budget_usd=Decimal("10"),
    )

    with pytest.raises(AiError, match="cut off"):
        ask(claude)


def test_a_reply_that_is_not_json_is_an_error(migrated_db):
    claude = Claude(FakeMessages(message(text="sorry")), migrated_db, budget_usd=Decimal("10"))

    with pytest.raises(AiError, match="not valid JSON"):
        ask(claude)


def api_error(cls, status):
    request = httpx2.Request("POST", f"{API_URL}/v1/messages")
    return cls("bad", response=httpx2.Response(status, request=request), body=None)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (api_error(anthropic.AuthenticationError, 401), "ANTHROPIC_KEY"),
        (api_error(anthropic.PermissionDeniedError, 403), "ANTHROPIC_KEY"),
        (api_error(anthropic.RateLimitError, 429), "rate"),
        (api_error(anthropic.InternalServerError, 500), "HTTP 500"),
    ],
)
def test_api_errors_explain_what_to_do(migrated_db, error, expected):
    claude = Claude(FakeMessages(error), migrated_db, budget_usd=Decimal("10"))

    with pytest.raises(AiError, match=expected):
        ask(claude)


@pytest.mark.parametrize("served", ["Claude-Opus-5.5", "claude-opus 5", "gpt-x", "claude-"])
def test_an_odd_served_model_is_recorded_as_the_requested_model(migrated_db, served):
    """ai_usage_text refuses free text in model; the paid call must still be recorded."""
    claude = Claude(FakeMessages(message(model=served)), migrated_db, budget_usd=Decimal("10"))

    reply = ask(claude, model="claude-sonnet-5-5")

    rows = migrated_db.execute("select model, cost_usd from ai_usage")
    # An unknown served name is priced at the most expensive known rate.
    assert rows == [{"model": "claude-sonnet-5-5", "cost_usd": reply.cost_usd}]
    assert reply.model == "claude-sonnet-5-5"
    assert reply.cost_usd >= cost_usd("claude-opus-5-5", usage())


def test_an_odd_served_and_requested_model_is_recorded_as_claude_unknown(migrated_db):
    claude = Claude(FakeMessages(message(model="X")), migrated_db, budget_usd=Decimal("10"))

    ask(claude, model="Claude Sonnet")

    assert migrated_db.execute("select model from ai_usage") == [{"model": "claude-unknown"}]


def test_cost_uses_the_model_that_served_the_reply():
    assert cost_usd("claude-sonnet-5-5", usage(1_000_000, 0)) == Decimal("2.0000")
    assert cost_usd("claude-opus-5-5", usage(0, 0, cache_read=1_000_000)) == Decimal("0.2000")
    # An unknown model is priced at the most expensive known rate, so budgets stay safe.
    assert cost_usd("claude-future-9", usage(1_000_000, 0)) >= Decimal("5.0000")


def test_from_key_pins_the_public_api_and_never_shows_the_key(migrated_db):
    claude = Claude.from_key(Secret("sk-ant-test-value"), migrated_db, budget_usd=Decimal("10"))

    assert str(claude.client.base_url).rstrip("/") == API_URL
    assert "sk-ant-test-value" not in repr(claude)


def test_the_schema_reaches_the_api_unchanged(migrated_db):
    api = FakeMessages(message())
    claude = Claude(api, migrated_db, budget_usd=Decimal("10"))

    ask(claude)

    assert json.dumps(api.calls[0]["output_config"]["format"]["schema"]) == json.dumps(SCHEMA)


def test_a_reply_that_breaks_off_mid_stream_is_an_ai_error(migrated_db):
    broken = httpx2.ReadError("connection reset")
    claude = Claude(FakeMessages(broken), migrated_db, budget_usd=Decimal("10"))

    with pytest.raises(AiError, match="dropped"):
        ask(claude)


def test_dated_model_ids_are_priced_as_their_model():
    dated = cost_usd("claude-opus-5-5-20261001", usage(1_000_000, 0))

    assert dated == cost_usd("claude-opus-5-5", usage(1_000_000, 0)) == Decimal("4.0000")
