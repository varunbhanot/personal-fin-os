"""Applies the SQL files in finos/migrations in order, each exactly once."""

import re
from importlib import resources

from finos.db import NeonHttpDb

_STATEMENT_END = re.compile(r";\s*$", re.MULTILINE)


def migrate(db: NeonHttpDb) -> list[str]:
    """Apply pending migrations and return their names."""
    db.execute(
        "create table if not exists schema_migrations ("
        "version text primary key, applied_at timestamptz not null default now())"
    )
    applied = {row["version"] for row in db.execute("select version from schema_migrations")}

    pending = []
    for name, sql in _migrations():
        if name in applied:
            continue
        # One migration is one transaction: it applies completely or not at all.
        queries = [(statement, []) for statement in _statements(sql)]
        queries.append(("insert into schema_migrations (version) values (%s)", [name]))
        db.batch(queries)
        pending.append(name)
    return pending


def _strip_comment(line: str) -> str:
    """Drop a -- comment that is not inside a quoted string."""
    quoted = False
    for i, char in enumerate(line):
        if char == "'":
            quoted = not quoted
        elif not quoted and line.startswith("--", i):
            return line[:i].rstrip()
    return line


def _migrations() -> list[tuple[str, str]]:
    folder = resources.files("finos") / "migrations"
    files = sorted(f for f in folder.iterdir() if f.name.endswith(".sql"))
    return [(f.name.removesuffix(".sql"), f.read_text()) for f in files]


def _statements(sql: str) -> list[str]:
    """Split a migration into statements, one per line ending in ";".

    A $$ ... $$ body (a DO block) stays whole, whatever its lines end in. Other dollar-quote
    tags ($body$) are not recognised: keep migrations to plain statements and $$ blocks.
    """
    statements: list[str] = []
    current: list[str] = []
    in_body = False
    for line in sql.splitlines():
        line = _strip_comment(line)
        current.append(line)
        if line.count("$$") % 2:
            in_body = not in_body
        if not in_body and _STATEMENT_END.search(line):
            statements.append("\n".join(current))
            current = []
    statements.append("\n".join(current))
    # SQL files use %s-free plain SQL; double any % so placeholder conversion leaves it alone.
    parts = [part.rstrip().removesuffix(";").strip() for part in statements]
    return [part.replace("%", "%%") for part in parts if part]
