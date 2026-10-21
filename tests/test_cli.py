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
from .test_categorise import RAMESH, SEP1, SEP30, SWIGGY_1, row_id, txn
from .test_extract import GOOD, MISREAD
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

    for command in (
        "check", "identify", "sync", "status", "transfers", "accounts", "month", "sql", "rows",
        "spread", "goal", "eval", "correct", "recategorise",
    ):  # fmt: skip
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


UNKNOWN_TWICE = {
    "results": [
        {"ref": 1, "counterparty": "Unknown", "category": "Other", "confidence": "low",
         "reason": "no name"},
        {"ref": 2, "counterparty": "Unknown", "category": "Rent", "confidence": "high",
         "reason": "rent"},
    ]
}  # fmt: skip


def test_correct_an_unknown_group_changes_its_rows_only(cloud, migrated_db, monkeypatch):
    monkeypatch.setenv("FINOS_REVIEW_MIN_INR", "0")
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(UNKNOWN_TWICE)))
    runner.invoke(app, ["categorise"])
    [group] = review(migrated_db)

    result = runner.invoke(app, ["correct", group.id, "Groceries"])

    assert result.exit_code == 0, result.output
    assert "Unknown: 1 row(s) now Groceries. Counted as a correction." in result.output
    assert migrated_db.execute("select category from categorisations order by category") == [
        {"category": "Groceries"},
        {"category": "Rent"},
    ]


def test_recategorise_sets_rows_by_id_without_a_narration(cloud, migrated_db, monkeypatch):
    two_rows(migrated_db)
    claude_answering(monkeypatch, message(json.dumps(SWIGGY_AND_RAMESH)))
    runner.invoke(app, ["categorise"])
    swiggy, ramesh = row_id(migrated_db, SWIGGY_1), row_id(migrated_db, RAMESH)

    both = runner.invoke(app, ["recategorise", swiggy, ramesh, "household help"])
    again = runner.invoke(app, ["recategorise", ramesh, "Household help"])
    unknown = runner.invoke(app, ["recategorise", "ffffff", "Household help"])
    no_row = runner.invoke(app, ["recategorise", "Household help"])

    assert both.exit_code == 0, both.output
    assert "2 row(s) now Household help. Counted as a correction." in both.output
    assert "1 row(s) now Household help. It already had that category" in again.output
    assert unknown.exit_code == 1 and "No counted row" in unknown.output
    assert no_row.exit_code != 0
    for text in (both.output, again.output):
        assert SWIGGY_1 not in text and RAMESH not in text
    assert migrated_db.execute("select count(*)::int as n from counterparties") == [{"n": 0}]


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


# --- rows, spreads and goals -------------------------------------------------------------


def words(output):
    return [" ".join(line.split()) for line in output.splitlines()]


def rid(db, narration):
    return db.execute("select txn_id from transactions where narration = %s", [narration])[0][
        "txn_id"
    ][:8]


def test_rows_lists_ids_and_never_a_narration(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["rows", "2026-09"])

    assert result.exit_code == 0, result.output
    lines = words(result.output)
    assert lines[0] == "ID Date Account Way Amount Category Counterparty"
    assert (
        f"{rid(migrated_db, 'GROCER')} 2026-09-03 axis-bank out 3,456.75 Groceries Payee" in lines
    )
    assert f"{rid(migrated_db, 'NEW PAYEE')} 2026-09-16 axis-bank out 999.00 - -" in lines
    assert (
        f"{rid(migrated_db, 'SBI CARD PAYMENT')} 2026-09-11 axis-bank out 20,000.00 "
        "(linked transfer) Payee"
    ) in lines
    assert "(17 rows)" in lines
    assert "AUGUST DINNER" not in result.output  # an August row
    for t, _ in BANK + CARD:
        assert t.narration not in result.output


def test_rows_filters_by_category_account_and_amount(cloud, migrated_db):
    build(migrated_db)

    def count(*args):
        result = runner.invoke(app, ["rows", *args])
        assert result.exit_code == 0, result.output
        return words(result.output)[-2]

    assert count("--category", "groceries") == "(1 row)"
    assert count("2026-09", "--account", "sbi-card") == "(2 rows)"
    assert count("--min", "30000") == "(3 rows)"
    assert count() == "(18 rows)"


def test_rows_refuses_a_bad_month_or_amount(cloud):
    assert "Write the month as YYYY-MM" in runner.invoke(app, ["rows", "Sept"]).output
    result = runner.invoke(app, ["rows", "--min", "lots"])
    assert result.exit_code == 1
    assert "Write the amount in rupees" in result.output


def test_rows_prints_at_most_200(cloud, migrated_db):
    many = [txn(1 + n % 28, str(100 + n), "debit", f"SHOP {n}") for n in range(205)]
    store(migrated_db, "axis-bank", "", SEP1, SEP30, *many)

    result = runner.invoke(app, ["rows"])

    assert len(result.output.splitlines()) < 210
    assert "(200 of 205 rows shown. Narrow them with a month, --category, --account or --min.)" in (
        result.output
    )


def test_spread_add_list_and_remove(cloud, migrated_db):
    build(migrated_db)
    rent = rid(migrated_db, "RENT")

    added = runner.invoke(app, ["spread", "add", rent, "--months", "3"])
    listed = runner.invoke(app, ["spread", "list"])
    removed = runner.invoke(app, ["spread", "remove", "1"])

    assert added.exit_code == 0, added.output
    assert words(added.output) == [
        "Spread 1: 2026-09-04 axis-bank out 40,000.00 Rent, over 3 month(s):",
        "2026-09 13,333.33 / 2026-10 13,333.33 / 2026-11 13,333.34",
    ]
    assert words(listed.output)[0] == (
        f"1 {rent} 2026-09-04 axis-bank out 40,000.00 Rent from 2026-09 over 3 month(s)"
    )
    assert words(removed.output) == ["Removed spread 1: 2026-09-04 axis-bank out 40,000.00."]
    assert "No spreads yet" in runner.invoke(app, ["spread", "list"]).output


def test_spread_add_takes_a_start_month(cloud, migrated_db):
    build(migrated_db)
    builder = rid(migrated_db, "BUILDER")

    added = runner.invoke(app, ["spread", "add", builder, "--months", "2", "--start", "2026-07"])
    bad = runner.invoke(app, ["spread", "add", builder, "--months", "2", "--start", "July"])

    assert words(added.output)[1] == "2026-07 -5,000.00 / 2026-08 -5,000.00"
    assert bad.exit_code == 1
    assert "Write the month as YYYY-MM" in bad.output


def test_spread_add_explains_a_refusal(cloud, migrated_db):
    build(migrated_db)

    result = runner.invoke(app, ["spread", "add", rid(migrated_db, "NEW PAYEE"), "--months", "2"])

    assert result.exit_code == 1
    assert "no category" in result.output


def test_spread_list_warns_about_a_spread_that_no_longer_counts(cloud, migrated_db):
    build(migrated_db)
    runner.invoke(app, ["spread", "add", rid(migrated_db, "GROCER"), "--months", "2"])
    migrated_db.execute("delete from transactions where narration = 'GROCER'")

    result = runner.invoke(app, ["spread", "list"])

    assert (
        "Warning: spread 1 (2026-09-03 axis-bank out 3,456.75) does not count: its row is no "
        "longer counted, for example because its statement was replaced. Remove it with finos "
        "spread remove 1, then spread the new row."
    ) in words(result.output)
    assert "GROCER" not in result.output


def test_month_spread_lists_the_spread_months(cloud, migrated_db):
    build(migrated_db)
    runner.invoke(app, ["spread", "add", rid(migrated_db, "RENT"), "--months", "3"])

    result = runner.invoke(app, ["month", "--spread"])

    assert result.exit_code == 0, result.output
    lines = words(result.output)
    assert lines[0] == "Spread figures: a spread row counts in equal parts across its months."
    assert lines[2] == "2026-08 partial 0.00 500.00 -500.00 0.00"
    assert lines[3] == "2026-09 partial 1,51,200.50 47,490.08 1,03,710.42 20,000.00"
    assert lines[5] == "2026-11 partial 0.00 13,333.34 -13,333.34 0.00"
    # The cash list does not change.
    assert words(runner.invoke(app, ["month"]).output)[2].startswith(
        "2026-09 partial 1,51,200.50 74,156.75"
    )


def test_month_spread_shows_a_month_only_a_spread_reaches(cloud, migrated_db):
    build(migrated_db)
    runner.invoke(app, ["spread", "add", rid(migrated_db, "RENT"), "--months", "3"])

    cash = runner.invoke(app, ["month", "2026-11"])
    result = runner.invoke(app, ["month", "2026-11", "--spread"])

    assert "No statement covers 2026-11." in cash.output
    lines = words(result.output)
    assert lines[0] == "Spread figures: a spread row counts in equal parts across its months."
    assert "2026-11 partial: no statement covers this month" in lines
    assert "Rent 13,333.34" in lines


def test_month_spread_warns_about_spread_problems(cloud, migrated_db):
    build(migrated_db)
    runner.invoke(app, ["spread", "add", rid(migrated_db, "GROCER"), "--months", "2"])
    migrated_db.execute("delete from transactions where narration = 'GROCER'")

    one = runner.invoke(app, ["month", "2026-09", "--spread"])
    listed = runner.invoke(app, ["month", "--spread"])

    warning = "Spread problems: 1 spread(s) do not count. Run finos spread list."
    assert warning in words(one.output)
    assert warning in words(listed.output)
    assert "Spread problems" not in runner.invoke(app, ["month", "2026-09"]).output


def test_goal_commands(cloud, migrated_db):
    build(migrated_db)
    grocer, dinner = rid(migrated_db, "GROCER"), rid(migrated_db, "SEPTEMBER DINNER")

    added = runner.invoke(app, ["goal", "add", "House party", "6000"])
    assigned = runner.invoke(app, ["goal", "assign", "house party", grocer, dinner])
    listed = runner.invoke(app, ["goal", "list"])
    shown = runner.invoke(app, ["goal", "show", "1"])
    freed = runner.invoke(app, ["goal", "unassign", dinner])
    removed = runner.invoke(app, ["goal", "remove", "House party"])

    assert words(added.output) == ["Added goal 1: House party, budget 6,000.00."]
    assert words(assigned.output) == ["House party: 2 row(s) assigned."]
    assert words(listed.output) == [
        "# Goal Budget Spent Remaining Rows",
        "1 House party 6,000.00 4,956.75 1,043.25 2",
    ]
    assert words(shown.output) == [
        "Goal 1: House party, budget 6,000.00",
        "2026-09 2 row(s) spent 4,956.75 to date 4,956.75 remaining 1,043.25",
        "Total 2 row(s) spent 4,956.75 remaining 1,043.25",
    ]
    assert words(freed.output) == ["Removed 1 row(s) from their goal."]
    assert words(removed.output) == ["Removed the goal House party."]
    assert "No goals yet" in runner.invoke(app, ["goal", "list"]).output
    for t, _ in BANK + CARD:
        for output in (assigned, listed, shown):
            assert t.narration not in output.output


def test_goal_add_refuses_a_bad_budget(cloud):
    result = runner.invoke(app, ["goal", "add", "Trip", "lots"])

    assert result.exit_code == 1
    assert "Write the budget in rupees" in result.output


def test_goal_show_warns_about_a_row_that_no_longer_counts(cloud, migrated_db):
    build(migrated_db)
    runner.invoke(app, ["goal", "add", "House party", "6000"])
    runner.invoke(app, ["goal", "assign", "1", rid(migrated_db, "GROCER")])
    migrated_db.execute("delete from transactions where narration = 'GROCER'")

    result = runner.invoke(app, ["goal", "show", "House party"])

    assert (
        "Warning: a row of this goal (2026-09-03 axis-bank out 3,456.75) does not count: its row "
        "is no longer counted, for example because its statement was replaced."
    ) in words(result.output)


def test_goal_show_refuses_an_unknown_goal(cloud):
    result = runner.invoke(app, ["goal", "show", "Beach"])

    assert result.exit_code == 1
    assert 'No goal is named "Beach"' in result.output


# --- eval ----------------------------------------------------------------------------------

HAIKU = "claude-haiku-5-5"


def test_eval_dry_run_lists_and_estimates_without_doppler_drive_or_claude(cloud, monkeypatch):
    assert runner.invoke(app, ["sync"]).exit_code == 0
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))
    # Any request to these hosts now fails the command.
    cloud.update({"api.doppler.com", "www.googleapis.com"})

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--dry-run"])

    assert result.exit_code == 0, result.output
    assert f"Statements to transcribe again with {HAIKU}: 1" in result.output
    assert "2026-02-13 to 2026-03-12 hdfc-tataneu *4321" in result.output
    assert "reference claude-opus-5-5" in result.output
    assert "Estimated cost: up to $" in result.output
    assert "No Claude call was made." in result.output


def test_eval_without_yes_shows_the_estimate_and_calls_nothing(cloud, monkeypatch):
    runner.invoke(app, ["sync"])
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))
    cloud.update({"api.doppler.com", "www.googleapis.com"})

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--categories"])

    assert result.exit_code == 0, result.output
    assert "Categories to ask again: 2 row(s) in 1 call(s)" in result.output
    assert "Run again with --yes" in result.output


def test_eval_refuses_an_estimate_above_the_budget_left(cloud, monkeypatch):
    runner.invoke(app, ["sync"])
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))
    monkeypatch.setenv("FINOS_AI_BUDGET_USD", "0.02")

    result = runner.invoke(app, ["eval", "--model", "claude-opus-5-5", "--yes"])

    assert result.exit_code == 1
    assert "more than the $0.00 left" in result.output


def test_eval_with_nothing_to_compare(cloud, monkeypatch):
    monkeypatch.setattr(Claude, "from_key", staticmethod(no_claude))

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--yes"])

    assert result.exit_code == 0
    assert "No verified statements to compare" in result.output


def record_tables(db):
    tables = ("statements", "transactions", "extractions", "categorisations")
    return [db.execute(f"select * from {t} order by 1") for t in tables]  # noqa: S608


def test_eval_with_yes_compares_records_the_calls_and_changes_no_record(
    cloud, migrated_db, monkeypatch
):
    runner.invoke(app, ["sync"])
    before = record_tables(migrated_db)
    haiku_categories = {
        "results": [
            {"ref": 1, "counterparty": "Card", "category": "Own accounts", "confidence": "high",
             "reason": "bill"},
            {"ref": 2, "counterparty": "Shop", "category": "Groceries", "confidence": "high",
             "reason": "shop"},
        ]
    }  # fmt: skip
    claude_answering(
        monkeypatch,
        message(json.dumps(GOOD), model=HAIKU),
        message(json.dumps(haiku_categories), model=HAIKU),
    )

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--categories", "--yes"])

    assert result.exit_code == 0, result.output
    assert record_tables(migrated_db) == before
    out = words(result.output)
    assert (
        "compared 2026-02-13 to 2026-03-12 hdfc-tataneu *4321: 2 of 2 row(s) match (100%); 0 "
        "amount mismatch(es), 0 missing, 0 extra; balances equal; checks passed"
    ) in out
    assert "Rows matched: 2 of 2 (100%). Checks passed: 1 of 1." in out
    assert "Categories agreed: 1 of 2 (50%); on rows you confirmed: 0 of 0." in out
    assert "Cost: $0.0004 in 2 call(s)." in out
    usage = migrated_db.execute("select purpose from ai_usage where model = %s", [HAIKU])
    assert sorted(r["purpose"] for r in usage) == ["eval-categorise", "eval-extract"]
    assert len(migrated_db.execute("select id from eval_runs")) == 1
    for narration in ("PAYMENT RECEIVED", "AMAZON PAY"):
        assert narration not in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_eval_names_a_skipped_file(cloud, migrated_db, monkeypatch):
    runner.invoke(app, ["sync"])
    # Drive now holds other bytes under the recorded ID.
    migrated_db.execute("update drive_files set drive_md5 = 'changed'")
    claude_answering(monkeypatch)

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--yes"])

    assert result.exit_code == 0, result.output
    assert "skipped  2026-02-13 to 2026-03-12 hdfc-tataneu *4321" in result.output
    assert "did not download intact" in result.output
    assert "0 statement(s) compared, 1 skipped." in result.output


def test_eval_exits_non_zero_when_the_budget_stops_it(cloud, migrated_db, monkeypatch):
    runner.invoke(app, ["sync"])
    monkeypatch.setenv("FINOS_AI_BUDGET_USD", "0.05")
    migrated_db.execute(
        "insert into ai_usage (purpose, model, input_tokens, output_tokens, cost_usd) "
        "values ('categorise', 'claude-opus-5-5', 1, 1, 0.030)"
    )
    # The sync spent $0.016. The first answer costs $0.008, so the retry and the categories
    # meet the budget.
    claude_answering(monkeypatch, message(json.dumps(MISREAD)))

    result = runner.invoke(app, ["eval", "--model", HAIKU, "--categories", "--yes"])

    assert result.exit_code == 1, result.output
    assert "checks failed" in result.output
    assert "Stopped: AI spend this month" in result.output


def test_lines_shows_the_lines_around_a_phrase_with_their_page(cloud, monkeypatch):
    pages = [["Statement header", "Opening 100.00"], ["Row one", "EMI PLAN 414.72", "Row three"]]
    monkeypatch.setattr(cli.Drive, "download", lambda self, file: make_pdf(pages))

    result = runner.invoke(app, ["lines", "hdfc-mar.pdf", "414.72"])

    assert result.exit_code == 0, result.output
    assert "p2  Row one\np2  EMI PLAN 414.72\np2  Row three" in result.output
    assert "Statement header" not in result.output


def test_lines_context_zero_shows_only_the_matching_lines(cloud, monkeypatch):
    pages = [["a 1.00", "EMI 414.72", "b 2.00", "c 3.00", "credit 414.72"]]
    monkeypatch.setattr(cli.Drive, "download", lambda self, file: make_pdf(pages))

    result = runner.invoke(app, ["lines", "hdfc-mar.pdf", "414.72", "--context", "0"])

    assert result.exit_code == 0, result.output
    assert "p1  EMI 414.72\n--\np1  credit 414.72" in result.output
    assert "b 2.00" not in result.output


def test_lines_says_when_nothing_matches(cloud, monkeypatch):
    monkeypatch.setattr(cli.Drive, "download", lambda self, file: make_pdf([["nothing here"]]))

    result = runner.invoke(app, ["lines", "hdfc-mar.pdf", "414.72"])

    assert result.exit_code == 1
    assert 'No line of hdfc-mar.pdf contains "414.72".' in result.output


def test_lines_needs_a_file_that_is_in_the_folder(cloud):
    result = runner.invoke(app, ["lines", "not-there.pdf", "414.72"])

    assert result.exit_code == 1
    assert 'No PDF named "not-there.pdf"' in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output
