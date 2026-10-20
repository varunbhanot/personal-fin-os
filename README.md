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
6. `finos transfers` links the two halves of each move between your own accounts, such as a card bill paid from a bank account, so it is not counted as income or spending. A debit and a credit are linked only when the amounts are equal, the credit is 0 to 5 days later, one narration names the other account, and no other row fits as well. It costs nothing: it uses the database only.
7. `finos categorise` gives every other transaction a category from `src/finos/categories.yaml`, a counterparty and a confidence. Memory comes first: a row whose narration text or payee was seen before is categorised without a Claude call. The rest go to Claude in batches of 40, with your household notes and past corrections. `finos sync` runs this step after each import.
8. Claude's answer stands unless it breaks a rule (such as money out marked as income) or Claude is unsure about a payment of ₹10,000 or more (`FINOS_REVIEW_MIN_INR`). Only those wait in `finos review`. You accept a group with `finos accept <id>` or change it with `finos correct <id> "<category>"`, and later rows from that payee, in that direction (money in or out), follow your answer. Corrections are counted, to measure accuracy. Your own name and "Unknown" are never remembered as payees; their rows are recognised by their narration text instead.

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
5. **Optional:** `FINOS_AI_BUDGET_USD` (default 10), `FINOS_MODEL_EXTRACT` and `FINOS_MODEL_CATEGORISE` (both default `claude-opus-5-5`), `FINOS_REVIEW_MIN_INR` (default 10000: the smallest payment for which an unsure category waits for you).

Never set `ANTHROPIC_API_KEY` in the environment: Claude Code would use it for the whole session.

### Commands

```bash
uv run finos check    # settings, secret names, database and Drive folder; never prints values
uv run finos identify # free: which profile each Drive PDF matches, and which secret opened it
uv run finos sync     # import new statements
uv run finos status   # statements by month and source, flagged problems, transfers, AI spend
uv run finos transfers            # free: link own-account transfers; rows named by source, date and amount
uv run finos accounts             # accounts in the record, and your handles
uv run finos accounts add "<handle>"     # text that names you in a narration: UPI phone digits, your name
uv run finos accounts remove "<handle>"
uv run finos categorise --dry-run # free: rows to categorise, memory hits, Claude calls and a rough cost
uv run finos categorise           # paid: categorise new rows (memory first, then Claude)
uv run finos review               # the review queue by payee and direction, with IDs; never prints a narration
uv run finos review <id>          # one group's rows by date, account and amount
uv run finos accept <id> ...      # confirm Claude's category (or --all)
uv run finos correct <id> "<category>"  # change it; counted as a correction (--once: do not remember the name;
                                        # with a name instead of an ID, --direction in|out changes one direction)
uv run finos notes                # household notes for Claude; notes add "<text>", notes remove <n>
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
