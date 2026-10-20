import dataclasses
import functools
import hashlib
import json
from decimal import Decimal

import httpx
import pytest
from typer.testing import CliRunner

from finos import cli
from finos.ai import Claude
from finos.categorise import review
from finos.cli import app
from finos.db import NeonHttpDb

from .pdfs import make_pdf
from .test_ai import FakeMessages, message
from .test_categorise import RAMESH, SEP1, SEP30, SWIGGY_1, txn
from .test_extract import GOOD
from .test_month import BANK, CARD, build
from .test_sync import CATEGORISED, HDFC_PDF
from .test_transfers import store

runner = CliRunner()
SECRETS_JSON = {
    "PW_AXIS_BANK": "test-pw-axis",
    "PW_HDFC_TATANEU": "test-pw-hdfc",
    "PW_SBI_BANK": "test-pw-sbi-bank",
    "PW_SBI_CARD": "test-pw-sbi",
    "ANTHROPIC_KEY": "sk-ant-cli-test",
}


@pytest.fixture
def cloud(monkeypatch, neon) -> set[str]:
    """One fake network for the CLI: Doppler, Neon (emulated on Postgres) and Drive.

    Returns the hosts the session's proxy refuses; add one to simulate a missing network secret.
    """
    monkeypatch.setenv("FINOS_NEON_HOST", "ep-test-1.test-region.aws.neon.tech")
    monkeypatch.setenv("FINOS_DRIVE_FOLDER_ID", "folder1")
    files = {"hdfc-mar": HDFC_PDF}
    listing = [
        {"id": k, "name": f"{k}.pdf", "md5Checksum": hashlib.md5(v).hexdigest()}  # noqa: S324
        for k, v in files.items()
    ]
    refused: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host in refused:
            raise httpx.ProxyError("403 Forbidden")
        if host == "api.doppler.com":
            return httpx.Response(200, json=SECRETS_JSON)
        if host in ("api.test-region.aws.neon.tech", "api.c-9.test-region.aws.neon.tech"):
            return neon(request)
        if host == "www.googleapis.com":
            if request.url.params.get("alt") == "media":
                return httpx.Response(200, content=files[request.url.path.rsplit("/", 1)[-1]])
            return httpx.Response(200, json={"files": listing})
        return httpx.Response(404)

    monkeypatch.setattr(
        cli, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler))
    )
    # A refused host is retried with backoff; the tests need not wait for it.
    monkeypatch.setattr(cli, "NeonHttpDb", functools.partial(NeonHttpDb, sleep=lambda s: None))

    def fake_claude(key, db, *, budget_usd):
        assert key.reveal() == "sk-ant-cli-test"
        replies = [message(json.dumps(GOOD)), message(json.dumps(CATEGORISED))]
        return Claude(FakeMessages(*replies), db, budget_usd=budget_usd)

    monkeypatch.setattr(Claude, "from_key", staticmethod(fake_claude))
    return refused


def test_check_reports_each_part_by_name_only(cloud):
    result = runner.invoke(app, ["check"])

    assert result.exit_code == 0, result.output
    assert "api.test-region.aws.neon.tech" in result.output
    assert "secret     ok      ANTHROPIC_KEY" in result.output
    assert "secret     ok      PW_HDFC_TATANEU" in result.output
    assert "secret     ok      PW_AXIS_BANK" in result.output
    assert "secret     ok      PW_SBI_CARD" in result.output
    assert "drive auth     proxy" in result.output
    assert "1 PDF(s)" in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_check_reports_every_part_when_doppler_is_refused(cloud):
    cloud.add("api.doppler.com")

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 1
    assert "secrets    FAILED" in result.output
    assert "connection to api.doppler.com" in result.output
    assert "database   ok" in result.output
    assert "drive      skipped" in result.output


def test_check_still_checks_drive_when_the_database_is_refused(cloud):
    cloud.add("api.test-region.aws.neon.tech")

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 1
    assert "database   FAILED" in result.output
    assert "drive      ok" in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_check_uses_the_cell_host_neon_names(cloud, monkeypatch):
    monkeypatch.setenv("FINOS_NEON_HOST", "ep-test-1.c-9.test-region.aws.neon.tech")

    ok = runner.invoke(app, ["check"])
    cloud.add("api.c-9.test-region.aws.neon.tech")
    refused = runner.invoke(app, ["check"])

    assert ok.exit_code == 0, ok.output
    assert "Neon SQL host api.c-9.test-region.aws.neon.tech" in ok.output
    assert "database   ok" in ok.output
    assert "connection to api.c-9.test-region.aws.neon.tech" in refused.output


def test_check_reports_a_refused_drive(cloud):
    cloud.add("www.googleapis.com")

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 1
    assert "database   ok" in result.output
    assert "drive      FAILED" in result.output
    assert "connection to www.googleapis.com" in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_check_fails_when_a_secret_is_missing(cloud, monkeypatch):
    monkeypatch.delitem(SECRETS_JSON, "ANTHROPIC_KEY")

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 1
    assert "secret     MISSING ANTHROPIC_KEY" in result.output


def test_check_expects_no_secret_for_a_source_without_a_password(cloud, monkeypatch):
    profiles = [*cli.load_profiles()]
    profiles.append(dataclasses.replace(profiles[0], id="open-bank", password_secret=None))
    monkeypatch.setattr(cli, "load_profiles", lambda: profiles)

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 0, result.output
    secrets = [
        line.split()[-1] for line in result.output.splitlines() if line.startswith("secret ")
    ]
    assert secrets == [
        "ANTHROPIC_KEY",
        "PW_AXIS_BANK",
        "PW_HDFC_TATANEU",
        "PW_SBI_BANK",
        "PW_SBI_CARD",
    ]


def test_sync_then_status(cloud):
    first = runner.invoke(app, ["sync"])
    second = runner.invoke(app, ["sync"])
    report = runner.invoke(app, ["status"])

    assert first.exit_code == 0, first.output
    assert "imported  hdfc-mar.pdf" in first.output
    assert "unchanged hdfc-mar.pdf" in second.output
    assert "2026-03  hdfc-tataneu   *4321  ok         2 transactions" in report.output
    assert "Categorised 2 row(s): 0 from memory, 2 by Claude" in first.output
    assert "AI spend: $0.0160 this month" in report.output
    for value in SECRETS_JSON.values():
        assert value not in first.output + second.output + report.output


def test_a_failed_file_makes_sync_exit_non_zero(cloud, monkeypatch):
    monkeypatch.setitem(SECRETS_JSON, "PW_HDFC_TATANEU", "wrong")

    result = runner.invoke(app, ["sync"])

    assert result.exit_code == 1
    assert "failed    hdfc-mar.pdf" in result.output


def test_status_with_an_empty_record(cloud):
    result = runner.invoke(app, ["status"])

    assert "No statements yet" in result.output
    assert f"${Decimal('0')}" in result.output


def test_check_explains_missing_settings(monkeypatch):
    monkeypatch.delenv("FINOS_NEON_HOST", raising=False)
    monkeypatch.delenv("FINOS_DRIVE_FOLDER_ID", raising=False)

    result = runner.invoke(app, ["check"])

    assert result.exit_code == 1
    assert "FINOS_NEON_HOST" in result.output


def test_sync_explains_missing_settings(monkeypatch):
    monkeypatch.delenv("FINOS_NEON_HOST", raising=False)

    result = runner.invoke(app, ["sync"])

    assert result.exit_code == 1
    assert "FINOS_NEON_HOST" in result.output


def test_help_lists_the_commands():
    result = runner.invoke(app, ["--help"])

    for command in ("check", "identify", "sync", "status", "transfers", "accounts", "month", "sql"):
        assert command in result.output


def test_printed_text_is_plain_and_bounded():
    assert cli._plain("bad\x1b[2Jname‮.pdf") == "bad [2Jname .pdf"
    assert cli._plain("line one\nline two") == "line one\nline two"
    assert len(cli._plain("x" * 1000, 50)) == 50


def test_sync_can_retry_flagged_statements(cloud):
    runner.invoke(app, ["sync"])

    result = runner.invoke(app, ["sync", "--retry-flagged"])

    assert "Retrying 0 flagged statement(s)." in result.output
    assert "unchanged hdfc-mar.pdf" in result.output


def test_identify_names_each_files_profile_without_ai_or_database(cloud, monkeypatch):
    # Neither the database nor Claude may be used: refuse one and break the other.
    cloud.add("api.test-region.aws.neon.tech")

    def no_claude(*args, **kwargs):
        raise AssertionError("finos identify must not call Claude")

    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))

    result = runner.invoke(app, ["identify"])

    assert result.exit_code == 0, result.output
    # The name of the secret that opened the file, never its value.
    assert "hdfc-tataneu  hdfc-mar.pdf  (opened with PW_HDFC_TATANEU)" in result.output
    assert "1 file(s); 0 failed." in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_identify_shows_a_file_without_a_password(cloud, monkeypatch):
    monkeypatch.setattr(cli.Drive, "download", lambda self, file: make_pdf([["Kotak"]]))

    result = runner.invoke(app, ["identify"])

    assert "failed        hdfc-mar.pdf  (no password)" in result.output


def test_identify_exits_non_zero_when_a_file_fails(cloud, monkeypatch):
    monkeypatch.setitem(SECRETS_JSON, "PW_HDFC_TATANEU", "pw-not-this-one")

    result = runner.invoke(app, ["identify"])

    assert result.exit_code == 1
    assert "failed        hdfc-mar.pdf" in result.output
    assert "None of the 4 statement passwords" in result.output
    assert "pw-not-this-one" not in result.output


def test_identify_with_no_pdfs_explains_what_to_check(cloud, monkeypatch):
    monkeypatch.setattr(cli.Drive, "list_pdfs", lambda self: [])

    result = runner.invoke(app, ["identify"])

    assert result.exit_code == 1
    assert "No PDFs" in result.output
    assert "FINOS_DRIVE_FOLDER_ID" in result.output


def test_transfers_links_pairs_without_claude(cloud, monkeypatch):
    runner.invoke(app, ["sync"])

    def no_claude(*args, **kwargs):
        raise AssertionError("finos transfers must not call Claude")

    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))

    result = runner.invoke(app, ["transfers"])

    assert result.exit_code == 0, result.output
    assert "Linked transfers: 0" in result.output
    # The card statement's payment names no account, and there is no bank statement yet.
    assert "Unpaired" not in result.output


def test_accounts_lists_accounts_and_manages_handles(cloud):
    runner.invoke(app, ["sync"])

    added = runner.invoke(app, ["accounts", "add", "7319"])
    again = runner.invoke(app, ["accounts", "add", "7319"])
    listed = runner.invoke(app, ["accounts"])
    removed = runner.invoke(app, ["accounts", "remove", "7319"])
    bad = runner.invoke(app, ["accounts", "add", "84"])

    assert added.exit_code == 0, added.output
    assert "Added the handle." in added.output
    assert "already stored" in again.output
    assert "hdfc-tataneu *4321" in listed.output
    assert "Handles: 7319" in listed.output
    assert "Removed the handle." in removed.output
    assert bad.exit_code == 1
    assert "handle must be 4 or more" in bad.output


def test_status_shows_a_transfers_line(cloud):
    runner.invoke(app, ["sync"])

    result = runner.invoke(app, ["status"])

    assert "Transfers: 0 linked, 0 unpaired" in result.output


def claude_answering(monkeypatch, *replies):
    """Make every command that calls Claude get these replies, in order."""

    def fake_claude(key, db, *, budget_usd):
        return Claude(FakeMessages(*replies), db, budget_usd=budget_usd)

    monkeypatch.setattr(Claude, "from_key", staticmethod(fake_claude))


def no_claude(*args, **kwargs):
    raise AssertionError("this command must not call Claude")


SWIGGY_AND_RAMESH = {
    "results": [
        {"ref": 1, "counterparty": "Swiggy", "category": "Food & dining", "confidence": "high",
         "reason": "food delivery"},
        {"ref": 2, "counterparty": "Ramesh", "category": "Other", "confidence": "low",
         "reason": "a person"},
    ]
}  # fmt: skip


def two_rows(db):
    store(db, "axis-bank", "", SEP1, SEP30, txn(3, "450", "debit", SWIGGY_1),
          txn(4, "2000", "debit", RAMESH))  # fmt: skip


def test_categorise_dry_run_counts_and_estimates_without_claude(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))

    result = runner.invoke(app, ["categorise", "--dry-run"])

    assert result.exit_code == 0, result.output
    assert "Rows to categorise: 2" in result.output
    assert "To Claude: 2 row(s) in 1 call(s)" in result.output
    assert "No Claude call was made." in result.output
    assert SWIGGY_1 not in result.output and RAMESH not in result.output


def test_small_unsure_answers_are_kept_without_review_by_default(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))

    run = runner.invoke(app, ["categorise"])
    queue = runner.invoke(app, ["review"])

    assert run.exit_code == 0, run.output
    assert "To review" not in run.output  # Ramesh is unsure, but under 10000
    assert "Nothing to review." in queue.output


def test_categorise_then_review_correct_accept_and_status(cloud, migrated_db, monkeypatch):
    monkeypatch.setenv("FINOS_REVIEW_MIN_INR", "0")
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))

    run = runner.invoke(app, ["categorise"])
    queue = runner.invoke(app, ["review"])
    [ramesh_id] = [g.id for g in review(migrated_db) if g.counterparty == "Ramesh"]
    corrected = runner.invoke(app, ["correct", ramesh_id, "household help"])
    accepted = runner.invoke(app, ["accept", "--all"])
    empty = runner.invoke(app, ["review"])
    report = runner.invoke(app, ["status"])

    assert run.exit_code == 0, run.output
    assert "Categorised 2 row(s): 0 from memory, 2 by Claude in 1 call(s)" in run.output
    assert "To review: 1 row(s). Run finos review." in run.output
    assert queue.exit_code == 0, queue.output
    assert "To review: 1 row(s), 1 counterparties" in queue.output
    assert f"{ramesh_id}  Ramesh" in queue.output and "out 2000.00" in queue.output
    assert "Swiggy" not in queue.output  # Claude was sure about it
    assert "a person" not in queue.output  # Claude's free-text reason is not printed
    for text in (run.output, queue.output, corrected.output, accepted.output, empty.output):
        assert SWIGGY_1 not in text and RAMESH not in text
    assert "Ramesh: 1 row(s) now Household help. Counted as a correction." in corrected.output
    assert "Accepted: none" in accepted.output
    assert "Nothing to review." in empty.output
    assert (
        "Categories: 2 categorised, 0 to review, 0 not categorised yet; 1 correction(s) this month"
    ) in report.output


def test_categorise_reports_why_it_stopped_and_exits_non_zero(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message("", stop_reason="refusal"))

    result = runner.invoke(app, ["categorise"])

    assert result.exit_code == 1
    assert "Stopped: Claude declined the categorise request" in result.output
    assert "Not categorised: 2" in result.output


def test_correct_with_an_unknown_category_lists_the_choices(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])

    result = runner.invoke(app, ["correct", "Swiggy", "Food"])

    assert result.exit_code == 1
    assert "is not a category" in result.output and "Own accounts" in result.output


def test_accept_needs_names_or_all(cloud):
    result = runner.invoke(app, ["accept"])

    assert result.exit_code == 1
    assert "--all" in result.output


def test_accept_reports_what_it_skipped(cloud, migrated_db, monkeypatch):
    monkeypatch.setenv("FINOS_REVIEW_MIN_INR", "0")
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])

    result = runner.invoke(app, ["accept", "Zomato", "Ramesh"])

    assert result.exit_code == 0, result.output
    assert "Accepted: Ramesh" in result.output
    assert "Skipped Zomato: not in the review queue" in result.output


def test_notes_are_added_listed_and_removed(cloud, monkeypatch):
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))

    added = runner.invoke(app, ["notes", "add", "The landlord is paid monthly rent"])
    listed = runner.invoke(app, ["notes"])
    removed = runner.invoke(app, ["notes", "remove", "1"])
    missing = runner.invoke(app, ["notes", "remove", "1"])
    bad = runner.invoke(app, ["notes", "add", " "])
    empty = runner.invoke(app, ["notes"])

    assert added.exit_code == 0, added.output
    assert "Added note 1." in added.output
    assert "1  The landlord is paid monthly rent" in listed.output
    assert "Removed note 1." in removed.output
    assert "No note 1." in missing.output
    assert bad.exit_code == 1 and "A note must be" in bad.output
    assert "No notes yet." in empty.output


def test_review_shows_a_rows_problem(cloud, migrated_db, monkeypatch):
    store(migrated_db, "axis-bank", "", SEP1, SEP30, txn(3, "5000", "debit", "NEFT ACME CORP"))
    salary = {
        "results": [
            {"ref": 1, "counterparty": "Acme Corp", "category": "Salary",
             "confidence": "high", "reason": "employer"}
        ]
    }  # fmt: skip
    claude_answering(monkeypatch, message(json.dumps(salary)))
    runner.invoke(app, ["categorise"])

    result = runner.invoke(app, ["review"])

    assert "problem: an income category on a debit" in result.output
    assert "out 5000.00" in result.output


def test_categorise_reports_rejected_answers(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    off_list = {
        "results": [
            {"ref": n, "counterparty": "X", "category": "Snacks", "confidence": "high",
             "reason": "-"}
            for n in (1, 2)
        ]
    }  # fmt: skip
    claude_answering(monkeypatch, message(json.dumps(off_list)))

    result = runner.invoke(app, ["categorise"])

    assert result.exit_code == 1
    assert "Rejected: 2 answer(s) from Claude failed the checks" in result.output
    assert "Stopped: Claude's answers to a batch of 2 row(s) all failed the checks" in result.output


def test_review_lists_one_groups_rows(cloud, migrated_db, monkeypatch):
    monkeypatch.setenv("FINOS_REVIEW_MIN_INR", "0")
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])
    [ramesh_id] = [g.id for g in review(migrated_db) if g.counterparty == "Ramesh"]

    result = runner.invoke(app, ["review", ramesh_id])

    assert result.exit_code == 0, result.output
    assert f"{ramesh_id}  Ramesh  Other" in result.output
    assert "2026-09-04  axis-bank" in result.output and "2000.00" in result.output
    assert RAMESH not in result.output


def test_correct_once_says_so(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])

    result = runner.invoke(app, ["correct", "Swiggy", "Groceries", "--once"])

    assert result.exit_code == 0, result.output
    assert "Swiggy: 1 row(s) now Groceries. Counted as a correction." in result.output
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]


def test_correct_by_name_takes_a_direction(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])

    out = runner.invoke(app, ["correct", "Ramesh", "Household help", "--direction", "out"])
    wrong = runner.invoke(app, ["correct", "Ramesh", "Other", "--direction", "up"])
    money_in = runner.invoke(app, ["correct", "Ramesh", "Other", "--direction", "in"])

    assert "Ramesh: 1 row(s) now Household help." in out.output
    assert wrong.exit_code == 1 and "'in' or 'out'" in wrong.output
    assert money_in.exit_code == 1 and "No transaction has the counterparty" in money_in.output


# --- month and sql -----------------------------------------------------------------------


def test_month_lists_each_month_with_its_figures(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["month"])

    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0].split() == ["Month", "Covered", "Income", "Expenses", "Savings", "Investments"]
    assert lines[1].split() == ["2026-08", "partial", "0.00", "500.00", "-500.00", "0.00"]
    assert lines[2].split() == [
        "2026-09", "partial", "1,51,200.50", "74,156.75", "77,043.75", "20,000.00",
    ]  # fmt: skip


def test_month_shows_one_month_in_full(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["month", "2026-09"])

    assert result.exit_code == 0, result.output
    lines = [" ".join(line.split()) for line in result.output.splitlines()]
    expected = [
        "2026-09 partial: 1 of 3 accounts cover the whole month",
        "axis-bank 30 of 30 days",
        "sbi-bank *1111 0 of 30 days",
        "sbi-card *04 21 of 30 days",
        "Income 1,51,200.50",
        "Salary 1,50,000.00",
        "Interest & dividends 1,200.50",
        "Expenses 74,156.75",
        "Groceries 3,456.75",
        "Rent 35,000.00 (40,000.00 less refunds 5,000.00)",
        "Loan EMI 20,000.00 (30,000.00 less refunds 10,000.00)",
        "Family & gifts -800.00 (0.00 less refunds 800.00)",
        "Savings 77,043.75 (51% of income)",
        "Investments 20,000.00 (in 25,000.00, out 5,000.00)",
        "Linked transfers: 2 row(s), 20,000.00 out and 20,000.00 in",
        "Own accounts: 2 row(s), 7,000.00 out and 2,000.00 in",
        "No category: 1 row(s), 999.00 out and 0.00 in. Run finos categorise.",
        "Waiting for review: 1 row(s), 15,000.00. Their category stands until you decide. "
        "Run finos review.",
        "Flagged: 1 statement(s) in this month are not counted. Run finos status.",
    ]
    for line in expected:
        assert line in lines, line
    assert lines.index("Expenses 74,156.75") < lines.index("Groceries 3,456.75")
    assert "transfer links" not in result.output
    for t, _ in BANK + CARD:
        assert t.narration not in result.output


def test_month_warns_when_the_transfer_links_are_stale(cloud, migrated_db):
    build(migrated_db)
    migrated_db.execute("delete from transfer_links")

    result = runner.invoke(app, ["month", "2026-09"])

    assert "The transfer links differ from a new match. Run finos transfers." in result.output


def test_month_refuses_a_badly_written_month(cloud):
    result = runner.invoke(app, ["month", "Sept"])

    assert result.exit_code == 1
    assert "Write the month as YYYY-MM, for example 2026-09." in result.output


def test_month_says_when_nothing_covers_a_month(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["month", "2026-03"])

    assert result.exit_code == 0
    assert "No statement covers 2026-03." in result.output


def test_month_with_an_empty_record(cloud):
    result = runner.invoke(app, ["month"])

    assert result.exit_code == 0
    assert "No statements yet. Run finos sync." in result.output


@pytest.mark.parametrize(
    ("value", "shown"),
    [(Decimal("108000"), "1,08,000.00"), (Decimal("12345678.9"), "1,23,45,678.90"),
     (Decimal("500"), "500.00"), (Decimal("5000"), "5,000.00"), (Decimal("-800"), "-800.00"),
     (Decimal("-150000.5"), "-1,50,000.50"), (Decimal("0"), "0.00")],
)  # fmt: skip
def test_amounts_use_indian_grouping(value, shown):
    assert cli._inr(value) == shown


def test_sql_prints_a_table(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(
        app,
        ["sql", "select month, income, expenses, complete from v_monthly_summary order by month"],
    )

    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0].split() == ["month", "income", "expenses", "complete"]
    assert lines[2].split() == ["2026-08-01", "0", "500.00", "f"]
    assert lines[3].split() == ["2026-09-01", "151200.50", "74156.75", "f"]
    assert lines[-1] == "(2 rows)"


def test_sql_shows_at_most_200_rows(cloud):
    result = runner.invoke(app, ["sql", "select n from generate_series(1, 250) n"])

    lines = result.output.splitlines()
    assert lines[-1] == "(200 of 250 rows shown)"
    assert lines[-2].strip() == "200"


def test_sql_cleans_and_cuts_each_cell(cloud):
    result = runner.invoke(
        app, ["sql", "select E'bad\\x1b[2J' || repeat('x', 100) as c, E'one\\ntwo' as d"]
    )

    assert result.exit_code == 0, result.output
    assert "\x1b" not in result.output
    assert "bad [2J" in result.output
    assert "x" * 60 not in result.output
    assert "one two" in result.output


def test_sql_with_no_rows_still_names_the_columns(cloud):
    result = runner.invoke(app, ["sql", "select 1 as n where false"])

    assert result.output.splitlines()[0].strip() == "n"
    assert result.output.splitlines()[-1] == "(0 rows)"


def test_sql_refuses_a_write(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["sql", "delete from transactions"])

    assert result.exit_code == 1
    assert "read-only transaction" in result.output
    assert migrated_db.execute("select count(*)::int as n from transactions")[0]["n"] == 19


def test_month_shows_a_month_with_nothing_to_warn_about(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["month", "2026-08"])

    assert result.exit_code == 0, result.output
    lines = [" ".join(line.split()) for line in result.output.splitlines()]
    assert "Savings -500.00" in lines  # no share of income when there is no income
    for words in ("No category", "Waiting for review", "Flagged", "transfer links"):
        assert words not in result.output


def test_sql_takes_a_query_that_starts_with_a_dash(cloud):
    result = runner.invoke(app, ["sql", "-- a note\nselect 1 as n"])

    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[-1] == "(1 row)"


def test_sql_with_no_columns_prints_only_the_count(cloud):
    result = runner.invoke(app, ["sql", "commit"])

    assert result.output.splitlines() == ["(0 rows)"]


def test_sql_shows_at_most_20_columns(cloud):
    columns = ", ".join(f"{n} as c{n}" for n in range(1, 26))

    result = runner.invoke(app, ["sql", f"select {columns}"])

    lines = result.output.splitlines()
    assert lines[0].split() == [f"c{n}" for n in range(1, 21)]
    assert "(5 more column(s) not shown)" in lines
