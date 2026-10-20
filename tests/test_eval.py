import hashlib
import json
from datetime import date
from decimal import Decimal

import httpx
import pytest

from finos.ai import Claude
from finos.categorise import load_categories, plan
from finos.errors import AiError, BudgetExceeded
from finos.evaluate import Candidate, Comparison, compare_rows, eval_plan, run_eval
from finos.extract import extract
from finos.identify import load_profiles
from finos.inbox import Drive
from finos.models import Transaction
from finos.transfers import find, handles, load

from .pdfs import make_pdf
from .test_ai import FakeMessages, message
from .test_categorise import FakeClaude as CategoriseClaude
from .test_categorise import answer
from .test_extract import GOOD, MISREAD, PDF, PROFILE, TEXT
from .test_extract import FakeClaude as ExtractClaude
from .test_sync import HDFC_LINES, HDFC_PDF, SECRETS, sync
from .test_transfers import store

CATEGORIES = load_categories()
PROFILES = load_profiles()
MODEL = "claude-haiku-5-5"
SEP1, SEP30 = date(2026, 9, 1), date(2026, 9, 30)
# Made-up narrations: none may appear in any eval output.
SECRET_SHOP = "UPI/DR/111122223333/ZYXSHOP/YESB/zyxshop@yesb/Made up"
SECRET_COOK = "UPI/DR/444455556666/QWERTY COOK/SBIN/qcook@oksbi/Made up"

APR_LINES = [
    "HDFC Bank Tata Neu Credit Card Statement",
    "Card XXXX XXXX XXXX 4321 Statement Period 13/03/2026 to 12/04/2026",
    "Previous Balance 1,499.50 Total Amount Due 1,000.00 Minimum Amount Due 50.00",
    "20/03/2026 PAYMENT RECEIVED 1,499.50 Cr",
    "02/04/2026 AMAZON PAY 1,000.00",
]
APR_PDF = make_pdf([APR_LINES], password="test-pw-hdfc")
APR_GOOD = GOOD | {
    "period_start": "2026-03-13",
    "period_end": "2026-04-12",
    "opening": "1499.50",
    "closing": "1000.00",
    "transactions": [
        {"date": "2026-03-20", "narration": "PAYMENT RECEIVED", "amount": "1499.50",
         "direction": "credit", "balance": None},
        {"date": "2026-04-02", "narration": "AMAZON PAY", "amount": "1000.00",
         "direction": "debit", "balance": None},
    ],
}  # fmt: skip
assert HDFC_LINES  # the March statement that GOOD transcribes


def md5(body: bytes) -> str:
    return hashlib.md5(body).hexdigest()  # noqa: S324 - Drive's checksum


class FakeDrive:
    """Serves files by Drive ID; any other ID is a 404. Counts every request."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.params.get("alt") == "media":
            file_id = request.url.path.rsplit("/", 1)[-1]
            if file_id not in self.files:
                return httpx.Response(404)
            return httpx.Response(200, content=self.files[file_id])
        listing = [
            {"id": k, "name": f"{k}.pdf", "md5Checksum": md5(v)} for k, v in self.files.items()
        ]
        return httpx.Response(200, json={"files": listing})

    def drive(self) -> Drive:
        return Drive(httpx.Client(transport=httpx.MockTransport(self.handler)), "folder1")


def imported(db, files=None):
    """Import the made-up HDFC statements through finos sync, with a fake Claude."""
    files = files or {"hdfc-mar": HDFC_PDF}
    replies = {"hdfc-mar": GOOD, "hdfc-apr": APR_GOOD}
    fake = FakeDrive(files)
    results = sync(
        drive=fake.drive(),
        db=db,
        claude=ExtractClaude(*(replies[name] for name in files)),
        secrets=SECRETS,
        profiles=PROFILES,
        model="claude-opus-5-5",
    )
    assert {r.outcome for r in results} == {"imported"}, results
    return fake


def checksum(db) -> dict[str, str]:
    """A fingerprint of every main record table, to show eval changed none of them."""
    out = {}
    for table in ("statements", "transactions", "extractions", "categorisations"):
        out[table] = db.execute(
            f"select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), "  # noqa: S608
            f"'')) as sum from {table} x"
        )[0]
    return out


def evaluate(db, claude, fake, *, categories=False, limit=None, source=None, seen=None):
    planned = eval_plan(
        db,
        profiles=PROFILES,
        categories=CATEGORIES if categories else None,
        limit=limit,
        source=source,
    )
    return run_eval(
        db,
        claude,
        drive=fake.drive(),
        secrets=SECRETS,
        profiles=PROFILES,
        categories=CATEGORIES,
        planned=planned,
        model=MODEL,
        on_statement=(seen.append if seen is not None else lambda checked: None),
    )


# --- compare_rows --------------------------------------------------------------------------

D1, D2 = date(2026, 9, 1), date(2026, 9, 2)
ROWS = [
    (D1, "debit", Decimal("10.00")),
    (D1, "debit", Decimal("10.00")),
    (D2, "credit", Decimal("5")),
]


def test_identical_rows_match_fully():
    result = compare_rows(ROWS, list(ROWS))

    assert result == Comparison(stored=3, new=3, matched=3, amount_mismatches=0, missing=0, extra=0)
    assert result.match_rate == 1


def test_a_changed_amount_is_one_amount_mismatch():
    new = [*ROWS[:2], (D2, "credit", Decimal("6"))]

    result = compare_rows(ROWS, new)

    assert (result.matched, result.amount_mismatches, result.missing, result.extra) == (2, 1, 0, 0)
    assert result.match_rate == Decimal(2) / 3


def test_a_dropped_row_is_missing_and_an_added_row_is_extra():
    dropped = compare_rows(ROWS, ROWS[1:])
    added = compare_rows(ROWS, [*ROWS, (D2, "debit", Decimal("1"))])

    assert (dropped.matched, dropped.missing, dropped.extra) == (2, 1, 0)
    assert (added.matched, added.missing, added.extra) == (3, 0, 1)
    assert added.match_rate == Decimal(3) / 4


def test_duplicates_count_as_a_multiset():
    result = compare_rows(ROWS, [ROWS[0], ROWS[2]])

    assert (result.matched, result.missing) == (2, 1)


def test_no_rows_on_either_side_is_a_full_match():
    assert compare_rows([], []).match_rate == 1


# --- the plan ------------------------------------------------------------------------------


def test_the_plan_takes_only_ok_statements_with_an_extraction(migrated_db):
    imported(migrated_db)
    store(migrated_db, "axis-bank", "", SEP1, SEP30, Transaction(SEP1, Decimal(1), "debit", "x"))
    store(migrated_db, "sbi-bank", "1111", SEP1, SEP30, status_ok=False)

    planned = eval_plan(migrated_db, profiles=PROFILES)

    shown = [(c.source, c.rows) for c in planned.statements]
    assert shown == [("hdfc-tataneu", 2), ("axis-bank", 1)]
    hdfc = planned.statements[0]
    assert hdfc.reference_model == "claude-opus-5-5"
    assert hdfc.file is not None and hdfc.file.id == "hdfc-mar"


def test_limit_and_source_narrow_the_plan(migrated_db):
    imported(migrated_db)
    store(migrated_db, "axis-bank", "", SEP1, SEP30)

    assert [c.source for c in eval_plan(migrated_db, profiles=PROFILES, limit=1).statements] == [
        "hdfc-tataneu"
    ]
    only = eval_plan(migrated_db, profiles=PROFILES, source="axis-bank")
    assert [c.source for c in only.statements] == ["axis-bank"]


def test_the_estimate_uses_past_extract_usage(migrated_db):
    imported(migrated_db)
    without = eval_plan(migrated_db, profiles=PROFILES).estimated_usd(MODEL)
    migrated_db.execute(
        "insert into ai_usage (purpose, model, input_tokens, output_tokens, cost_usd) "
        "values ('extract', 'claude-opus-5-5', 1000000, 100000, 1), "
        "('categorise', 'claude-opus-5-5', 9000000, 9000000, 1)"
    )

    with_history = eval_plan(migrated_db, profiles=PROFILES).estimated_usd(MODEL)

    # One statement, twice (the retry): 1M input at $0.10 and 100k output at $0.50 per million.
    assert with_history == Decimal("0.3000")
    assert without > 0 and without != with_history


def test_the_estimate_adds_the_category_calls(migrated_db):
    imported(migrated_db)
    run_categories(migrated_db)

    bare = eval_plan(migrated_db, profiles=PROFILES)
    asked = eval_plan(migrated_db, profiles=PROFILES, categories=CATEGORIES)

    assert len(asked.category_rows) == 2
    assert asked.estimated_usd(MODEL) > bare.estimated_usd(MODEL)


# --- a run ---------------------------------------------------------------------------------


def right(row):
    """The answers the record holds for the March rows (made-up names)."""
    if row["direction"] == "debit":
        return answer("Zorblax Traders", "Shopping")
    return answer("Quuxcard Payment", "Own accounts")


def run_categories(db, *, confirm=False):
    """Give the March rows a category, as finos categorise would."""
    from finos.categorise import categorise

    claude = CategoriseClaude(right)
    report = find(load(db), PROFILES, handles(db))
    categorise(
        db, claude, model="m", categories=CATEGORIES, profiles=PROFILES, report=report,
        review_min=Decimal(0),
    )  # fmt: skip
    if confirm:
        db.execute("update categorisations set origin = 'user', needs_review = false")


def test_a_run_compares_each_statement_and_changes_no_record_table(migrated_db):
    fake = imported(migrated_db)
    before = checksum(migrated_db)
    api = FakeMessages(message(json.dumps(GOOD), model=MODEL))
    claude = Claude(api, migrated_db, budget_usd=Decimal("10"))
    seen = []

    result = evaluate(migrated_db, claude, fake, seen=seen)

    assert checksum(migrated_db) == before
    [checked] = result.checked
    assert seen == [checked]
    assert checked.outcome == "compared"
    assert checked.comparison.match_rate == 1
    assert checked.balances_equal and checked.verified
    usage = migrated_db.execute("select purpose, model from ai_usage")
    assert usage == [{"purpose": "eval-extract", "model": MODEL}]
    assert api.calls[0]["model"] == MODEL
    run = migrated_db.execute("select * from eval_runs")
    assert len(run) == 1
    assert run[0] | {"id": 0, "at": None} == {
        "id": 0, "at": None, "model": MODEL, "reference_model": "claude-opus-5-5",
        "statements": 1, "skipped": 0, "rows_stored": 2, "rows_matched": 2,
        "amount_mismatches": 0, "rows_missing": 0, "rows_extra": 0, "verified": 1,
        "categories_asked": None, "categories_agreed": None, "cost_usd": result.cost_usd,
    }  # fmt: skip
    assert result.run_id == run[0]["id"]


def test_a_misread_is_counted_and_its_failed_checks_too(migrated_db):
    fake = imported(migrated_db)

    result = evaluate(migrated_db, ExtractClaude(MISREAD, MISREAD), fake)

    [checked] = result.checked
    assert (checked.comparison.matched, checked.comparison.amount_mismatches) == (1, 1)
    assert not checked.verified
    assert checked.balances_equal


def test_an_extraction_that_fails_counts_every_stored_row_as_missing(migrated_db):
    fake = imported(migrated_db)

    result = evaluate(migrated_db, ExtractClaude(AiError("Claude declined")), fake)

    [checked] = result.checked
    assert checked.outcome == "failed"
    assert "declined" in checked.detail
    assert (checked.comparison.missing, checked.comparison.matched) == (2, 0)
    row = migrated_db.execute("select statements, rows_missing, verified from eval_runs")[0]
    assert row == {"statements": 1, "rows_missing": 2, "verified": 0}


def test_a_missing_or_changed_file_is_skipped_and_the_run_goes_on(migrated_db):
    fake = imported(migrated_db, {"hdfc-mar": HDFC_PDF, "hdfc-apr": APR_PDF})
    other = make_pdf([["Some other file"]])
    # March now downloads as other bytes with a matching Drive checksum; April is gone.
    migrated_db.execute(
        "insert into drive_files (drive_file_id, drive_md5, sha256, seen_at) "
        "select 'swapped', %s, statement_id, now() + interval '1 day' from statements "
        "where period_start = '2026-02-13'",
        [md5(other)],
    )
    fake.files = {"swapped": other}
    claude = ExtractClaude()

    result = evaluate(migrated_db, claude, fake)

    assert [c.outcome for c in result.checked] == ["skipped", "skipped"]
    assert "changed" in result.checked[0].detail
    assert "Google Drive refused access" in result.checked[1].detail
    assert claude.calls == []
    row = migrated_db.execute("select statements, skipped from eval_runs")[0]
    assert row == {"statements": 0, "skipped": 2}


def test_a_statement_without_a_drive_file_is_skipped(migrated_db):
    store(migrated_db, "axis-bank", "", SEP1, SEP30)
    migrated_db.execute("delete from drive_files")

    result = evaluate(migrated_db, ExtractClaude(), FakeDrive({}))

    [checked] = result.checked
    assert checked.outcome == "skipped"
    assert "no Drive file" in checked.detail


def test_a_file_of_another_profile_is_skipped(migrated_db):
    fake = imported(migrated_db)
    migrated_db.execute("update statements set source = 'sbi-card'")

    result = evaluate(migrated_db, ExtractClaude(), fake)

    assert result.checked[0].outcome == "skipped"
    assert "hdfc-tataneu" in result.checked[0].detail


def test_reaching_the_budget_stops_the_run_and_keeps_what_was_done(migrated_db):
    fake = imported(migrated_db, {"hdfc-mar": HDFC_PDF, "hdfc-apr": APR_PDF})
    claude = ExtractClaude(GOOD, BudgetExceeded("AI spend this month is at the limit"))
    store(migrated_db, "axis-bank", "", SEP1, SEP30)  # a third statement, never reached

    result = evaluate(migrated_db, claude, fake, categories=True)

    assert [c.outcome for c in result.checked] == ["compared", "stopped", "stopped"]
    assert result.checked[2].detail == "AI budget reached"
    assert result.stopped and "limit" in result.stopped
    assert result.categories_asked is None
    row = migrated_db.execute("select statements, rows_matched from eval_runs")[0]
    assert row == {"statements": 1, "rows_matched": 2}


def test_the_budget_stops_a_real_client_before_the_second_call(migrated_db):
    fake = imported(migrated_db, {"hdfc-mar": HDFC_PDF, "hdfc-apr": APR_PDF})
    api = FakeMessages(message(json.dumps(GOOD)), message(json.dumps(APR_GOOD)))
    claude = Claude(api, migrated_db, budget_usd=Decimal("0.0080"))

    result = evaluate(migrated_db, claude, fake)

    assert len(api.calls) == 1
    assert [c.outcome for c in result.checked] == ["compared", "stopped"]
    assert result.cost_usd == Decimal("0.0080")


def test_categories_are_asked_without_memory_and_nothing_is_stored(migrated_db):
    fake = imported(migrated_db)
    run_categories(migrated_db, confirm=True)
    migrated_db.execute("insert into household_notes (note) values ('The cook is paid by UPI')")
    before = checksum(migrated_db)
    extractor = ExtractClaude(GOOD)
    asker = CategoriseClaude(right)

    class Both:
        calls: list[dict] = []

        def structured(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs["purpose"] == "eval-extract":
                return extractor.structured(**kwargs)
            return asker.structured(**kwargs)

    result = evaluate(migrated_db, Both(), fake, categories=True)

    assert checksum(migrated_db) == before
    [request] = asker.calls
    assert request["purpose"] == "eval-categorise"
    assert request["model"] == MODEL
    context = request["content"][0]["text"]
    assert "The cook is paid by UPI" in context
    # A confirmed counterparty or a correction would give the answer away.
    assert "Zorblax" not in context and "Quuxcard" not in context
    sent = json.loads(request["content"][-1]["text"].split("\n", 1)[1])
    assert [r["direction"] for r in sent] == ["credit", "debit"]
    assert set(sent[0]) == {"ref", "account", "date", "direction", "amount", "narration"}
    assert (result.categories_asked, result.categories_agreed) == (2, 2)
    assert (result.confirmed_asked, result.confirmed_agreed) == (2, 2)
    row = migrated_db.execute("select categories_asked, categories_agreed from eval_runs")[0]
    assert row == {"categories_asked": 2, "categories_agreed": 2}


def test_a_different_category_does_not_agree(migrated_db):
    fake = imported(migrated_db)
    run_categories(migrated_db)

    class Both:
        def structured(self, **kwargs):
            if kwargs["purpose"] == "eval-extract":
                return ExtractClaude(GOOD).structured(**kwargs)
            return CategoriseClaude(lambda row: answer("Zorblax", "Groceries")).structured(**kwargs)

    result = evaluate(migrated_db, Both(), fake, categories=True)

    assert (result.categories_asked, result.categories_agreed) == (2, 0)
    assert (result.confirmed_asked, result.confirmed_agreed) == (0, 0)


def test_a_category_error_stops_the_categories_only(migrated_db):
    fake = imported(migrated_db)
    run_categories(migrated_db)

    class Both:
        def structured(self, **kwargs):
            if kwargs["purpose"] == "eval-extract":
                return ExtractClaude(GOOD).structured(**kwargs)
            raise AiError("The Claude API rate limit was reached")

    result = evaluate(migrated_db, Both(), fake, categories=True)

    assert result.checked[0].outcome == "compared"
    assert "rate limit" in result.stopped
    assert result.categories_asked == 0


def test_rows_waiting_for_review_or_linked_are_not_asked(migrated_db):
    imported(migrated_db)
    run_categories(migrated_db)
    migrated_db.execute("update categorisations set needs_review = true, origin = 'ai'")

    planned = eval_plan(migrated_db, profiles=PROFILES, categories=CATEGORIES)

    assert planned.category_rows == []


def test_no_narration_reaches_a_result(migrated_db):
    store(
        migrated_db, "axis-bank", "", SEP1, SEP30,
        Transaction(SEP1, Decimal("10"), "debit", SECRET_SHOP),
        Transaction(SEP30, Decimal("20"), "debit", SECRET_COOK),
    )  # fmt: skip

    result = evaluate(migrated_db, ExtractClaude(), FakeDrive({}))

    text = repr(result) + repr(eval_plan(migrated_db, profiles=PROFILES))
    for narration in (SECRET_SHOP, SECRET_COOK):
        assert narration not in text
        assert "ZYXSHOP" not in text and "QWERTY" not in text


# --- the request shapes it reuses ----------------------------------------------------------


def test_extract_records_the_purpose_it_is_given():
    claude = ExtractClaude(GOOD)

    extract(claude, model=MODEL, pdf=PDF, profile=PROFILE, page_texts=TEXT, purpose="eval-extract")

    assert claude.calls[0]["purpose"] == "eval-extract"


def test_the_candidate_names_a_statement_without_its_file_name():
    candidate = Candidate(
        statement_id="a" * 64, source="axis-bank", account_last4="1234",
        period_start=SEP1, period_end=SEP30, reference_model="m", rows=3, file=None,
    )  # fmt: skip

    assert candidate.label() == "2026-09-01 to 2026-09-30 axis-bank *1234"


@pytest.mark.parametrize("value", [0, -1])
def test_the_plan_refuses_a_limit_below_one(migrated_db, value):
    from finos.errors import ConfigError

    with pytest.raises(ConfigError, match="limit"):
        eval_plan(migrated_db, profiles=PROFILES, limit=value)


def test_plan_without_rows_still_works(migrated_db):
    # The categorise plan of an empty record is still empty after the split into ask_batch.
    report = find(load(migrated_db), PROFILES, handles(migrated_db))
    assert plan(migrated_db, categories=CATEGORIES, report=report).rows == 0
