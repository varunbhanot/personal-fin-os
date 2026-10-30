# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-30
- **Branch:** `claude/ui-start-diagnostics`, cut from `main` at `fedba3b`. It is not merged. Pull request 11 (`claude/bi-ui`) is merged into `main`.
- **Commits:** `5ff0851` (BI UI plan and migration 0008), `77d26b3` (UI server core), `a53df62` (handoff), `63dde65` (E2 to E5), `f95e628` (review fixes), `0cbe9f6` (zod 4.6.7), `779424a` (redesign), `d429b07` (start diagnostics), then the `get_stats` commit of 2026-10-30.
- **Plans:** `.claude/plans/bi-ui.plan.md` (BI UI, approved). `.claude/plans/statement-pipeline.plan.md` (parent of milestone 1).
- **Milestone 1:** "Trusted monthly record". The code and the back-fill are complete. Two acceptance items are open: the real `finos eval` run and the time of a normal month.
- **BI UI:** slices E1 to E5 and the visual redesign are on `main`. The UI runs on the laptop with the real record.

## 0. BI UI (branch `claude/bi-ui`)

### 0.1 Work that is complete

1. The plan is approved. The server is TypeScript (Node, Hono). The browser is React with our own chat component over AG-UI.
2. Migration 0008 adds safe views and the group role `finos_ui_access`. The views have no narration, reason, handle or note.
3. Migration 0009 adds a text check on `ai_usage`.
4. `ai.py` reads the monthly AI spend from `v_ai_spend`. The chat and `finos sync` share the $100 limit.
5. `ui/server` has the Keychain read, the Doppler download into memory, the read-only Neon client and the dashboard API.
6. The guard hook blocks Keychain reads and the launch link. CLAUDE.md has the laptop rules.
7. E2: `POST /agent` is the chat endpoint. It has six tools, the budget check before each model call and one `ai_usage` row for each call.
8. E3: `ui/web` is the React app. The dashboard page shows the KPIs, the trend, the categories, the goals, the spreads and the data health.
9. E4: the chat page reads the AG-UI stream and shows the KPI tiles, the charts and the tables from the tool results.
10. E5: `ui/package.json` has the `build`, `ui`, `ui-check`, `check`, `check:server`, `fake` and `e2e` scripts.
11. E5: the fake backend uses the synthetic record and a scripted fake Claude. The Playwright smoke test runs against it.
12. E5: `docs/setup-guide.md` Part 10 has the laptop steps. The README has the commands.
13. Each slice had a security review, a correctness review and a plan review. The confirmed findings are fixed.
14. All tests pass. They need no credentials. Section 0.4 has the counts.
15. A second session also built E2. Its review found six more problems. The fixes are ported, with tests:
    - A cost row that the database refuses is written before the next model call. Until then, the chat makes no call.
    - Only a normal end of an answer finishes a run. Any other stop gives an error.
    - One round runs at most 8 tool calls.
    - One tool result is at most 32,000 characters. `get_health` shows the last 12 months of coverage.
    - Each Neon request stops after 15 seconds.
    - The allow-list snapshot also holds the type of each column.
16. The other E2 build is on the local branch `claude/bi-ui-e2-alt`. It is not pushed. It is lost when the container is reset.
17. Both trees use zod 4.6.7. Both `audit-allow.json` files are empty. The production audit finds no advisory.
18. Pull request 11 is merged into `main`.
19. The web UI uses the design "FinTech Plataforma Financeira". The spec is in `ui/web/DESIGN.md`.
20. The redesign has a dark theme with gold accents and a light theme with an off-white page.
21. The icons are inline SVG in `ui/web/src/components/Icons.tsx`. The redesign adds no npm package.

22. Migrations 0008 and 0009 are on the Neon database.
23. The laptop setup is done: the role `finos_ui`, the config `ui`, the Keychain item and the shell profile. `ui-check` passes.
24. A failed start now shows the error class and a plain error code. It never shows the error message.
25. The laptop could not find the Neon host in DNS. Public DNS (`1.1.1.1`, `8.8.8.8`) fixed it. Part 10G of the setup guide tells the user how.
26. The chat has a seventh tool, `get_stats`. It gives the total, the average, the median and the highest and lowest month of one metric or one category.
27. `get_stats` does the arithmetic on the server in exact decimals. The prompt tells the model to use it and never to do arithmetic.
28. Part 10B of the setup guide sets the password with `alter role`, not with `\password`.

### 0.2 Work that is not complete

1. The branch `claude/ui-start-diagnostics` waits for a pull request into `main`.
2. `get_stats` has not run with the real model. Ask the chat for an average after the merge.

### 0.3 Known limits of the BI UI

1. `npm audit signatures` fails in a cloud session. The network blocks its download. The other check steps pass.
2. The web development tree has one high advisory in `undici` 7.30.0, through `jsdom` 28.1.0. It is only in the test tools, not in the built app. The production audit passes. Move `jsdom` when a fixed version is two weeks old and runs on the Node of the cloud container.
3. A password with `/`, `+` or `=` must be percent-encoded in `NEON_READONLY_URL`. Use a hex password (`openssl rand -hex 24`).
4. jsdom is 28.1.0, not 30.1.2. Version 30.1.2 needs Node 22.22.2 or later.
5. A model call that the API refuses before it streams (401, 429 or 529) writes no `ai_usage` row. The API does not charge for it.
6. The chat keeps one thread in server memory. A restart of the server forgets the chat.
7. The web bundle is about 749 kB (217 kB compressed). This is acceptable for a local app.
8. A cost row that waits to be written lives only in server memory. A restart of the server loses it, and the monthly spend is then too low by that call.
9. The CSP blocks font downloads. The UI shows Inter and JetBrains Mono only if the laptop has them. Otherwise it uses the system fonts.
10. `get_stats` rounds the average and the median to 0.01, half to even.

### 0.4 Test counts

1. Python: 773 tests pass. 19 live tests skip without `FINOS_LIVE=1`.
2. `ui/server`: 431 Vitest tests pass.
3. `ui/web`: 228 Vitest tests pass.
4. `npm --prefix ui run e2e`: 12 checks pass.

## 1. Status

### 1.1 Work that is complete

1. Pull request 7 (spread costs, goals, `finos eval`, `/import`, `/month`) is on `main`.
2. The back-fill is complete. The record has statements from January to October 2026 for the five accounts.
3. January to August 2026 are complete months. September and October are partial.
4. All statements have the status `ok`. 1,796 rows have a category. 0 rows wait for review.
5. 59 transfers are linked. 121 rows are unpaired.
6. The AI cost for October is $14.10. The monthly AI limit is now $100 (`FINOS_AI_BUDGET_USD`), the same as the API credit.
7. The branch has these changes:
   - The Axis profile matches the statement from net banking and the monthly statement.
   - The SBI Card profile adds the tax of an "(EXCL TAX x)" row when the statement prints no tax row.
   - The SBI Card profile permits a refund dated up to 15 days before the period.
   - `finos correct` and `finos accept` with an ID of an "Unknown" group change only the rows of that group.
   - `uv run finos recategorise <row-id>... "<category>"` changes single rows. It does not change the memory.
   - `uv run finos lines "<file>" "<text>"` shows the lines of one PDF around a text. It costs nothing.
8. 638 tests pass. The tests do not need credentials.
9. Pull request 8 is on `main`.
10. The re-sync check passes. A second `finos sync` shows 33 files unchanged and makes no Claude call.
11. The live tests pass: `FINOS_LIVE=1 uv run pytest tests/live`. They cost nothing and change nothing.
12. The fixed steps of the routine take 101 seconds: check 7 s, identify 68 s, sync 19 s, review 3 s, month 4 s.
13. The target for corrections from month 2 is 5 or fewer. Month 1 (October 2026) had 8.

### 1.2 Decisions in this session

1. The payments for the house sale are "Investments". They are neither income nor spending.
2. Consulting fees, money from your father and the income tax refund are "Other income".
3. Six small "Unknown" credits are "Other income". Their earlier category is not known.
4. `finos lines` shows statement text in the chat. Use it only when a check fails, and only with the agreement of the user.

### 1.3 Work that is not complete

1. `finos eval` has not run with a real model. The auto mode classifier stopped the paid run. The user must approve it.
2. The time of a normal month is not measured. The estimate is about 13 minutes: about 80 seconds for each new statement, plus the fixed steps and the review.
3. 28 transfers are ambiguous and not linked.
4. The file `0077449478748004_24022025.pdf` is from 2025 and has an unknown password. Sync skips it.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Delete the merged branches

1. Open the list of branches on GitHub.
2. Delete `claude/slice-d2-mvp`, `claude/axis-account-statement` and `claude/mvp-acceptance`.

### 2.2 Delete the old branches

> **CAUTION:** The branch `claude/slice-c-transfers` holds a commit with your UPI digits. Pull request 4 still shows that commit.

1. Open the list of branches on GitHub.
2. Delete `claude/slice-c-transfers`, `claude/statement-pipeline-plan` and `claude/sleepy-newton-amzv4r`.

### 2.3 Optional: clean the Drive folder

1. Delete `0077449478748004_24022025.pdf` from `Finance/Statements`.
2. Delete the SBI Card files that start with a date. They have the same content as the other SBI Card files.

### 2.4 Each month

1. Put the new statements in `Finance/Statements`.
2. Start a session and run `/import`.

### 2.5 Prepare the laptop for the BI UI

The full steps are in `docs/setup-guide.md`, Part 10.

> **WARNING:** Do not make `ui` as a branch config of `prd`. A branch config gets all statement passwords.

> **WARNING:** Paste the Doppler token only at the hidden Keychain prompt. Do not paste it in the chat.

1. Run `node --version`. Use Node 22.12 or later 22.x, 24.x, or 26 or later.
2. In Doppler project `finos`, create the environment `ui`.
3. In config `ui`, add `ANTHROPIC_KEY`. Copy its value from config `prd`.
4. Make a read-only service token for config `ui`, with an expiry.
5. Merge the BI UI pull request.
6. Do the Neon role, Keychain, build and start steps of Part 10.

## 3. Procedure for the next session

### 3.1 You

1. Put the November statements in `Finance/Statements`.
2. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
3. Send this prompt:

   > Continue from `docs/handoff.md`, section 3.

4. When Claude asks, approve the paid `finos sync` and the paid `finos eval`.

### 3.2 Claude

1. Cut a new branch from `main`. Do not work on `main`.
2. Record the start time. Run `/import`. Ask the user before the paid `finos sync`.
3. Record the time when `/import` ends. The target is 15 minutes or less.
4. Run `uv run finos eval --model claude-haiku-5-5 --dry-run`. Tell the user the cost.
5. Ask the user to approve the run with `--yes`. If the classifier stops it, ask the user to run it.
6. Count the corrections of the month in `finos status`. The target is 5 or fewer.
7. Run `FINOS_LIVE=1 uv run pytest tests/live`. All tests must pass.
8. Mark the open acceptance items in the parent plan. Milestone 1 is then complete.
9. Never put a handle, a name, an account number, a narration or an amount from the record in the repository.
10. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.

### 3.3 Claude: finish the BI UI

1. Ask the user if the chat gives averages with `get_stats`. Fix the problems that the user finds.
2. Run `npm --prefix ui run check` and `npm --prefix ui run e2e`. All checks except `npm audit signatures` must pass.
3. After the merge, help the user with the laptop steps of section 2.5. Do not run the steps for the user.
4. Never run the real server, `ui` or `ui-check` in a cloud session.
5. Ask the user before each commit.

If a statement is flagged, run `uv run finos lines "<file>" "<amount>"` with the agreement of the user. Fix the profile hint. Then run `finos sync --retry-flagged`.

If a new statement matches no profile, find its labels with a temporary probe profile. Put candidate phrases as markers. The error message lists only the missing phrases. Delete the probe before a commit.

If a real transfer is not linked, try a candidate transfer marker in the profile. Run `uv run finos transfers` and count the pairs. It costs nothing. Do not change a figure.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($100) continues to apply.
2. The ECC lock uses a release tag. The publisher can move a tag. After an ECC update, examine `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json`.
3. The HDFC and SBI Card rounding rules come from one statement each. No statement has shown a value that ends in exactly 50 paise yet.
4. With rounding, the printed closing of one statement can be different from the opening of the next statement by less than one rupee.
5. The record does not show the outstanding balance of the Canara loan. Only the EMI payments from the savings account are in the record.
6. The Axis account number is fully masked. The record knows the account only by its source. A second Axis account would replace statements of the first.
7. Unlock tries the passwords in name order. If two secrets have the same value, `identify` shows the first name.
8. The marker checks use five real files only. A new statement layout can stop a match. `finos identify` shows this without cost.
9. The proxy can fail a short outage with the same error as a refusal. The database client tries again; the Doppler and Drive requests do not.
10. `finos check` does not test `api.anthropic.com`. The first `finos sync` of a session is the first Claude call.
11. The auto mode permission classifier stops Claude from probing the proxy, the network secrets and the Neon connection directly. Claude uses only `finos` commands for these checks.
12. Some transfer pairs have their other half in a statement that is not imported yet. These show as "unpaired" until the back-fill.
13. A bank code marker ("UTIB", "SBIN", "HDFC Bank") also matches UPI merchants of that bank. About 10 small payments show as "unpaired" for this reason.
14. A digit handle or the last four digits of an account match at the end of any number. The equal amount, the 5-day limit and the one-candidate rule make a false pair unlikely.
15. Pairs with the evidence "your handle" do not show which handle matched.
16. A transfer marker does not separate two accounts of one bank. The last four digits do.
17. If the transfer links fail after a sync, the sync shows a warning. Run `uv run finos transfers` to link them again.
18. A narration without a UPI ID gets a key from its words. Two payees with the same words share a key.
19. A small unsure answer (less than ₹10,000) does not wait for review. A wrong small category can stay until you see it in `finos month`.
20. `finos accept --all` also accepts unsure answers. Read `finos review` first. It skips "Unknown" and your own name.
21. `finos correct` with a name changes money in and money out. Use the group ID or `--direction` to change one direction only.
22. A row keeps its old category when it becomes half of a transfer, until the next `finos categorise` or `finos sync`. The views ignore that category.
23. Claude makes the payee names from narrations. A name keeps only letters, digits and `. & ' , -`. Letters from other alphabets are removed.
24. Python and Postgres make some rare letters lower case in different ways, for example the Turkish "İ". Indian payee names do not have this problem.
25. A Claude call that fails is in the AI cost of `finos status`, but not in the cost line of that run.
26. A month is complete only when each account in the record covers each day. An account that closes, or that opens later, keeps its other months partial.
27. On a day that two statements of one account cover, the rows of the earlier statement do not count.
28. A refund counts in the month that it arrives. Thus a cash month can show negative spending. Use a spread to move it.
29. `finos sql` can read each table, also the narrations, the handles and the notes. Its output goes into the chat.
30. `finos sql` permits some actions that do not change data, for example an advisory lock. The privileges of the Neon role limit them.
31. The tests examine the read-only transaction in SQL. They do not examine the read-only header that Neon receives.
32. If `finos sync` replaces a statement, its rows get new IDs. Its spreads and goal rows then show in `v_spread_problems`. Add them again.
33. The spread summary repeats the SQL of the cash summary. A change to one must also go into the other. A test finds a difference.
34. The `finos eval` cost is an estimate from past token use, doubled for a retry. The budget check before each call is the hard limit.
35. A month that only a spread reaches shows as partial.
36. `finos correct "Unknown"` with the name, not the group ID, changes every "Unknown" row. Use the group ID, or `finos recategorise` with row IDs.
37. The Axis profile and the SBI account profile both see "Statement of Account" and "IFSC". Only "Nominee" separates them. If a statement matches two profiles, `identify` shows an error.
38. The SBI Card period check permits 15 days before the period. A wrong date in that window is not found.
39. The extraction adds the tax rows of "(EXCL TAX x)" from a hint. If the statement layout changes, the totals check finds a gap.
