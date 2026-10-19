import hashlib
from decimal import Decimal

import httpx
import pytest

from finos.errors import BudgetExceeded
from finos.identify import load_profiles
from finos.inbox import Drive
from finos.report import status
from finos.secrets import Secret, Secrets
from finos.sync import Identified, identify_files, sync

from .pdfs import make_pdf
from .test_extract import GOOD, MISREAD, FakeClaude

HDFC_LINES = [
    "HDFC Bank Tata Neu Credit Card Statement",
    "Card XXXX XXXX XXXX 4321 Statement Period 13/02/2026 to 12/03/2026",
    "Previous Balance 2,000.00 Total Amount Due 1,499.50 Minimum Amount Due 75.00",
    "20/02/2026 PAYMENT RECEIVED 2,000.00 Cr",
    "02/03/2026 AMAZON PAY 1,499.50",
]
HDFC_PDF = make_pdf([HDFC_LINES], password="test-pw-hdfc")
KOTAK_PDF = make_pdf([["Kotak Mahindra Bank statement"]])
SECRETS = Secrets({"PW_HDFC_TATANEU": Secret("test-pw-hdfc"), "ANTHROPIC_KEY": Secret("sk-ant-x")})


def fake_drive(files: dict[str, bytes]) -> Drive:
    listing = [
        {"id": name, "name": f"{name}.pdf", "md5Checksum": hashlib.md5(body).hexdigest()}  # noqa: S324
        for name, body in files.items()
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("alt") == "media":
            return httpx.Response(200, content=files[request.url.path.rsplit("/", 1)[-1]])
        return httpx.Response(200, json={"files": listing})

    return Drive(httpx.Client(transport=httpx.MockTransport(handler)), "folder1")


def run(db, drive, claude, secrets=SECRETS):
    return sync(
        drive=drive,
        db=db,
        claude=claude,
        secrets=secrets,
        profiles=load_profiles(),
        model="claude-opus-5-5",
    )


def outcomes(results):
    return {r.name: r.outcome for r in results}


def test_first_run_imports_and_second_run_changes_nothing(migrated_db):
    drive = fake_drive({"hdfc-mar": HDFC_PDF, "kotak": KOTAK_PDF})
    claude = FakeClaude(GOOD)

    first = run(migrated_db, drive, claude)
    second = run(migrated_db, drive, claude)

    assert outcomes(first) == {"hdfc-mar.pdf": "imported", "kotak.pdf": "failed"}
    assert "no source profile" in {r.name: r.detail for r in first}["kotak.pdf"]
    assert outcomes(second) == {"hdfc-mar.pdf": "unchanged", "kotak.pdf": "failed"}
    assert len(claude.calls) == 1
    assert migrated_db.execute("select count(*) as n from transactions") == [{"n": 2}]


def test_a_statement_that_fails_its_checks_is_stored_as_flagged(migrated_db):
    drive = fake_drive({"hdfc-mar": HDFC_PDF})

    results = run(migrated_db, drive, FakeClaude(MISREAD, MISREAD))

    assert outcomes(results) == {"hdfc-mar.pdf": "flagged"}
    assert "totals:" in results[0].detail
    row = migrated_db.execute("select status from statements")[0]
    assert row == {"status": "flagged"}


def test_a_wrong_password_fails_that_file_only(migrated_db):
    drive = fake_drive({"hdfc-mar": HDFC_PDF})
    wrong = Secrets({"PW_HDFC_TATANEU": Secret("nope"), "ANTHROPIC_KEY": Secret("k")})

    results = run(migrated_db, drive, FakeClaude(), secrets=wrong)

    assert outcomes(results) == {"hdfc-mar.pdf": "failed"}
    assert "nope" not in results[0].detail
    assert migrated_db.execute("select count(*) as n from source_files") == [{"n": 0}]


def test_a_pdf_without_text_is_explained(migrated_db):
    blank = make_pdf([[]])

    results = run(migrated_db, fake_drive({"scan": blank}), FakeClaude())

    assert outcomes(results) == {"scan.pdf": "failed"}
    assert "no text" in results[0].detail


def test_reaching_the_budget_stops_the_run(migrated_db):
    drive = fake_drive(
        {"a-hdfc": HDFC_PDF, "b-hdfc": make_pdf([HDFC_LINES], password="test-pw-hdfc")}
    )
    claude = FakeClaude(BudgetExceeded("AI spend this month is at the limit"))

    results = run(migrated_db, drive, claude)

    assert outcomes(results) == {"a-hdfc.pdf": "failed", "b-hdfc.pdf": "skipped"}
    assert len(claude.calls) == 1


def test_status_summarises_statements_and_spend(migrated_db):
    run(migrated_db, fake_drive({"hdfc-mar": HDFC_PDF}), FakeClaude(GOOD))
    migrated_db.execute(
        "insert into ai_usage (purpose, model, input_tokens, output_tokens, cost_usd) "
        "values ('extract', 'claude-opus-5-5', 1, 1, 0.4200)"
    )

    report = status(migrated_db)

    assert [(s.month, s.source, s.status, s.transactions) for s in report.statements] == [
        ("2026-03", "hdfc-tataneu", "ok", 2)
    ]
    assert report.spent_this_month == Decimal("0.4200")
    assert report.spent_total == Decimal("0.4200")


@pytest.mark.parametrize("key", ["ANTHROPIC_KEY", "PW_HDFC_TATANEU"])
def test_secret_values_never_reach_the_results(migrated_db, key):
    results = run(migrated_db, fake_drive({"hdfc-mar": HDFC_PDF}), FakeClaude(GOOD))

    text = repr(results)
    assert SECRETS.get(key).reveal() not in text


def test_the_same_content_under_another_drive_name_is_not_extracted_again(migrated_db):
    claude = FakeClaude(GOOD)

    first = run(migrated_db, fake_drive({"hdfc-mar": HDFC_PDF, "hdfc-mar-copy": HDFC_PDF}), claude)
    second = run(migrated_db, fake_drive({"hdfc-mar": HDFC_PDF, "hdfc-mar-copy": HDFC_PDF}), claude)

    assert outcomes(first) == {"hdfc-mar.pdf": "imported", "hdfc-mar-copy.pdf": "unchanged"}
    assert outcomes(second) == {"hdfc-mar.pdf": "unchanged", "hdfc-mar-copy.pdf": "unchanged"}
    assert len(claude.calls) == 1


def test_an_unexpected_error_fails_one_file_and_the_run_continues(migrated_db):
    class Exploding(FakeClaude):
        def structured(self, **kwargs):
            if not self.calls:
                self.calls.append(kwargs)
                raise ArithmeticError("boom")
            return super().structured(**kwargs)

    drive = fake_drive(
        {"a-hdfc": make_pdf([HDFC_LINES], password="test-pw-hdfc"), "b-hdfc": HDFC_PDF}
    )
    seen: list = []

    results = sync(
        drive=drive,
        db=migrated_db,
        claude=Exploding(GOOD),
        secrets=SECRETS,
        profiles=load_profiles(),
        model="claude-opus-5-5",
        on_result=seen.append,
    )

    assert outcomes(results) == {"a-hdfc.pdf": "failed", "b-hdfc.pdf": "imported"}
    assert results[0].detail == "Unexpected ArithmeticError"
    assert seen == results


def test_retrying_flagged_statements(migrated_db):
    from finos.store import forget_flagged

    drive = fake_drive({"hdfc-mar": HDFC_PDF})
    run(migrated_db, drive, FakeClaude(MISREAD, MISREAD))

    assert forget_flagged(migrated_db) == 1
    results = run(migrated_db, drive, FakeClaude(GOOD))

    assert outcomes(results) == {"hdfc-mar.pdf": "imported"}
    assert migrated_db.execute("select status from statements") == [{"status": "ok"}]


def test_identify_names_each_files_profile_without_ai_or_database():
    drive = fake_drive({"hdfc-mar": HDFC_PDF, "kotak": KOTAK_PDF, "scan": make_pdf([[]])})
    seen: list = []

    # identify_files takes no database and no Claude client, so it cannot use either.
    results = identify_files(
        drive=drive, secrets=SECRETS, profiles=load_profiles(), on_result=seen.append
    )

    assert [(r.name, r.source) for r in results] == [
        ("hdfc-mar.pdf", "hdfc-tataneu"),
        ("kotak.pdf", None),
        ("scan.pdf", None),
    ]
    assert results[0] == Identified("hdfc-mar.pdf", "hdfc-tataneu", opened_with="PW_HDFC_TATANEU")
    assert "no source profile" in results[1].detail
    # A file that matches no profile still shows how it opened, so a new source's password
    # can be settled before its profile exists.
    assert results[1].opened_with == "no password"
    assert results[2].opened_with == "no password"
    assert "Missing markers" in results[1].detail
    assert "no text" in results[2].detail
    assert seen == results


def test_identify_reports_a_wrong_password_for_that_file_only():
    drive = fake_drive({"hdfc-mar": HDFC_PDF, "kotak": KOTAK_PDF})
    wrong = Secrets({"PW_HDFC_TATANEU": Secret("nope"), "ANTHROPIC_KEY": Secret("k")})

    results = identify_files(drive=drive, secrets=wrong, profiles=load_profiles())

    assert [(r.name, r.source) for r in results] == [("hdfc-mar.pdf", None), ("kotak.pdf", None)]
    assert "None of the 1 statement passwords" in results[0].detail
    assert results[0].opened_with == ""
    assert "nope" not in repr(results)


def test_identify_survives_an_unexpected_error(monkeypatch):
    from finos import sync as sync_module

    def explode(pdf):
        raise ArithmeticError("boom")

    monkeypatch.setattr(sync_module, "page_texts", explode)

    results = identify_files(
        drive=fake_drive({"hdfc-mar": HDFC_PDF}), secrets=SECRETS, profiles=load_profiles()
    )

    assert results == [
        Identified(
            "hdfc-mar.pdf", None, "Unexpected ArithmeticError", opened_with="PW_HDFC_TATANEU"
        )
    ]
