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
8. Claude's answer stands unless it breaks a rule (such as money out marked as income) or Claude is unsure about a payment of ₹10,000 or more (`FINOS_REVIEW_MIN_INR`). Only those wait in `finos review`. You accept a group with `finos accept <id>` or change it with `finos correct <id> "<category>"`, and later rows from that payee, in that direction (money in or out), follow your answer. Corrections are counted, to measure accuracy. Your own name and "Unknown" are never remembered as payees; their rows are recognised by their narration text instead. For the same reason, the ID of a group of either name changes only that group's rows, and `finos recategorise <row-id>... "<category>"` changes single rows from `finos rows`.
9. `finos month` shows each month's income, expenses by category, savings and investments, from SQL views in the database (`v_monthly_summary`, `v_monthly_by_category`, `v_month_coverage` and `v_transactions`). A row counts in the month of its date. Linked transfers and "Own accounts" rows count as neither income nor spending. An expense category on money in is a refund and reduces that category. Investments show apart, as money in, money out and net. Each month shows how many days each account's statements cover, so a partial month is never read as a whole one. `finos sql` runs one read-only query on the record. It costs nothing, and the views hold no narration.
10. `finos spread add <row-id> --months N` counts one row's value in equal parts across N months (1 to 60), such as a quarterly school fee. The parts are in paise and the last month takes what is left, so they add up to the row. Money in spreads too: with `--start`, a refund can be set against the earlier months it pays for. The start is at most 60 months before or after the month of the row. The cash figures do not change; `finos month --spread` shows the spread figures from spread versions of the views (`v_monthly_summary_spread`, `v_monthly_by_category_spread`, `v_transactions_spread`). `finos rows` lists the row IDs, without a narration.
11. `finos goal` keeps a budget for something you spend on over months, such as a trip. You give it expense rows (and their refunds) by ID, and `finos goal show` gives the spending month by month, the running total and what is left (`v_goal_progress`). Goal names live in the database only. A spread or goal row whose statement was replaced no longer counts; `finos spread list`, `finos goal show` and `finos month --spread` warn about it (`v_spread_problems`).
12. `finos eval --model <id>` compares another model, usually a cheaper one, with the verified record. It downloads each verified statement again, checks its SHA-256, transcribes it with that model and compares the rows by date, direction and amount; `--categories` also asks each confirmed category again, without memory. It shows an "up to" estimate first: `--dry-run` calls nothing, and only `--yes` makes the paid calls, refused when the estimate is more than the AI budget left this month. It writes nothing to the record: the calls go into `ai_usage` as `eval-extract` and `eval-categorise`, and each run leaves one row in `eval_runs`.
13. The project skills `/import` and `/month` (in `.claude/skills/`) run the monthly routine in a session: check, identify, ask, sync, review, then read the month. They use only `finos` commands.

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
                                        # with a name instead of an ID, --direction in|out changes one direction;
                                        # the ID of an Unknown or own-name group changes only that group's rows)
uv run finos recategorise <row-id>... "<category>"  # only these rows (IDs from finos rows); remembers no name
uv run finos notes                # household notes for Claude; notes add "<text>", notes remove <n>
uv run finos month                # free: every month's income, expenses, savings and investments
uv run finos month 2026-09        # one month: coverage, categories with refunds, and what is left out
uv run finos month --spread       # free: the same, with each spread row counted across its months
uv run finos sql "select * from v_monthly_summary"  # one read-only query; at most 200 rows printed
uv run finos rows 2026-09         # free: row IDs, dates, accounts, amounts, categories; never a narration
                                  # (filters: --category, --account <source>, --min <rupees>)
uv run finos spread add <id> --months 3 [--start YYYY-MM]  # count a row in equal parts across months
uv run finos spread list          # the spreads, with a warning for any that no longer count
uv run finos spread remove <n>    # by spread number or row ID
uv run finos goal add "<name>" <budget>  # then: goal assign <goal> <id>..., goal unassign <id>...
uv run finos goal list            # budget, spent, remaining and rows of each goal
uv run finos goal show <goal>     # month by month; goal remove <goal> drops the goal, not the rows
uv run finos eval --model claude-haiku-5-5 --dry-run  # free: the statements and the estimate
uv run finos eval --model claude-haiku-5-5 --yes      # paid: compare that model with the record
uv run pytest         # tests: a throwaway Postgres and fakes, no network or credentials
```

## Laptop UI (`ui/`)

The laptop UI is a local dashboard and a chat over the record. A Node server on your Mac serves it on `127.0.0.1`. The server reads only safe views of the database. It has no narration, handle or note. The setup steps are in [`docs/setup-guide.md`](docs/setup-guide.md), Part 10. The plan is in [`.claude/plans/bi-ui.plan.md`](.claude/plans/bi-ui.plan.md).

Only you run `ui` and `ui-check`, on the laptop. Claude never runs them.

```bash
npm --prefix ui run build        # once, and after each update: npm ci --ignore-scripts, then both builds
npm --prefix ui run ui-check     # the start checks, with no server: Keychain, Doppler, role, schema, budget
npm --prefix ui run ui           # start the server; the browser opens the dashboard
npm --prefix ui run check:server # optional: the server tests only
```

The next commands run in a cloud session. They need no secret and make no network call.

```bash
npm --prefix ui run check        # audit, types and tests for the server and the web app, and the web build
npm --prefix ui run fake         # the real app over the sample record, with a scripted fake Claude
npm --prefix ui run e2e          # Playwright smoke test in Chromium against the fake backend
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
