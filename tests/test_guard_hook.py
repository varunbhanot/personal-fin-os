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


# --- the laptop UI (ui/server): only the user runs it, its Keychain item and its port --------


@pytest.mark.parametrize(
    "command",
    [
        "security find-generic-password -s finos-ui -a doppler -w",
        "/usr/bin/security find-generic-password -a doppler -s finos-ui -w ~/x.keychain-db",
        "security dump-keychain -d login.keychain-db",
        "security export -k login.keychain-db -t identities",
        "security add-generic-password -s finos-ui -a doppler -T '' -w dp.st.ui.abc",
        "security add-generic-password -s finos-ui -a doppler -T ''",
        "node -e \"import('./ui/server/src/doppler.ts')\"",
        "node -p 'require(\"./ui/server/dist/db.js\")'",
        "node --eval 'console.log(process.env.NEON_READONLY_URL)'",
        "node -e 'x' ANTHROPIC_KEY",
        "node - <<EOF\nimport '@neondatabase/serverless'\nEOF",
        "npx tsx ui/server/src/keychain.ts",
        "tsx ui/server/src/anthropic.ts",
        "ts-node ui/server/src/db.ts",
        "bun ui/server/src/doppler.ts",
        "deno run ui/server/src/db.ts",
        "node -e \"require('child_process').execSync('security find-generic-password')\"",
        "npm --prefix ui run ui",
        "npm --prefix ui run ui-check",
        "cd ui && npm run ui",
        "npm run-script ui-check --prefix ui",
        "node ui/server/dist/boot.js",
        "env -u NODE_OPTIONS node server/dist/main.js --check",
        "curl -s http://127.0.0.1:8765/api/meta",
        "curl 'http://127.0.0.1:8765/auth?t=abc'",
        "wget -qO- localhost:8765/agent",
        "ps aux | grep 'auth?t='",
        "pgrep -a open | grep auth?t=",
        # Found in review: a lookup by account only, a split item name, other readers, and a
        # read-only command that runs a reader through a substitution.
        "security find-generic-password -a doppler -w",
        'security find-generic-password -s fin""os-ui -w',
        "security find-internet-password -s example.com -w",
        "security unlock-keychain login.keychain-db",
        "security show-keychain-info login.keychain-db",
        "echo $(security find-generic-password -a doppler -w)",
        "echo `security find-generic-password -a doppler -w`",
        "security add-generic-password \\\n  -s finos-ui -a doppler -T ''",
        "echo 'import(\"./ui/server/src/keychain.ts\")' | node -",
    ],
)
def test_blocks_the_laptop_ui_server_its_keychain_item_and_its_port(command):
    result = run_hook(command)

    assert result.returncode == 2, command
    assert "ui" in result.stderr


@pytest.mark.parametrize(
    "command",
    [
        "npm --prefix ui run check",
        "npm --prefix ui run check:server",
        "npm --prefix ui run fake",
        "npm --prefix ui run e2e",
        "npm --prefix ui run build",
        "node ui/e2e/smoke.mjs",
        "node server/dist/fake.js --port 8791",
        "env -u NODE_OPTIONS -u NODE_PATH node server/dist/fake.js",
        "cd ui && npm --prefix web ci --ignore-scripts && npm --prefix server run build",
        "npm --prefix ui/server ci --ignore-scripts",
        "cd ui/server && npx vitest run test/db.test.ts",
        "cd ui/server && npx tsc --noEmit",
        "node scripts/audit.mjs",
        "grep -rn find-generic-password ui/server/src",
        "git commit -m 'Run npm --prefix ui run ui on the laptop'",
        "sed -n 1,40p ui/server/src/doppler.ts",
        "curl -s http://127.0.0.1:5173/",
        "ps aux",
        # Found in review: read-only commands that only mention a blocked command.
        "git commit -m 'Block security add-generic-password -s finos-ui -w x in the hook'",
        "git commit -m 'Block security find-generic-password -a doppler -w'",
        "grep -rn 'security export' .claude/hooks",
        "git commit -m 'Block tsx and node -e with ANTHROPIC_KEY'",
        "grep -rn 'tsx ui/server/src/keychain.ts' tests",
        "git commit -m 'Stop ps and pgrep searches for auth?t='",
        "grep -rn 'ps aux | grep auth?t=' tests",
    ],
)
def test_allows_the_ui_checks_builds_and_reading_the_code(command):
    assert run_hook(command).returncode == 0, command


@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:8765/api/health", "http://localhost:8765/auth?t=x"]
)
def test_blocks_web_fetches_of_the_ui_server(url):
    assert run_hook(url, tool="WebFetch").returncode == 2
