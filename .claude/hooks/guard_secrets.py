#!/usr/bin/env python3
"""PreToolUse hook: keeps ad-hoc commands away from the hosts that hand out secrets.

The cloud environment's network secrets add credentials to every request for Doppler and
Neon's SQL endpoint, so any command could read secrets or the database by calling them. Only
finos commands should. This blocks the casual routes: curl and other tools, ad-hoc Python using
finos's secrets or database code, the doppler CLI, and WebFetch. It cannot stop a script file
that makes the call itself, so it is one layer, not the only one.

It also keeps Claude away from the laptop UI server (ui/server), which only the user runs: its
Keychain item, Node one-liners that load its secret or database modules, the ui and ui-check
scripts, its compiled entry points, requests to its port, and the launch link in the process
list.
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
# The laptop UI (ui/server) holds a Doppler token from the macOS Keychain, the Anthropic key and
# a Neon connection string in its memory. Only the user runs it, on the laptop (CLAUDE.md).
# Any Keychain password reader (by service or by account alone), a writer for its item or with a
# password on the command line, or one that unlocks, describes, dumps or exports a keychain.
KEYCHAIN = re.compile(
    r"\bsecurity\s+(dump-keychain|export|unlock-keychain|show-keychain-info"
    r"|find-(generic|internet)-password|set-(generic|internet)-password-partition-list)\b"
    r"|\bsecurity\s+add-generic-password\b.*(finos-ui|\s-w\s+\S)",
    re.IGNORECASE | re.DOTALL,
)
# Node, a TypeScript runner or another JS runtime, as a one-liner, a REPL or on stdin...
NODE_RUNNER = re.compile(
    r"\bnode\s+(-e|-p|--eval|--print|-i|--interactive)\b|\bnode\s+-(\s|$)|\bnode\s*<<"
    r"|\b(tsx|ts-node|bun|deno)\b"
)
# ...that reaches for the UI server's secret or database code.
UI_SECRET_CODE = re.compile(
    r"ui/server/src/(keychain|doppler|db|anthropic)|ui/server/dist/|NEON_READONLY_URL"
    r"|ANTHROPIC_KEY|find-generic-password|@neondatabase/serverless"
)
UI_RULES = [
    (re.compile(r"\bnpm\b.*\brun(-script)?\s+(ui|ui-check)(\s|$)"), "the UI server (ui, ui-check)"),
    (re.compile(r"\bnode\b.*\bdist/(boot|main)\.js\b"), "the UI server (dist/boot.js, main.js)"),
    (
        re.compile(r"\b(curl|wget)\b.*\b(127\.0\.0\.1|localhost):8765/(auth|api|agent)"),
        "a request to the UI server's port",
    ),
]
PROCESS_LIST = re.compile(r"\b(ps|pgrep)\b")
UI = "ui: "  # marks a UI rule, which has its own message
UI_PORT_URL = re.compile(r"(127\.0\.0\.1|localhost):8765(/|$)", re.IGNORECASE)
# Commands that only read local text: mentioning a host there is not calling it...
READ_ONLY = {"grep", "rg", "git", "sed", "cat", "head", "tail", "less", "wc", "echo", "printf"}
# ...unless a substitution inside them runs another command.
SUBSTITUTION = re.compile(r"\$\(|`|<\(")
SEGMENT = re.compile(r"&&|\|\||[;|\n]")


def runs_code(segment: str) -> bool:
    """False for an empty segment or a read-only command with no substitution in it."""
    words = segment.split()
    if not words:
        return False
    return words[0].rsplit("/", 1)[-1] not in READ_ONLY or bool(SUBSTITUTION.search(segment))


def blocked(tool: str, tool_input: dict) -> str | None:
    if tool == "WebFetch":
        url = str(tool_input.get("url") or "")
        if UI_PORT_URL.search(url):
            return UI + "a request to the UI server's port"
        return next((what for pattern, what in HOSTS if pattern.search(url)), None)
    if tool != "Bash":
        return None

    command = str(tool_input.get("command") or "")
    if DOPPLER_CLI.search(command):
        return "the doppler CLI"
    if PYTHON.search(command) and SECRET_CODE.search(command):
        return "finos's secrets or database code from ad-hoc Python"
    # Quotes and backslashes can split a name without changing what the shell runs; a
    # backslash-newline only continues the line.
    plain = re.sub(r"[\"'\\]", "", command.replace("\\\n", " "))
    active = [segment for segment in SEGMENT.split(plain) if runs_code(segment)]
    for segment in active:
        if KEYCHAIN.search(segment):
            return UI + "a Keychain reader or writer"
        for pattern, what in HOSTS:
            if pattern.search(segment):
                return what
        for pattern, what in UI_RULES:
            if pattern.search(segment):
                return UI + what
    # A pipe or a heredoc puts the code in another segment than the runner or the process
    # list, so the code and the launch link are looked for in the whole command.
    if any(NODE_RUNNER.search(segment) for segment in active) and UI_SECRET_CODE.search(plain):
        return UI + "the UI server's secret or database code from an ad-hoc Node command"
    if any(PROCESS_LIST.search(segment) for segment in active) and "auth?t=" in plain:
        return UI + "a search of the process list for the launch link"
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
    if what.startswith(UI):
        print(
            f"Blocked: this runs {what.removeprefix(UI)}. The laptop UI server (ui/server), its "
            "Keychain item and its port are for the user only: on the laptop the user runs ui "
            "and ui-check, and a cloud session never runs them. See CLAUDE.md, 'Secrets'.",
            file=sys.stderr,
        )
        return 2
    print(
        f"Blocked: this calls {what} directly. Secrets and the database are read only by "
        "finos commands (uv run finos ...), so their values never reach the transcript. "
        "See CLAUDE.md, 'Secrets'.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
