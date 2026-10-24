"""Live check of migrations 0008 and 0009 on the real Neon, as the UI's group role sees them.

No cloud test can connect as the login role finos_ui: the cloud proxy adds the owner's
Neon-Connection-String. finos code instead runs "set local role finos_ui_access" inside one
NeonHttpDb.batch, so the queries after it have only that role's grants, and the role ends with
the batch. Each view is read with "limit 0": no row reaches the output. Free; it changes nothing.
Skipped unless FINOS_LIVE=1: FINOS_LIVE=1 uv run pytest tests/live/test_ui_grants.py
"""

import os

import pytest

from finos.cli import _db
from finos.errors import DbError

from ..test_ui_views import GRANTED_VIEWS, REFUSED

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("FINOS_LIVE") != "1", reason="set FINOS_LIVE=1"),
]

AS_UI = ("set local role finos_ui_access", [])


def test_the_ui_role_reads_each_granted_view():
    with _db() as db:
        results = db.batch(
            [AS_UI, *((f"select * from {view} limit 0", []) for view in GRANTED_VIEWS)]  # noqa: S608
        )

    assert len(results) == 1 + len(GRANTED_VIEWS)


@pytest.mark.parametrize("table", ["transactions", *REFUSED[1:]])
def test_the_ui_role_cannot_read_the_tables(table):
    with _db() as db, pytest.raises(DbError, match="permission denied"):
        db.batch([AS_UI, (f"select 1 from {table} limit 0", [])])  # noqa: S608 - a fixed name


def test_ai_usage_has_the_text_constraint_of_migration_0009():
    """0009 adds it apart from 0008, which the real database may have run before the edit."""
    with _db() as db:
        found = db.execute(
            "select count(*)::int as n from pg_constraint "
            "where conname = 'ai_usage_text' and conrelid = 'ai_usage'::regclass"
        )

    assert found == [{"n": 1}]
