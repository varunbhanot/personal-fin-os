# personal-fin-os

A personal finance operating system.

## Branches

- `main` is the base branch. Start new work from it.
- `claude/*` branches hold work in progress and are merged back into `main`.

## Statement pipeline (`finos`)

`finos` turns the monthly bank and card statements saved in a Google Drive folder into a checked record in a Neon Postgres database. It runs in Claude Code cloud sessions. The plan is in [`.claude/plans/statement-pipeline.plan.md`](.claude/plans/statement-pipeline.plan.md), and the reasoning behind how secrets are handled is in [`docs/research/cloud-session-secrets.md`](docs/research/cloud-session-secrets.md).

How it works:

1. `finos sync` lists the PDFs in the Drive folder and skips any it has already imported.
2. It unlocks each new statement in memory with the statement passwords held in Doppler.
3. It recognises the bank or card from a profile in `src/finos/sources/`.
4. Claude transcribes every transaction. Code then checks the transcription against the statement's printed totals, its running balances and the PDF's own text.
5. A statement that passes is stored as `ok`. One that doesn't is stored as `flagged`, with the gap shown. Nothing is guessed.

### One-time setup

Do all of this in a browser, and never paste a secret into the chat. The full steps are in the plan, under "One-time setup".

1. **Cloud environment:** create one used only for this repo, with network access set to Custom.
2. **Neon:**
   - Create a project.
   - Add a **network secret**: allowed website = the endpoint host with its first label replaced by `api` (for example `api.c-2.<region>.aws.neon.tech`; `finos check` prints it), custom header `Neon-Connection-String`, prefix cleared, value = the connection string.
   - Set the environment variable `FINOS_NEON_HOST` to the endpoint host only, for example `ep-quiet-sky-123456.c-2.<region>.aws.neon.tech`. Newer projects have the `c-<N>` cell label; keep it.
3. **Doppler:**
   - In project `finos`, config `prd`, add `PW_HDFC_TATANEU` (and the other `PW_*` passwords) and `ANTHROPIC_KEY`. The key comes from a spend-capped Anthropic Console workspace.
   - Add a read-only service token as a **network secret**: type Bearer, allowed website `api.doppler.com`.
4. **Google Drive:**
   - Share the statements folder with a service account as Viewer, and set `FINOS_DRIVE_FOLDER_ID` to that folder's ID, not its parent's.
   - Give the service-account key to the network secrets form if it offers a Google type. Otherwise put it in Doppler as `GDRIVE_SA_JSON`.
5. **Optional:** `FINOS_AI_BUDGET_USD` (default 10), `FINOS_MODEL_EXTRACT` (default `claude-opus-5-5`).

Never set `ANTHROPIC_API_KEY` in the environment: Claude Code would use it for the whole session.

### Commands

```bash
uv run finos check    # settings, secret names, database and Drive folder; never prints values
uv run finos sync     # import new statements
uv run finos status   # statements by month and source, flagged problems, AI spend
uv run pytest         # tests: a throwaway Postgres and fakes, no network or credentials
```

## Using ECC

This repo loads the [ECC](https://github.com/affaan-m/ECC) plugin (`ecc@ecc`) in Claude Code sessions. There is nothing to install by hand.

- `.claude/settings.json` declares the plugin and registers a startup hook.
- `.claude/hooks/session-start.sh` runs only in cloud sessions. It makes sure the plugin is installed and installs ECC's npm dependencies, which the plugin installer skips.
- [`docs/ecc-project-flow.html`](docs/ecc-project-flow.html) shows how to take a project from an idea to a merged pull request. Open it in a browser.

Things to know:

- ECC is pinned to the release tag `v2.2.3`, because its hooks run in the same sessions that can reach the `finos` secrets. To update it, review the new release, then change the tag in `.claude/hooks/session-start.sh` (`ecc_ref`) and in `.claude/settings.json` (the `ref` for `ecc`).
- A tag is the strongest pin the plugin settings allow, since they don't accept a commit. A tag can be moved upstream, so if you need a firmer guarantee, check `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json` after an update.
- ECC's GateGuard hook asks for two facts before the first shell command of each session. To turn it off, set `ECC_GATEGUARD=off` in the environment.
- Keep statements and exports in `private/` or `statements/`. Both are git-ignored.
