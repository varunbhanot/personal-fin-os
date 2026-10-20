"""The project skills run the monthly routine in a session: only through finos commands."""

import re
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parent.parent / ".claude" / "skills"
NAMES = ("import", "month")
_FENCE = re.compile(r"```(?:bash|sh)?\n(.*?)```", re.DOTALL)
_INLINE = re.compile(r"`([^`\n]+)`")


def text(name: str) -> str:
    return (SKILLS / name / "SKILL.md").read_text()


@pytest.mark.parametrize("name", NAMES)
def test_a_skill_has_front_matter_with_its_name_and_a_description(name):
    head = text(name).split("---")
    assert head[0] == ""
    fields = dict(line.split(": ", 1) for line in head[1].strip().splitlines())
    assert fields["name"] == name
    assert len(fields["description"]) > 40


@pytest.mark.parametrize("name", NAMES)
def test_a_skill_never_names_a_way_around_finos(name):
    body = text(name)
    for banned in ("api.doppler.com", "/sql", "ANTHROPIC_API_KEY", "api.anthropic.com", "curl"):
        assert banned not in body


@pytest.mark.parametrize("name", NAMES)
def test_every_shell_command_in_a_skill_is_a_finos_command(name):
    body = text(name)
    blocks = _FENCE.findall(body)
    assert blocks
    for block in blocks:
        for line in block.splitlines():
            if line.strip():
                assert line.strip().startswith("uv run finos "), line
    for inline in _INLINE.findall(body):
        if inline.startswith(("uv ", "python", "psql", "bash", "sh ")):
            assert inline.startswith("uv run finos "), inline


def test_the_import_skill_asks_before_the_paid_sync():
    body = text("import")
    ask = body.index("**Ask the user** whether to run the import")
    assert ask < body.index("uv run finos sync\n")
