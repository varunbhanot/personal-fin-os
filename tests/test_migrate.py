import re
import uuid

import httpx
import psycopg

from finos.db import NeonHttpDb
from finos.migrate import _migrations, _statements, _strip_comment, migrate

from .conftest import NEON_SQL_URL, NeonEmulator


def test_each_line_ending_in_a_semicolon_ends_a_statement():
    sql = "create table a (x int);\n\n-- a comment; with a semicolon\ncreate view b as\nselect 1;\n"

    assert _statements(sql) == ["create table a (x int)", "create view b as\nselect 1"]


def test_a_do_block_with_semicolons_inside_stays_one_statement():
    sql = (
        "create table a (x int);\n"
        "do $$ begin\n"
        "  if not exists (select from pg_roles where rolname = 'r') then\n"
        "    create role r nologin;\n"
        "  end if;\n"
        "end $$;\n"
        "grant usage on schema public to r;\n"
    )

    assert _statements(sql) == [
        "create table a (x int)",
        "do $$ begin\n"
        "  if not exists (select from pg_roles where rolname = 'r') then\n"
        "    create role r nologin;\n"
        "  end if;\n"
        "end $$",
        "grant usage on schema public to r",
    ]


def test_a_percent_sign_is_doubled_for_placeholder_conversion():
    assert _statements("select '100%';\n") == ["select '100%%'"]


def _old_split(sql: str) -> list[str]:
    """The splitter before dollar quotes: one statement per line ending in ";"."""
    text = "\n".join(_strip_comment(line) for line in sql.splitlines())
    parts = re.split(r";\s*$", text, flags=re.MULTILINE)
    return [part.strip().replace("%", "%%") for part in parts if part.strip()]


def test_the_migrations_without_dollar_quotes_split_as_before():
    plain = [(name, sql) for name, sql in _migrations() if "$$" not in sql]

    assert len(plain) >= 7
    for name, sql in plain:
        assert _statements(sql) == _old_split(sql), name


def test_all_migrations_apply_to_two_databases_of_one_cluster(pg_admin_url):
    """Roles are cluster-wide: the second database must not fail on the role 0008 creates."""
    names = [f"t_{uuid.uuid4().hex[:12]}" for _ in range(2)]
    try:
        for name in names:
            with psycopg.connect(pg_admin_url, autocommit=True) as conn:
                conn.execute(f'create database "{name}"')
            url = pg_admin_url.replace("/postgres?", f"/{name}?", 1)
            with httpx.Client(transport=httpx.MockTransport(NeonEmulator(url))) as client:
                db = NeonHttpDb(NEON_SQL_URL, client)
                applied = migrate(db)
                assert applied[-1] == "0008_ui_access"
                assert migrate(db) == []
    finally:
        with psycopg.connect(pg_admin_url, autocommit=True) as conn:
            for name in names:
                conn.execute(f'drop database if exists "{name}" with (force)')
