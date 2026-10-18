#!/bin/bash
# Prepares the ECC plugin (ecc@ecc, declared in .claude/settings.json) for Claude Code cloud sessions.
# The plugin installer skips ECC's npm dependencies, and ECC's own hooks fail without them
# (js-yaml, ajv, @iarna/toml, sql.js), so they are installed here.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

warn() {
  echo "session-start: $*" >&2
}

cd "$project_dir"

# Both commands are no-ops when the marketplace and plugin are already present.
claude plugin marketplace add affaan-m/ECC --scope project || warn "could not add the ECC marketplace"
claude plugin install ecc@ecc --scope project || warn "could not install ecc@ecc"

plugin_dir="$(node -e '
const [file, project] = process.argv.slice(1);
let entries = [];
try {
  entries = JSON.parse(require("fs").readFileSync(file, "utf8")).plugins["ecc@ecc"] || [];
} catch (_) {}
const hit = entries.find((e) => e.scope === "project" && e.projectPath === project) || entries[0];
if (hit) console.log(hit.installPath);
' "$config_dir/plugins/installed_plugins.json" "$project_dir" || true)"

if [ -z "$plugin_dir" ] || [ ! -d "$plugin_dir" ]; then
  warn "ecc@ecc is not installed, skipping dependency install"
  exit 0
fi

# npm writes this file on install, so its presence means the dependencies are already in place.
if [ ! -f "$plugin_dir/node_modules/.package-lock.json" ]; then
  (cd "$plugin_dir" && npm install --omit=dev --ignore-scripts --no-audit --no-fund) \
    || warn "could not install ECC dependencies; ECC's SessionStart hook will fail until they are present"
fi
