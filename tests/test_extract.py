import base64
from datetime import date
from decimal import Decimal

import pytest

from finos.ai import StructuredReply
from finos.errors import AiError
from finos.extract import PROMPT_VERSION, SCHEMA, extract
from finos.identify import SourceProfile

PROFILE = SourceProfile(
    id="hdfc-tataneu",
    kind="card",
    markers=("HDFC",),
    password_secret="PW_HDFC_TATANEU",
    hints="Amounts marked Cr are credits.",
)
TEXT = [
    "HDFC Bank Tata Neu Card XXXX XXXX XXXX 4321 Period 13/02/2026 to 12/03/2026\n"
    "Previous Balance 2,000.00 Total Amount Due 1,499.50\n"
    "20/02/2026 PAYMENT RECEIVED 2,000.00 Cr\n02/03/2026 AMAZON PAY 1,499.50"
]
PDF = b"%PDF-1.7 unlocked"
GOOD = {
    "account_last4": "4321",
    "period_start": "2026-02-13",
    "period_end": "2026-03-12",
    "opening": "2000.00",
    "closing": "1499.50",
    "total_debits": None,
    "total_credits": None,
    "transactions": [
        {
            "date": "2026-02-20",
            "narration": "PAYMENT RECEIVED",
            "amount": "2000.00",
            "direction": "credit",
            "balance": None,
        },
        {
            "date": "2026-03-02",
            "narration": "AMAZON PAY",
            "amount": "1499.50",
            "direction": "debit",
            "balance": None,
        },
    ],
}
# Misreads 1,499.50 as 1,494.50: totals and grounding both catch it.
MISREAD = GOOD | {
    "transactions": [GOOD["transactions"][0], GOOD["transactions"][1] | {"amount": "1494.50"}]
}


class FakeClaude:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    def structured(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return StructuredReply(data=reply, model=kwargs["model"], cost_usd=Decimal("0.10"))


def run(claude):
    return extract(claude, model="claude-opus-5-5", pdf=PDF, profile=PROFILE, page_texts=TEXT)


def test_a_good_transcription_passes_first_time():
    claude = FakeClaude(GOOD)

    result = run(claude)

    assert result.problems == []
    assert result.extraction.attempts == 1
    assert result.extraction.prompt_version == PROMPT_VERSION
    assert result.extraction.raw == GOOD
    statement = result.statement
    assert statement.source == "hdfc-tataneu"
    assert statement.account_last4 == "4321"
    assert statement.period_start == date(2026, 2, 13)
    assert statement.totals.closing == Decimal("1499.50")
    assert [t.amount for t in statement.transactions] == [Decimal("2000.00"), Decimal("1499.50")]


def test_the_request_sends_the_pdf_and_schema_with_no_tools():
    claude = FakeClaude(GOOD)

    run(claude)

    call = claude.calls[0]
    assert call["purpose"] == "extract"
    assert call["model"] == "claude-opus-5-5"
    assert call["schema"] is SCHEMA
    document, instructions = call["content"]
    assert document["type"] == "document"
    assert document["source"] == {
        "type": "base64",
        "media_type": "application/pdf",
        "data": base64.b64encode(PDF).decode(),
    }
    assert document["cache_control"] == {"type": "ephemeral"}
    assert "Amounts marked Cr are credits." in instructions["text"]
    assert "tools" not in call


def test_a_failed_check_gets_one_retry_with_the_problems_as_feedback():
    claude = FakeClaude(MISREAD, GOOD)

    result = run(claude)

    assert result.problems == []
    assert result.extraction.attempts == 2
    feedback = claude.calls[1]["content"][-1]["text"]
    assert "1494.50" in feedback
    assert "never change a figure" in feedback.lower()


def test_a_second_failure_returns_the_problems_for_flagging():
    claude = FakeClaude(MISREAD, MISREAD)

    result = run(claude)

    assert result.extraction.attempts == 2
    assert any(p.startswith("totals:") for p in result.problems)
    assert any(p.startswith("grounding: amount 1494.50") for p in result.problems)
    assert result.statement.transactions[1].amount == Decimal("1494.50")


@pytest.mark.parametrize(
    "broken",
    [
        GOOD | {"opening": "two thousand"},
        GOOD | {"period_start": "13/02/2026"},
        GOOD | {"transactions": [GOOD["transactions"][0] | {"amount": "-2000.00"}]},
        GOOD | {"transactions": [GOOD["transactions"][0] | {"direction": "sideways"}]},
        {"account_last4": "4321"},
    ],
)
def test_a_malformed_reply_counts_as_a_failed_attempt(broken):
    claude = FakeClaude(broken, GOOD)

    result = run(claude)

    assert result.extraction.attempts == 2
    assert "transcription" in claude.calls[1]["content"][-1]["text"].lower()


def test_two_malformed_replies_raise():
    claude = FakeClaude({"nope": 1}, {"nope": 2})

    with pytest.raises(AiError, match="could not be read"):
        run(claude)


def test_ai_errors_propagate():
    claude = FakeClaude(AiError("Claude declined the extract request"))

    with pytest.raises(AiError, match="declined"):
        run(claude)


def test_the_schema_requires_every_field():
    assert set(SCHEMA["required"]) == set(SCHEMA["properties"])
    row = SCHEMA["properties"]["transactions"]["items"]
    assert set(row["required"]) == set(row["properties"])
    assert SCHEMA["additionalProperties"] is False
    assert row["additionalProperties"] is False


def test_narrations_are_made_printable_and_short():
    hostile = "UPI/\x1b[31mPAY‮ME\nNOW " + "x" * 500
    reply = GOOD | {
        "transactions": [GOOD["transactions"][0], GOOD["transactions"][1] | {"narration": hostile}]
    }

    narration = run(FakeClaude(reply)).statement.transactions[1].narration

    assert narration.isprintable()
    assert narration.startswith("UPI/ [31mPAY ME NOW xxx")
    assert len(narration) == 200


def test_an_error_on_the_retry_keeps_the_paid_first_attempt():
    claude = FakeClaude(MISREAD, AiError("The connection to the Claude API dropped"))

    result = run(claude)

    assert result.extraction.attempts == 2
    assert result.statement.transactions[1].amount == Decimal("1494.50")
    assert result.problems[-1] == "retry: The connection to the Claude API dropped"


def test_the_attempt_with_fewer_problems_is_kept():
    worse = MISREAD | {"period_end": "2026-02-14"}  # adds period and grounding problems

    result = run(FakeClaude(MISREAD, worse))

    assert result.statement.period_end == date(2026, 3, 12)


@pytest.mark.parametrize(
    "broken",
    [
        GOOD | {"opening": "9" * 30 + ".00"},
        GOOD | {"account_last4": "XXXX"},
        GOOD | {"account_last4": ""},
    ],
)
def test_impossible_values_count_as_a_failed_attempt(broken):
    claude = FakeClaude(broken, GOOD)

    result = run(claude)

    assert result.extraction.attempts == 2
    assert result.problems == []


def test_a_full_account_number_is_cut_to_its_last_four_digits():
    result = run(FakeClaude(GOOD | {"account_last4": "XXXX XXXX XXXX 4321"}))

    assert result.statement.account_last4 == "4321"
