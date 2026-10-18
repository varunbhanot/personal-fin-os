#!/usr/bin/env python3
"""PreToolUse hook: keeps ad-hoc commands away from the hosts that hand out secrets.

The cloud environment's network secrets add credentials to every request for Doppler and
Neon's SQL endpoint, so any command could read secrets or the database by calling them. Only
finos commands should. This blocks the casual routes: curl and other tools, ad-hoc Python using
finos's secrets or database code, the doppler CLI, and WebFetch. It cannot stop a script file
that makes the call itself, so it is one layer, not the only one.
"""

import json
import re
import sys

HOSTS = [
    (re.compile(r"api\.doppler\.com", re.IGNORECASE), "Doppler's API"),
    (re.compile(r"neon\.tech(:\d+)?/+sql", re.IGNORECASE), "Neon's SQL endpoint"),
]
# The doppler CLI running one of its commands, however it is launched (sudo, env, timeout,
# bash -c, a full path).
DOPPLER_CLI = re.compile(
    r"\bdoppler\s+(secrets|run|configs?|setup|login|logout|me|configure|projects"
    r"|environments|activity|import|enclave|update)\b",
    re.IGNORECASE,
)
# Python run any way (-c, -m, a heredoc on stdin) that reaches for finos's secrets or database.
PYTHON = re.compile(r"\bpython[\d.]*\b", re.IGNORECASE)
SECRET_CODE = re.compile(
    r"finos\.(secrets|db|config)|load_secrets|NeonHttpDb|DOPPLER_DOWNLOAD_URL|doppler_url"
    r"|neon_sql_url|\.reveal\("
)
# Commands that only read local text: mentioning a host there is not calling it.
READ_ONLY = {"grep", "rg", "git", "sed", "cat", "head", "tail", "less", "wc", "echo", "printf"}
SEGMENT = re.compile(r"&&|\|\||[;|\n]")


def blocked(tool: str, tool_input: dict) -> str | None:
    if tool == "WebFetch":
        url = str(tool_input.get("url") or "")
        return next((what for pattern, what in HOSTS if pattern.search(url)), None)
    if tool != "Bash":
        return None

    command = str(tool_input.get("command") or "")
    if DOPPLER_CLI.search(command):
        return "the doppler CLI"
    if PYTHON.search(command) and SECRET_CODE.search(command):
        return "finos's secrets or database code from ad-hoc Python"
    # Quotes and backslashes can split a host name without changing what the shell runs.
    for segment in SEGMENT.split(re.sub(r"[\"'\\]", "", command)):
        words = segment.split()
        if not words or words[0].rsplit("/", 1)[-1] in READ_ONLY:
            continue
        for pattern, what in HOSTS:
            if pattern.search(segment):
                return what
    return None


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict):
        return 0
    what = blocked(str(event.get("tool_name") or ""), event.get("tool_input") or {})
    if what is None:
        return 0
    print(
        f"Blocked: this calls {what} directly. Secrets and the database are read only by "
        "finos commands (uv run finos ...), so their values never reach the transcript. "
        "See CLAUDE.md, 'Secrets'.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
