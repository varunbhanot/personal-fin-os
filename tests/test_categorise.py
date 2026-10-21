import json
from datetime import date
from decimal import Decimal

import pytest

from finos.ai import StructuredReply
from finos.categorise import (
    accept,
    add_note,
    categorise,
    correct,
    group_rows,
    load_categories,
    narration_key,
    notes,
    parse_categories,
    plan,
    recategorise,
    remove_note,
    review,
    sync_categories,
)
from finos.errors import AiError, BudgetExceeded, ConfigError
from finos.models import Transaction
from finos.report import status
from finos.transfers import add_handle, find, handles, load, rebuild

from .test_transfers import CARD_BILL, CARD_PAID, PROFILES, store

CATEGORIES = load_categories()
SEP1, SEP30 = date(2026, 9, 1), date(2026, 9, 30)
OCT1, OCT31 = date(2026, 10, 1), date(2026, 10, 31)
SWIGGY_1 = "UPI/DR/412345678901/SWIGGY/YESB/swiggy@yesb/Payment"
SWIGGY_2 = "UPI/DR/598765432109/SWIGGY/YESB/swiggy@yesb/Payment"
RAMESH = "UPI/DR/412345678902/RAMESH K/SBIN/ramesh.k@oksbi/Paid"


def txn(day, amount, direction, narration, month=9):
    return Transaction(date(2026, month, day), Decimal(amount), direction, narration)


def answer(counterparty="Swiggy", category="Food & dining", confidence="high", reason="food"):
    return {
        "counterparty": counterparty,
        "category": category,
        "confidence": confidence,
        "reason": reason,
    }


def sent_rows(call):
    text = call["content"][-1]["text"]
    return json.loads(text[text.index("[") :])


class FakeClaude:
    """Answers every row it is sent with answer(row); None leaves a row out of the reply."""

    def __init__(self, answer_row=lambda row: answer(), *, errors=None, extra=()):
        self.answer_row = answer_row
        self.errors = errors or {}  # call number -> exception raised instead of a reply
        self.extra = list(extra)  # results added to every reply
        self.calls: list[dict] = []

    def structured(self, **kwargs):
        self.calls.append(kwargs)
        if error := self.errors.get(len(self.calls)):
            raise error
        results = []
        for row in sent_rows(kwargs):
            if (given := self.answer_row(row)) is not None:
                results.append({"ref": row["ref"], **given})
        return StructuredReply(
            data={"results": results + self.extra},
            model=kwargs["model"],
            cost_usd=Decimal("0.05"),
        )


def run(db, claude, profiles=PROFILES, review_min=Decimal(0), **kwargs):
    """A categorise run. With review_min 0, every unsure answer waits for review, whatever the
    amount, so the tests of the queue can use small amounts."""
    return categorise(
        db,
        claude,
        model="claude-opus-5-5",
        categories=CATEGORIES,
        profiles=profiles,
        report=rebuild(db, profiles),
        review_min=review_min,
        **kwargs,
    )


def categorised(db):
    """Each categorisation, in transaction order, without the narration."""
    rows = db.execute(
        "select g.counterparty, g.category, g.confidence, g.origin, g.needs_review, g.problem "
        "from categorisations g join transactions t using (txn_id) "
        "join statements s using (statement_id) order by s.period_start, t.seq"
    )
    return [tuple(row.values()) for row in rows]


def by_narration(mapping):
    """An answer_row that picks the answer by a word in the narration."""

    def pick(row):
        for word, given in mapping.items():
            if word in row["narration"]:
                return given
        return answer()

    return pick


def decide_swiggy(db):
    """Categorise one Swiggy row, then decide on Swiggy (money out) as Food & dining."""
    store(db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))
    run(db, FakeClaude())
    correct(db, CATEGORIES, "Swiggy", "Food & dining")


# --- the category list -------------------------------------------------------------------


def test_the_category_file_loads_with_one_transfer_category():
    names = [c.name for c in CATEGORIES]

    assert len(names) == len(set(names)) == 22
    assert {c.kind for c in CATEGORIES} == {"expense", "income", "investment", "transfer"}
    assert [c.name for c in CATEGORIES if c.kind == "transfer"] == ["Own accounts"]
    assert all(c.description for c in CATEGORIES)


@pytest.mark.parametrize(
    "text, message",
    [
        (
            "- {name: A, kind: expense, description: x}\n- {name: a, kind: income, description: y}",
            "twice",
        ),
        ("- {name: A, kind: spending, description: x}", "kind"),
        ("- {name: A, kind: expense, description: ' '}", "description"),
        ("- {name: '', kind: expense, description: x}", "name"),
        ("name: A", "list"),
        ("[]", "list"),
        ("- [unclosed", "YAML"),
        ("- Groceries", "entry 1 must have a name"),
    ],
)
def test_a_bad_category_file_is_explained(text, message):
    with pytest.raises(ConfigError, match=message) as error:
        parse_categories("cats.yaml", text)

    assert "cats.yaml" in str(error.value)


def test_the_categories_are_copied_to_the_database_and_kept_current(migrated_db):
    sync_categories(migrated_db, CATEGORIES)
    sync_categories(migrated_db, CATEGORIES)
    changed = [*CATEGORIES[:-1], CATEGORIES[-1].__class__("Own accounts", "transfer", "New text")]
    sync_categories(migrated_db, changed)

    rows = migrated_db.execute("select name, kind, description from categories order by position")

    assert [r["name"] for r in rows] == [c.name for c in CATEGORIES]
    assert rows[-1] == {"name": "Own accounts", "kind": "transfer", "description": "New text"}


# --- narration keys ----------------------------------------------------------------------


def test_one_upi_id_gives_one_key_whatever_the_reference():
    assert narration_key(SWIGGY_1, "debit") == narration_key(SWIGGY_2, "debit")
    assert narration_key(SWIGGY_1, "debit") is not None


@pytest.mark.parametrize(
    "narration",
    [
        "UPI-SWIGGY-swiggy@yesb-YESB0000001-412345678901-PAYMENT",
        "UPI-SWIGGY ORDER-swiggy@yesb-YESB0000001-598765432109-PAYMENT",
        "UPI-412345678901-swiggy@yesb",
        SWIGGY_1,
    ],
)
def test_hyphen_separated_upi_narrations_give_the_upi_id_key(narration):
    assert narration_key(narration, "debit") == "debit upi swiggy@yesb"


def test_a_debit_and_a_credit_get_different_keys():
    assert narration_key(SWIGGY_1, "debit") != narration_key(SWIGGY_1, "credit")


def test_card_merchant_text_gives_one_key_whatever_the_digits_case_and_spacing():
    first = narration_key("POS 4321XXXX1234 SWIGGY BANGALORE 12/09", "debit")
    second = narration_key("POS 9876XXXX5678 Swiggy  Bangalore 15/09", "debit")

    assert first == second
    assert first is not None


@pytest.mark.parametrize(
    "narration",
    ["TRANSFER TO 1234567890", "TRANSFER TO 9876543210", "UPI/DR/412345678901/AMAZON", "12345"],
)
def test_a_key_with_too_few_words_left_is_not_used(narration):
    assert narration_key(narration, "debit") is None


# --- categorise: who decides, and what waits for review ----------------------------------


def test_a_sure_answer_for_a_new_row_is_kept_without_review(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert len(claude.calls) == 1
    assert (result.from_memory, result.from_ai, result.to_review, result.left) == (0, 1, 0, 0)
    assert result.calls == 1 and result.cost_usd == Decimal("0.05") and result.error is None
    assert categorised(migrated_db) == [("Swiggy", "Food & dining", "high", "ai", False, None)]


@pytest.mark.parametrize("confidence", ["medium", "low"])
def test_an_unsure_answer_waits_for_review(migrated_db, confidence):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    result = run(migrated_db, FakeClaude(lambda row: answer(confidence=confidence)))

    assert result.to_review == 1
    assert categorised(migrated_db) == [("Swiggy", "Food & dining", confidence, "ai", True, None)]


def test_only_problems_and_unsure_answers_of_the_review_minimum_or_more_wait(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "9999.99", "debit", "UPI/DR/1/a@ybl"),
        txn(4, "10000", "debit", "UPI/DR/2/b@ybl"),
        txn(5, "50000", "debit", "UPI/DR/3/c@ybl"),
        txn(6, "300", "debit", "NEFT ACME CORP"),
    )
    answers = by_narration(
        {
            "a@ybl": answer("A", "Other", "low"),
            "b@ybl": answer("B", "Other", "medium"),
            "c@ybl": answer("C", "Rent", "high"),
            "ACME": answer("Acme Corp", "Salary", "high"),
        }
    )

    result = run(migrated_db, FakeClaude(answers), review_min=Decimal("10000"))

    assert [c[4] for c in categorised(migrated_db)] == [False, True, False, True]
    assert result.to_review == 2


def test_a_decided_payee_is_categorised_from_memory_without_a_call(migrated_db):
    decide_swiggy(migrated_db)
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "300", "debit", SWIGGY_2, month=10))
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert claude.calls == []
    assert (result.from_memory, result.from_ai, result.to_review) == (1, 0, 0)
    assert categorised(migrated_db)[-1] == (
        "Swiggy",
        "Food & dining",
        "high",
        "memory",
        False,
        None,
    )


def test_an_unsure_answer_reused_for_the_same_key_stays_unsure(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))
    run(migrated_db, FakeClaude(lambda row: answer(confidence="medium")))
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "300", "debit", SWIGGY_2, month=10))
    claude = FakeClaude()

    run(migrated_db, claude)

    assert claude.calls == []
    expected = ("Swiggy", "Food & dining", "medium", "memory", True, None)
    assert categorised(migrated_db)[-1] == expected


def test_claude_naming_a_decided_payee_gets_your_category(migrated_db):
    decide_swiggy(migrated_db)
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(5, "600", "debit", "SWIGGY BANGALORE"))
    claude = FakeClaude(lambda row: answer("swiggy", "Groceries"))

    run(migrated_db, claude)

    assert len(claude.calls) == 1
    assert categorised(migrated_db)[-1] == (
        "Swiggy",
        "Food & dining",
        "high",
        "memory",
        False,
        None,
    )


@pytest.mark.parametrize("confidence", ["medium", "low"])
def test_a_fresh_answer_naming_a_decided_payee_must_be_sure_to_skip_review(migrated_db, confidence):
    decide_swiggy(migrated_db)
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(5, "600", "debit", "SWIGGY BANGALORE"))

    run(migrated_db, FakeClaude(lambda row: answer(confidence=confidence)))

    expected = ("Swiggy", "Food & dining", confidence, "memory", True, None)
    assert categorised(migrated_db)[-1] == expected


def test_memory_is_per_direction(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "50", "debit", "SERVICE CHARGES ATM FEE"),
        txn(4, "900", "credit", "INTEREST CREDITED SB"),
    )
    run(migrated_db, FakeClaude(lambda row: answer("Bank", "Other", "low")))
    ids = {g.direction: g.id for g in review(migrated_db)}
    correct(migrated_db, CATEGORIES, ids["debit"], "Bank fees & interest")
    correct(migrated_db, CATEGORIES, ids["credit"], "Interest & dividends")
    store(
        migrated_db,
        "sbi-bank",
        "1111",
        OCT1,
        OCT31,
        txn(5, "20", "debit", "SMS ALERT CHARGES QTR", 10),
        txn(6, "700", "credit", "SB INTEREST PAID QTR", 10),
    )

    run(migrated_db, FakeClaude(lambda row: answer("Bank", "Other")))

    remembered = migrated_db.execute(
        "select name, direction, category from counterparties order by direction"
    )
    assert remembered == [
        {"name": "Bank", "direction": "credit", "category": "Interest & dividends"},
        {"name": "Bank", "direction": "debit", "category": "Bank fees & interest"},
    ]
    assert [c[1] for c in categorised(migrated_db)[-2:]] == [
        "Bank fees & interest",
        "Interest & dividends",
    ]


def test_an_income_category_on_a_debit_goes_to_review_with_a_problem(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "5000", "debit", "NEFT ACME CORP"))

    run(migrated_db, FakeClaude(lambda row: answer("Acme Corp", "Salary")))

    [(_, category, _, _, needs_review, problem)] = categorised(migrated_db)
    assert category == "Salary" and needs_review is True
    assert "income category on a debit" in problem


def test_an_expense_category_on_a_credit_is_a_refund_not_a_problem(migrated_db):
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(8, "99", "credit", "AMAZON REFUND"))

    run(migrated_db, FakeClaude(lambda row: answer("Amazon", "Shopping")))

    assert categorised(migrated_db) == [("Amazon", "Shopping", "high", "ai", False, None)]


def test_a_linked_transfer_gets_no_call_and_no_category(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, CARD_BILL)
    store(migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID)
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert claude.calls == [] and categorised(migrated_db) == []
    assert (result.from_memory, result.from_ai, result.left) == (0, 0, 0)


def test_a_row_that_becomes_half_of_a_transfer_loses_its_category(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, CARD_BILL)
    run(migrated_db, FakeClaude(lambda row: answer("SBI Card", "Own accounts")))
    assert len(categorised(migrated_db)) == 1
    store(migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID)

    run(migrated_db, FakeClaude())

    assert categorised(migrated_db) == []


def test_rows_that_name_your_accounts_carry_a_hint(migrated_db):
    add_handle(migrated_db, "7319")
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(30, "4000", "debit", "SBI CARD PAYMENT"),
        txn(12, "50000", "debit", "TRF TO FD 98XXXX7319"),
        txn(3, "450", "debit", SWIGGY_1),
    )
    claude = FakeClaude()

    run(migrated_db, claude)

    hints = {row["amount"]: row.get("hint") for row in sent_rows(claude.calls[0])}
    assert "sbi-card" in hints["4000.00"]
    assert "account holder" in hints["50000.00"]
    assert hints["450.00"] is None


def test_each_row_is_sent_with_its_account_kind_and_no_ids(migrated_db):
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(5, "600", "debit", "SWIGGY BANGALORE"))
    claude = FakeClaude()

    run(migrated_db, claude)

    [row] = sent_rows(claude.calls[0])
    assert {k: v for k, v in row.items() if k != "hint"} == {
        "ref": 1,
        "account": "card",
        "date": "2026-09-05",
        "direction": "debit",
        "amount": "600.00",
        "narration": "SWIGGY BANGALORE",
    }


# --- categorise: batches, failures and re-runs -------------------------------------------


def many_rows(count, month=9):
    return [
        txn(1 + i % 28, f"{100 + i}", "debit", f"UPI/DR/{i}/payee{i}@ybl", month)
        for i in range(count)
    ]


def test_rows_go_to_claude_in_batches_of_forty(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, *many_rows(90))
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert [len(sent_rows(call)) for call in claude.calls] == [40, 40, 10]
    assert (result.from_ai, result.calls, result.cost_usd) == (90, 3, Decimal("0.15"))


def test_rows_with_one_key_are_sent_once_and_all_categorised(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "450", "debit", SWIGGY_1),
        txn(9, "300", "debit", SWIGGY_2),
        txn(12, "120", "debit", SWIGGY_1.replace("4123", "4124")),
    )
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert len(sent_rows(claude.calls[0])) == 1
    assert result.from_ai == 3
    assert categorised(migrated_db) == [("Swiggy", "Food & dining", "high", "ai", False, None)] * 3


def test_reaching_the_budget_keeps_the_batches_already_stored(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, *many_rows(50))
    claude = FakeClaude(errors={2: BudgetExceeded("AI spend this month is $10.00")})

    result = run(migrated_db, claude)

    assert len(claude.calls) == 2
    assert (result.from_ai, result.left) == (40, 10)
    assert "AI spend this month" in result.error
    assert len(categorised(migrated_db)) == 40


def test_an_ai_error_stops_the_run_and_is_reported(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    result = run(migrated_db, FakeClaude(errors={1: AiError("The Claude API returned HTTP 529")}))

    assert result.error == "The Claude API returned HTTP 529"
    assert result.left == 1 and categorised(migrated_db) == []


def test_a_reply_without_results_stops_the_run(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    class Malformed(FakeClaude):
        def structured(self, **kwargs):
            reply = super().structured(**kwargs)
            return StructuredReply(data={}, model=reply.model, cost_usd=reply.cost_usd)

    result = run(migrated_db, Malformed())

    assert "no list of results" in result.error
    assert (result.calls, result.left) == (1, 1)


def test_a_row_left_out_of_the_reply_stays_uncategorised_and_is_retried(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "450", "debit", SWIGGY_1),
        txn(4, "2000", "debit", RAMESH),
    )
    stray = {"ref": 99, **answer("Stray", "Other")}
    claude = FakeClaude(by_narration({"RAMESH": None}), extra=[stray])

    first = run(migrated_db, claude)
    retry = FakeClaude(lambda row: answer("Ramesh", "Household help"))
    second = run(migrated_db, retry)

    assert (first.from_ai, first.left, first.rejected) == (1, 1, 1)
    assert [row["narration"] for row in sent_rows(retry.calls[0])] == [RAMESH]
    assert (second.from_ai, second.left) == (1, 0)
    assert [c[0] for c in categorised(migrated_db)] == ["Swiggy", "Ramesh"]


def test_a_repeated_ref_in_the_reply_leaves_that_row_uncategorised(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    result = run(migrated_db, FakeClaude(extra=[{"ref": 1, **answer("Zomato")}]))

    assert result.left == 1 and categorised(migrated_db) == []


@pytest.mark.parametrize(
    "given", [answer(category="Snacks"), answer(confidence="certain"), answer(category=None)]
)
def test_an_answer_outside_the_allowed_values_leaves_the_row_uncategorised(migrated_db, given):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    result = run(migrated_db, FakeClaude(lambda row: given))

    assert result.left == 1 and categorised(migrated_db) == []


def test_rejected_answers_are_counted_and_a_batch_with_none_usable_stops_the_run(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, *many_rows(50))
    claude = FakeClaude(lambda row: answer(category="Snacks"))

    result = run(migrated_db, claude)

    assert len(claude.calls) == 1
    assert (result.rejected, result.left) == (40, 50)
    assert "all failed the checks" in result.error


def test_some_rejected_answers_do_not_stop_the_run(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, *many_rows(50))
    claude = FakeClaude(lambda row: None if row["ref"] == 1 else answer())

    result = run(migrated_db, claude)

    assert len(claude.calls) == 2
    assert (result.rejected, result.from_ai, result.left, result.error) == (2, 48, 2, None)


def test_a_second_run_makes_no_call(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))
    run(migrated_db, FakeClaude())
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert claude.calls == []
    assert (result.from_memory, result.from_ai, result.left) == (0, 0, 0)


def test_a_replaced_statement_is_categorised_again_from_memory(migrated_db):
    first = txn(3, "450", "debit", SWIGGY_1)
    store(migrated_db, "axis-bank", "", SEP1, SEP30, first, sha="a" * 64)
    run(migrated_db, FakeClaude())
    correct(migrated_db, CATEGORIES, "Swiggy", "Food & dining")
    second = txn(9, "300", "debit", SWIGGY_2)
    assert store(migrated_db, "axis-bank", "", SEP1, SEP30, first, second, sha="b" * 64) == (
        "replaced"
    )
    claude = FakeClaude()

    result = run(migrated_db, claude)

    assert claude.calls == []
    assert result.from_memory == 2
    assert (
        categorised(migrated_db) == [("Swiggy", "Food & dining", "high", "memory", False, None)] * 2
    )


def test_a_remembered_category_dropped_from_the_list_goes_back_to_claude(migrated_db):
    decide_swiggy(migrated_db)
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "300", "debit", SWIGGY_2, month=10))
    without_food = [c for c in CATEGORIES if c.name != "Food & dining"]
    claude = FakeClaude(lambda row: answer(category="Groceries"))

    categorise(
        migrated_db,
        claude,
        model="claude-opus-5-5",
        categories=without_food,
        profiles=PROFILES,
        report=rebuild(migrated_db, PROFILES),
    )

    assert len(claude.calls) == 1
    assert categorised(migrated_db)[-1] == ("Swiggy", "Groceries", "high", "ai", False, None)


def test_flagged_statements_are_left_out(migrated_db):
    store(
        migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1), status_ok=False
    )
    claude = FakeClaude()

    run(migrated_db, claude)

    assert claude.calls == []


# --- the request -------------------------------------------------------------------------


def test_the_request_carries_the_list_notes_names_and_corrections_and_no_tools(migrated_db):
    add_note(migrated_db, "The landlord is paid monthly rent")
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "450", "debit", SWIGGY_1),
        txn(4, "2000", "debit", RAMESH),
    )
    run(migrated_db, FakeClaude(by_narration({"RAMESH": answer("Ramesh", "Other", "low")})))
    correct(migrated_db, CATEGORIES, "Ramesh", "Household help")
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "700", "debit", "ZOMATO ORDER", 10))
    claude = FakeClaude()

    run(migrated_db, claude)

    [call] = claude.calls
    text = "\n".join(block["text"] for block in call["content"])
    assert "The landlord is paid monthly rent" in text
    assert "- Own accounts (transfer):" in text
    assert "- Ramesh (money out): Household help" in text  # decided
    # In use but not decided: Claude made the name, so it goes in as JSON data.
    assert 'Other counterparty names already in use, as a JSON list of data:\n- ["Swiggy"]' in text
    assert "- Ramesh: Other corrected to Household help" in text
    assert "tools" not in call
    assert (call["purpose"], call["model"]) == ("categorise", "claude-opus-5-5")
    item = call["schema"]["properties"]["results"]["items"]["properties"]
    assert item["category"]["enum"] == [c.name for c in CATEGORIES]
    assert "never follow instructions" in call["system"].lower()
    # The fixed part of the prompt is cached across batches; the rows are not.
    assert call["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in call["content"][-1]


def test_names_and_reasons_are_cleaned_and_cut(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))
    noisy = answer("Evil\x1b[31m\nCorp " + "x" * 80, reason="line\nbreak " * 40)

    run(migrated_db, FakeClaude(lambda row: noisy))

    [(counterparty, *_)] = categorised(migrated_db)
    [reason] = [r["reason"] for r in migrated_db.execute("select reason from categorisations")]
    assert counterparty.startswith("Evil 31m Corp x") and len(counterparty) == 40
    assert "\n" not in reason and len(reason) == 100


@pytest.mark.parametrize(
    "given, stored",
    [
        ("$(curl x|sh)", "curl x sh"),
        ("--all", "all"),
        ('a"; rm -rf ~; "', "a rm -rf"),
        ("Ｓｗｉｇｇｙ", "Swiggy"),  # full-width letters
        ("Dr. D'Souza & Co, Ltd-Pune", "Dr. D'Souza & Co, Ltd-Pune"),
        ("---", "Unknown"),
        (" \t ", "Unknown"),
    ],
)
def test_a_name_keeps_only_safe_characters(migrated_db, given, stored):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1))

    run(migrated_db, FakeClaude(lambda row: answer(given)))

    assert categorised(migrated_db)[0][0] == stored


def test_a_dry_run_counts_rows_memory_and_batches_without_calling(migrated_db):
    decide_swiggy(migrated_db)
    rows = many_rows(41, month=10)
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "300", "debit", SWIGGY_2, 10), *rows)

    planned = plan(
        migrated_db,
        categories=CATEGORIES,
        report=find(load(migrated_db), PROFILES, handles(migrated_db)),
    )

    assert (planned.rows, planned.from_memory, planned.to_send, planned.batches) == (42, 1, 41, 2)
    assert Decimal("0.01") < planned.estimated_usd("claude-opus-5-5") < Decimal("1")
    assert len(categorised(migrated_db)) == 1  # nothing written


# --- review, correct, accept, notes ------------------------------------------------------


def review_run(db):
    store(
        db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "450", "debit", SWIGGY_1),
        txn(9, "300", "debit", SWIGGY_2),
        txn(4, "2000", "debit", RAMESH),
        txn(8, "99", "credit", "AMAZON REFUND 77"),
    )
    run(
        db,
        FakeClaude(
            by_narration(
                {
                    "SWIGGY": answer("Swiggy", "Groceries", "medium"),
                    "RAMESH": answer("Ramesh", "Other", "low", "a person"),
                    "AMAZON": answer("Amazon", "Shopping", "medium", "refund"),
                }
            )
        ),
    )


def test_review_groups_the_queue_by_payee_category_and_direction_without_narrations(
    migrated_db,
):
    review_run(migrated_db)

    groups = review(migrated_db)

    assert [
        (g.counterparty, g.category, g.direction, g.rows, g.amount, g.confidence, g.reason)
        for g in groups
    ] == [
        ("Ramesh", "Other", "debit", 1, Decimal("2000.00"), "low", "a person"),
        ("Swiggy", "Groceries", "debit", 2, Decimal("750.00"), "medium", "food"),
        ("Amazon", "Shopping", "credit", 1, Decimal("99.00"), "medium", "refund"),
    ]
    for narration in (SWIGGY_1, SWIGGY_2, RAMESH, "AMAZON REFUND 77"):
        assert narration not in repr(groups)


def test_a_review_id_is_short_and_stable(migrated_db):
    review_run(migrated_db)

    first = [g.id for g in review(migrated_db)]
    again = [g.id for g in review(migrated_db)]

    assert first == again and len(set(first)) == 3
    assert all(len(i) == 6 and set(i) <= set("0123456789abcdef") for i in first)


def test_a_review_group_lists_its_rows_without_narrations(migrated_db):
    review_run(migrated_db)
    swiggy = next(g for g in review(migrated_db) if g.counterparty == "Swiggy")

    found = group_rows(migrated_db, swiggy.id)

    assert [(r.date, r.source, r.direction, r.amount) for r in found.entries] == [
        (date(2026, 9, 3), "axis-bank", "debit", Decimal("450.00")),
        (date(2026, 9, 9), "axis-bank", "debit", Decimal("300.00")),
    ]
    assert SWIGGY_1 not in repr(found.entries)


def test_an_unknown_review_id_is_explained(migrated_db):
    review_run(migrated_db)

    with pytest.raises(ConfigError, match="finos review"):
        group_rows(migrated_db, "ffffff")


def test_correct_updates_every_row_remembers_and_counts_one_correction(migrated_db):
    review_run(migrated_db)

    result = correct(migrated_db, CATEGORIES, "swiggy", "food & dining")

    assert (result.counterparty, result.category, result.rows, result.counted) == (
        "Swiggy",
        "Food & dining",
        2,
        True,
    )
    swiggy = [c for c in categorised(migrated_db) if c[0] == "Swiggy"]
    assert swiggy == [("Swiggy", "Food & dining", "medium", "user", False, None)] * 2
    assert migrated_db.execute(
        "select counterparty, from_category, to_category from corrections"
    ) == [{"counterparty": "Swiggy", "from_category": "Groceries", "to_category": "Food & dining"}]
    assert migrated_db.execute("select name, direction, category from counterparties") == [
        {"name": "Swiggy", "direction": "debit", "category": "Food & dining"}
    ]
    assert "Swiggy" not in [g.counterparty for g in review(migrated_db)]


def test_correcting_to_the_same_category_counts_no_correction(migrated_db):
    review_run(migrated_db)

    result = correct(migrated_db, CATEGORIES, "Swiggy", "Groceries")

    assert result.counted is False
    assert migrated_db.execute("select count(*)::int as n from corrections") == [{"n": 0}]


def test_correct_lists_the_valid_categories_for_an_unknown_one(migrated_db):
    review_run(migrated_db)

    with pytest.raises(ConfigError, match="Groceries.*Own accounts"):
        correct(migrated_db, CATEGORIES, "Swiggy", "Food")


def test_correct_explains_an_unknown_counterparty(migrated_db):
    review_run(migrated_db)

    with pytest.raises(ConfigError, match="finos review"):
        correct(migrated_db, CATEGORIES, "Zomato", "Food & dining")


def test_correcting_debits_to_an_income_category_keeps_them_in_review(migrated_db):
    review_run(migrated_db)

    correct(migrated_db, CATEGORIES, "Ramesh", "Salary")

    [ramesh] = [c for c in categorised(migrated_db) if c[0] == "Ramesh"]
    assert ramesh[1:5] == ("Salary", "low", "user", True)
    assert "income category on a debit" in ramesh[5]


def test_correct_and_accept_take_a_review_id(migrated_db):
    review_run(migrated_db)
    ids = {g.counterparty: g.id for g in review(migrated_db)}

    corrected = correct(migrated_db, CATEGORIES, ids["Swiggy"], "Food & dining")
    accepted = accept(migrated_db, [ids["Amazon"], "amazon"])

    assert corrected.counterparty == "Swiggy"
    assert accepted.accepted == ["Amazon"] and accepted.skipped == []
    assert [g.counterparty for g in review(migrated_db)] == ["Ramesh"]


def test_accept_remembers_without_a_correction(migrated_db):
    review_run(migrated_db)

    result = accept(migrated_db, ["swiggy"])

    assert result.accepted == ["Swiggy"] and result.skipped == []
    assert migrated_db.execute("select count(*)::int as n from corrections") == [{"n": 0}]
    assert [g.counterparty for g in review(migrated_db)] == ["Ramesh", "Amazon"]
    assert migrated_db.execute("select name, direction, category from counterparties") == [
        {"name": "Swiggy", "direction": "debit", "category": "Groceries"}
    ]
    assert {c[3] for c in categorised(migrated_db) if c[0] == "Swiggy"} == {"user"}


def test_accept_all_takes_each_clear_group_and_skips_the_rest(migrated_db):
    store(
        migrated_db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "450", "debit", SWIGGY_1),
        txn(4, "2000", "debit", "UPI/DR/1/RAMESH K/cook@ybl"),
        txn(5, "2000", "debit", "UPI/DR/2/RAMESH K/ramesh@okaxis"),
        txn(6, "5000", "debit", "NEFT ACME CORP"),
    )
    run(
        migrated_db,
        FakeClaude(
            by_narration(
                {
                    "SWIGGY": answer(confidence="medium"),
                    "cook": answer("Ramesh", "Household help", "medium"),
                    "okaxis": answer("Ramesh", "Other", "medium"),
                    "ACME": answer("Acme Corp", "Salary"),
                }
            )
        ),
    )

    result = accept(migrated_db, None)

    assert result.accepted == ["Swiggy"]
    skipped = dict(result.skipped)
    assert "money-out rows are in 2 categories" in skipped["Ramesh"]
    assert "income category on a debit" in skipped["Acme Corp"]
    assert sorted(g.counterparty for g in review(migrated_db)) == ["Acme Corp", "Ramesh", "Ramesh"]


def test_accepting_a_name_not_in_the_queue_is_reported(migrated_db):
    review_run(migrated_db)

    result = accept(migrated_db, ["Zomato"])

    assert result.accepted == []
    assert result.skipped == [("Zomato", "not in the review queue")]


def test_unknown_is_never_remembered(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "10", "debit", "CASH WDL ATM"))
    run(migrated_db, FakeClaude(lambda row: answer("Unknown", "Other", "low")))

    everything = accept(migrated_db, None)
    by_name = accept(migrated_db, ["Unknown"])
    store(migrated_db, "axis-bank", "", OCT1, OCT31, txn(4, "9999", "debit", "MISC DEBIT", 10))
    run(migrated_db, FakeClaude(lambda row: answer("Unknown", "Rent")))

    assert everything.accepted == [] and "many payees" in dict(everything.skipped)["Unknown"]
    assert by_name.accepted == ["Unknown"]
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]
    assert categorised(migrated_db)[-1] == ("Unknown", "Rent", "high", "ai", False, None)


def test_your_own_name_is_never_remembered_but_its_decided_rows_are(migrated_db):
    add_handle(migrated_db, "Asha Rao")
    emi = "TO LOAN A/C ASHA RAO HOMELOAN EMI"
    store(migrated_db, "canara-bank", "2222", SEP1, SEP30, txn(30, "45000.00", "debit", emi))
    run(migrated_db, FakeClaude(lambda row: answer("Asha Rao", "Own accounts", "low")))
    [own] = review(migrated_db)

    everything = accept(migrated_db, None)
    corrected = correct(migrated_db, CATEGORIES, own.id, "Loan EMI")
    store(migrated_db, "canara-bank", "2222", OCT1, OCT31, txn(30, "45000.00", "debit", emi, 10))
    store(
        migrated_db,
        "sbi-bank",
        "1111",
        OCT1,
        OCT31,
        txn(8, "250000", "debit", "TO FD ASHA RAO", 10),
    )
    claude = FakeClaude(lambda row: answer("Asha Rao", "Investments"))
    run(migrated_db, claude)

    assert "your own accounts" in dict(everything.skipped)["Asha Rao"]
    assert corrected.counted is True
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]
    # The EMI's narration is known and decided: no call, no review. The deposit is new, and
    # your name does not carry the EMI's category over to it.
    assert [sent["narration"] for call in claude.calls for sent in sent_rows(call)] == [
        "TO FD ASHA RAO"
    ]
    assert [c[1:5] for c in categorised(migrated_db)[-2:]] == [
        ("Loan EMI", "low", "memory", False),
        ("Investments", "high", "ai", False),
    ]


def unknown_run(db):
    """Two unsure Unknown rows wait for review; two other Unknown rows do not."""
    store(
        db,
        "axis-bank",
        "",
        SEP1,
        SEP30,
        txn(3, "10", "debit", "CASH WDL ATM 1"),
        txn(4, "20", "debit", "CASH WDL ATM 2"),
        txn(5, "30", "debit", "MISC DEBIT RENT"),
        txn(6, "40", "debit", "MISC DEBIT SURE"),
    )
    run(
        db,
        FakeClaude(
            by_narration(
                {
                    "CASH": answer("Unknown", "Other", "low"),
                    "RENT": answer("Unknown", "Rent"),
                    "SURE": answer("Unknown", "Other"),
                }
            )
        ),
    )


def test_correcting_an_unknown_review_group_changes_only_the_groups_rows(migrated_db):
    unknown_run(migrated_db)
    [group] = review(migrated_db)

    result = correct(migrated_db, CATEGORIES, group.id, "Groceries")

    assert (result.counterparty, result.rows, result.counted) == ("Unknown", 2, True)
    assert [c[1:5] for c in categorised(migrated_db)] == [
        ("Groceries", "low", "user", False),
        ("Groceries", "low", "user", False),
        ("Rent", "high", "ai", False),
        ("Other", "high", "ai", False),
    ]
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]
    assert migrated_db.execute("select count(*)::int as n from corrections") == [{"n": 1}]


def test_accepting_an_unknown_review_group_decides_only_the_groups_rows(migrated_db):
    unknown_run(migrated_db)
    [group] = review(migrated_db)

    result = accept(migrated_db, [group.id])

    assert result.accepted == ["Unknown"] and review(migrated_db) == []
    assert [c[1:5] for c in categorised(migrated_db)] == [
        ("Other", "low", "user", False),
        ("Other", "low", "user", False),
        ("Rent", "high", "ai", False),
        ("Other", "high", "ai", False),  # same name, category and direction, not in the group
    ]
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]


def test_correcting_unknown_by_name_still_changes_every_row(migrated_db):
    unknown_run(migrated_db)

    result = correct(migrated_db, CATEGORIES, "Unknown", "Groceries")

    assert result.rows == 4
    assert {c[1] for c in categorised(migrated_db)} == {"Groceries"}


def test_correcting_your_own_names_review_group_leaves_its_other_rows(migrated_db):
    add_handle(migrated_db, "Asha Rao")
    store(
        migrated_db,
        "canara-bank",
        "2222",
        SEP1,
        SEP30,
        txn(8, "250000", "debit", "TO FD ASHA RAO"),
        txn(30, "45000.00", "debit", "TO LOAN A/C ASHA RAO HOMELOAN EMI"),
    )
    run(
        migrated_db,
        FakeClaude(
            by_narration(
                {
                    "FD": answer("Asha Rao", "Investments"),
                    "EMI": answer("Asha Rao", "Own accounts", "low"),
                }
            )
        ),
    )
    [own] = review(migrated_db)

    result = correct(migrated_db, CATEGORIES, own.id, "Loan EMI")

    assert result.rows == 1
    assert [c[1] for c in categorised(migrated_db)] == ["Investments", "Loan EMI"]


def row_id(db, narration):
    """A row's ID as finos rows prints it."""
    found = db.execute("select txn_id from transactions where narration = %s", [narration])
    return found[0]["txn_id"][:8]


def test_recategorise_sets_the_named_rows_only_and_remembers_nothing(migrated_db):
    unknown_run(migrated_db)
    first = row_id(migrated_db, "CASH WDL ATM 1")
    rent = row_id(migrated_db, "MISC DEBIT RENT")

    result = recategorise(migrated_db, CATEGORIES, [first, rent, first.upper()], "groceries")

    assert (result.counterparty, result.category, result.rows, result.counted) == (
        "Unknown",
        "Groceries",
        2,
        True,
    )
    assert [c[1:5] for c in categorised(migrated_db)] == [
        ("Groceries", "low", "user", False),
        ("Other", "low", "ai", True),
        ("Groceries", "high", "user", False),
        ("Other", "high", "ai", False),
    ]
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]
    assert migrated_db.execute(
        "select counterparty, from_category, to_category from corrections"
    ) == [{"counterparty": "Unknown", "from_category": "Other", "to_category": "Groceries"}]


def test_recategorise_keeps_an_income_category_on_a_debit_in_review(migrated_db):
    unknown_run(migrated_db)

    recategorise(migrated_db, CATEGORIES, [row_id(migrated_db, "MISC DEBIT SURE")], "Salary")

    last = categorised(migrated_db)[-1]
    assert last[1:5] == ("Salary", "high", "user", True)
    assert "income category on a debit" in last[5]


def test_recategorise_to_the_same_category_counts_no_correction(migrated_db):
    unknown_run(migrated_db)

    result = recategorise(migrated_db, CATEGORIES, [row_id(migrated_db, "MISC DEBIT RENT")], "Rent")

    assert (result.rows, result.counted) == (1, False)
    assert migrated_db.execute("select count(*)::int as n from corrections") == [{"n": 0}]
    assert categorised(migrated_db)[2][3] == "user"


def test_recategorise_refuses_a_linked_or_uncategorised_row_and_changes_nothing(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, CARD_BILL)
    run(migrated_db, FakeClaude(lambda row: answer("SBI Card", "Own accounts")))
    store(migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID)
    rebuild(migrated_db, PROFILES)
    store(migrated_db, "hdfc-bank", "3333", SEP1, SEP30, txn(3, "10", "debit", "NEW PAYEE"))
    bill = row_id(migrated_db, CARD_BILL.narration)
    new = row_id(migrated_db, "NEW PAYEE")

    with pytest.raises(ConfigError, match="linked transfer"):
        recategorise(migrated_db, CATEGORIES, [bill], "Groceries")
    with pytest.raises(ConfigError, match="no category yet"):
        recategorise(migrated_db, CATEGORIES, [new], "Groceries")
    with pytest.raises(ConfigError, match="not a row ID"):
        recategorise(migrated_db, CATEGORIES, ["xyz"], "Groceries")
    with pytest.raises(ConfigError, match="Groceries.*Own accounts"):
        recategorise(migrated_db, CATEGORIES, [new], "Food")
    assert categorised(migrated_db) == [("SBI Card", "Own accounts", "high", "ai", False, None)]


def accept_then_next_month(db, decide):
    """Claude answers Ramesh unsure; decide(db) settles it; a new month brings another row."""
    store(db, "axis-bank", "", SEP1, SEP30, txn(4, "2000", "debit", RAMESH))
    run(db, FakeClaude(lambda row: answer("Ramesh", "Household help", "low")))
    decide(db)
    store(db, "axis-bank", "", OCT1, OCT31, txn(4, "2000", "debit", RAMESH, month=10))
    claude = FakeClaude()
    run(db, claude)
    return claude


@pytest.mark.parametrize(
    "decide",
    [
        lambda db: accept(db, ["Ramesh"]),
        lambda db: correct(db, CATEGORIES, "Ramesh", "Household help"),
        lambda db: correct(db, CATEGORIES, "Ramesh", "Other"),
    ],
)
def test_a_decided_unsure_answer_is_not_asked_about_again(migrated_db, decide):
    claude = accept_then_next_month(migrated_db, decide)

    assert claude.calls == []
    assert categorised(migrated_db)[-1][3:5] == ("memory", False)
    assert review(migrated_db) == []


def test_notes_are_added_listed_and_removed(migrated_db):
    first = add_note(migrated_db, "  The landlord   is paid monthly rent ")
    second = add_note(migrated_db, "Salary comes from Acme Corp")

    listed = notes(migrated_db)
    removed = remove_note(migrated_db, first)
    again = remove_note(migrated_db, first)

    assert listed == [
        (first, "The landlord is paid monthly rent"),
        (second, "Salary comes from Acme Corp"),
    ]
    assert (removed, again) == (True, False)
    assert notes(migrated_db) == [(second, "Salary comes from Acme Corp")]


@pytest.mark.parametrize("bad", ["", "   ", "x" * 301, "bad\x00note"])
def test_a_note_must_be_short_printable_text(migrated_db, bad):
    with pytest.raises(ConfigError, match="note"):
        add_note(migrated_db, bad)


# --- status ------------------------------------------------------------------------------


def test_status_counts_categories_and_corrections(migrated_db):
    review_run(migrated_db)
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(5, "600", "debit", "ZOMATO ORDER"))
    store(migrated_db, "axis-bank", "", OCT1, OCT31, CARD_BILL)
    store(migrated_db, "sbi-card", "04", OCT1, OCT31, CARD_PAID)
    correct(migrated_db, CATEGORIES, "Ramesh", "Household help")

    report = status(migrated_db, PROFILES)

    assert (
        report.categorised,
        report.to_review,
        report.uncategorised,
        report.corrections_this_month,
    ) == (1, 3, 1, 1)


def test_correct_once_changes_the_rows_without_remembering_the_name(migrated_db):
    fee = "ANNUAL FEE CARD 1000 GST 180"
    store(migrated_db, "sbi-card", "04", SEP1, SEP30, txn(5, "1180", "debit", fee))
    run(migrated_db, FakeClaude(lambda row: answer("Credit Card", "Own accounts")))

    result = correct(migrated_db, CATEGORIES, "Credit Card", "Bank fees & interest", once=True)
    store(
        migrated_db,
        "sbi-card",
        "04",
        OCT1,
        OCT31,
        txn(5, "1180", "debit", fee, 10),
        txn(9, "25000", "debit", "CARD BILL AUTOPAY", 10),
    )
    run(migrated_db, FakeClaude(lambda row: answer("Credit Card", "Own accounts")))

    assert result.counted is True
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]
    # The fee's own text is recognised; another "Credit Card" row keeps Claude's category.
    assert [c[:2] for c in categorised(migrated_db)[-2:]] == [
        ("Credit Card", "Bank fees & interest"),
        ("Credit Card", "Own accounts"),
    ]


def test_correct_by_name_can_change_one_direction_only(migrated_db):
    add_handle(migrated_db, "Asha Rao")
    store(
        migrated_db,
        "sbi-bank",
        "1111",
        SEP1,
        SEP30,
        txn(5, "20000", "debit", "TO CAR LOAN ASHA RAO"),
        txn(11, "5000", "credit", "BY TRF FROM ASHA RAO"),
    )
    run(migrated_db, FakeClaude(lambda row: answer("Asha Rao", "Loan EMI")))

    result = correct(migrated_db, CATEGORIES, "Asha Rao", "Other income", direction="credit")

    assert result.rows == 1
    assert [c[1] for c in categorised(migrated_db)] == ["Loan EMI", "Other income"]
