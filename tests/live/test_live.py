"""Live checks against the real Neon, Doppler and Drive of a configured cloud session.

Free: no Claude call and no write. Each test runs a finos command the way the monthly routine
does and checks only its shape, so no figure from the record is pinned in the repository.
Skipped unless FINOS_LIVE=1: FINOS_LIVE=1 uv run pytest tests/live
"""

import os

import pytest
from typer.testing import CliRunner

from finos.cli import app

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("FINOS_LIVE") != "1", reason="set FINOS_LIVE=1"),
]

runner = CliRunner()


def run(*args: str):
    result = runner.invoke(app, list(args))
    assert "Traceback" not in result.output, result.output
    return result


def test_check_reaches_the_database_doppler_and_drive():
    result = run("check")

    assert result.exit_code == 0, result.output
    assert "database   ok" in result.output
    assert "drive      ok" in result.output


def test_identify_names_a_profile_for_each_source():
    result = run("identify")

    assert "file(s);" in result.output
    names = {"axis-bank", "canara-bank", "hdfc-tataneu", "sbi-bank", "sbi-card"}
    found = {line.split()[0] for line in result.output.splitlines() if line.strip()}
    assert names <= found, result.output


def test_status_shows_no_flagged_statement_and_an_empty_review_queue():
    result = run("status")

    assert result.exit_code == 0, result.output
    assert " flagged " not in result.output
    assert "0 to review" in result.output


def test_month_lists_a_complete_month():
    result = run("month")

    assert result.exit_code == 0, result.output
    assert " complete " in result.output


def test_a_read_only_query_cannot_write():
    result = run("sql", "create table live_probe (x int)")

    assert result.exit_code != 0
