import functools
import hashlib
import json
from decimal import Decimal

import httpx
import pytest
from typer.testing import CliRunner

from finos import cli
from finos.ai import Claude
from finos.cli import app
from finos.db import NeonHttpDb

from .test_ai import FakeMessages, message
from .test_extract import GOOD
from .test_sync import HDFC_PDF

runner = CliRunner()
SECRETS_JSON = {
    "PW_AXIS_BANK": "test-pw-axis",
    "PW_HDFC_TATANEU": "test-pw-hdfc",
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
        return Claude(FakeMessages(message(json.dumps(GOOD))), db, budget_usd=budget_usd)

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


def test_sync_then_status(cloud):
    first = runner.invoke(app, ["sync"])
    second = runner.invoke(app, ["sync"])
    report = runner.invoke(app, ["status"])

    assert first.exit_code == 0, first.output
    assert "imported  hdfc-mar.pdf" in first.output
    assert "unchanged hdfc-mar.pdf" in second.output
    assert "2026-03  hdfc-tataneu   *4321  ok         2 transactions" in report.output
    assert "AI spend: $0.0080 this month" in report.output
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

    for command in ("check", "identify", "sync", "status"):
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
    assert "hdfc-tataneu  hdfc-mar.pdf" in result.output
    assert "1 file(s); 0 failed." in result.output
    for value in SECRETS_JSON.values():
        assert value not in result.output


def test_identify_exits_non_zero_when_a_file_fails(cloud, monkeypatch):
    monkeypatch.setitem(SECRETS_JSON, "PW_HDFC_TATANEU", "pw-not-this-one")

    result = runner.invoke(app, ["identify"])

    assert result.exit_code == 1
    assert "failed        hdfc-mar.pdf" in result.output
    assert "None of the 3 statement passwords" in result.output
    assert "pw-not-this-one" not in result.output


def test_identify_with_no_pdfs_explains_what_to_check(cloud, monkeypatch):
    monkeypatch.setattr(cli.Drive, "list_pdfs", lambda self: [])

    result = runner.invoke(app, ["identify"])

    assert result.exit_code == 1
    assert "No PDFs" in result.output
    assert "FINOS_DRIVE_FOLDER_ID" in result.output
