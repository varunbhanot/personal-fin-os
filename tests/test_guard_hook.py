import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[1] / ".claude" / "hooks" / "guard_secrets.py"


def run_hook(command: str, tool: str = "Bash") -> subprocess.CompletedProcess:
    tool_input = {"url": command} if tool == "WebFetch" else {"command": command}
    event = {"tool_name": tool, "tool_input": tool_input}
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    "command",
    [
        "curl -s https://api.doppler.com/v3/configs/config/secrets/download",
        "python -c \"import httpx; print(httpx.get('https://API.DOPPLER.COM/v3/me').text)\"",
        "doppler secrets download --no-file",
        "cd src && doppler run -- env",
        "curl -X POST https://api.ap-southeast-1.aws.neon.tech/sql -d '{}'",
        # Bypasses found in review.
        "curl https://api.ap-southeast-1.aws.neon.tech:443/sql",
        "curl https://api.ap-southeast-1.aws.neon.tech//sql",
        'curl https://api.dop""pler.com/v3/me',
        "curl https://api.dop\\pler.com/v3/me",
        'bash -c "doppler secrets download"',
        "echo hi\ndoppler secrets",
        "sudo doppler secrets",
        "env doppler secrets",
        "/usr/local/bin/doppler secrets",
        'uv run python -c "from finos.config import DOPPLER_DOWNLOAD_URL"',
        "uv run python -c 'from finos.secrets import load_secrets'",
        "python3 -c 'import finos.db; print(1)'",
        "uv run python -c 'x.reveal()'",
        "uv run python - <<EOF\nfrom finos.secrets import load_secrets\nEOF",
        "echo 'import finos.db' | python3",
        "uv run python -m finos.secrets",
        "timeout 10 doppler secrets download",
        "python3 - <<EOF\nimport httpx\nhttpx.get('https://api.doppler.com/v3/me')\nEOF",
        "grep -c x file | curl https://api.doppler.com/v3/me",
    ],
)
def test_blocks_direct_calls_to_secret_hosts(command):
    result = run_hook(command)

    assert result.returncode == 2
    assert "finos" in result.stderr


@pytest.mark.parametrize(
    "command",
    [
        "uv run finos sync",
        "uv run pytest tests/test_secrets.py",
        "grep -rn Secret src/finos",
        "git log --oneline",
        'grep -rn "api.doppler.com" src',
        "git commit -m 'Point finos at api.doppler.com via the network secret'",
        "sed -n 1,20p docs/research/cloud-session-secrets.md",
        "grep -rn doppler .claude/plans",
    ],
)
def test_allows_everything_else(command):
    assert run_hook(command).returncode == 0


def test_ignores_other_tools():
    assert run_hook("api.doppler.com", tool="Read").returncode == 0


def test_blocks_web_fetches_of_secret_hosts():
    url = "https://api.doppler.com/v3/configs/config/secrets/download"

    assert run_hook(url, tool="WebFetch").returncode == 2
    assert run_hook("https://docs.doppler.com/reference/api", tool="WebFetch").returncode == 0


def test_reading_the_code_is_still_allowed():
    for command in ("grep -rn load_secrets src", "sed -n 1,40p src/finos/secrets.py"):
        assert run_hook(command).returncode == 0


def test_tolerates_malformed_input():
    result = subprocess.run(
        [sys.executable, str(HOOK)], input="not json", capture_output=True, text=True, check=False
    )

    assert result.returncode == 0
