# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-20
- **Branch:** `claude/slice-d2-mvp`, cut from `main` at `6974bdc`.
- **Last commit:** the `feat:` commit for spread costs, goals and `finos eval`.
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent) and `statement-pipeline-slice-d2.plan.md` (done)
- **Milestone:** 1, "Trusted monthly record". Slices A, B, C and D, part 1 are on `main`. Task 14 and the code of Task 15 are complete on the branch. The back-fill is not started.

## 1. Status

### 1.1 Work that is complete

1. Slices A, B, C and D, part 1 are on `main` (pull requests 3, 4, 5 and 6).
2. Task 14 (spread costs and goals) is complete on `claude/slice-d2-mvp`.
3. The code of Task 15 (`finos eval`, the `/import` and `/month` skills) is complete on the branch.
4. A workflow made the plan, wrote the tests first and built the code. Three reviewers examined the changes. Claude corrected the one medium problem and two low problems.
5. Migration `0007_spreads_goals` is on Neon. It adds tables and views only. The cash views do not change.
6. The `finos` tool has these new commands:
   - `uv run finos rows 2026-10` shows the rows of a month with a short row ID. It never shows a narration.
   - `uv run finos spread add <row-id> --months 3` spreads one row in equal parts across 3 months.
   - `--start 2026-07` sets the first month. It can be before the month of the row.
   - `uv run finos spread list` and `finos spread remove <id>` show and remove spreads.
   - `uv run finos goal add "<name>" <budget>` adds a goal, for example a trip.
   - `uv run finos goal assign <goal> <row-id>...` puts expense rows into a goal.
   - `uv run finos goal list`, `goal show`, `goal unassign` and `goal remove` manage the goals.
   - `uv run finos month --spread` shows the figures with the spreads applied.
   - `uv run finos eval --model <id> --dry-run` shows the statements and the cost of a model comparison. It calls nothing.
7. `finos eval --model <id> --yes` reads the verified statements again with a cheaper model. It compares the rows with the stored rows. It records the cost, and it does not change the record.
8. `finos eval` stops if the cost estimate is more than the budget that is left this month.
9. The spread rules:
   - Each month gets the amount divided by the number of months, in whole paise. The last month gets the remaining paise.
   - A spread of money in is permitted. Thus a refund can reduce the spending of the months that it pays for.
   - A transfer, an "Own accounts" row or a row with no category cannot be spread.
   - The spread views use the same counting rules as the cash views.
10. `v_goal_progress` shows the budget, the spending, the spending to date and the remainder of each goal, month by month and in total.
11. `v_spread_problems` shows spreads and goal rows that do not count now, for example after a statement is replaced.
12. The skill `/import` runs `finos check`, `finos identify`, `finos sync` (after it asks you about the cost), `finos review` and `finos month`.
13. The skill `/month` shows `finos month`, one month in full, the spread figures and the goal progress.
14. The real record gives the same spread figures as cash figures, because no spread exists yet.
15. The dry run of `finos eval` with `claude-haiku-5-5` shows 5 statements, at a cost of $0.03 at most.
16. This session made no Claude call. The AI cost for this month is $2.25 of the $10 limit.
17. 623 tests pass. The test coverage is 99%. The tests do not need credentials.

### 1.2 Decisions in this session

1. You can spread each row that has a category, also money in. This is how the builder's EMI payment can go against earlier months.
2. A goal row counts in the month of its date, not in its spread months.
3. A spread and a goal row keep a copy of the date, account, direction and amount of their row. They have no database link to the row. Thus `finos sync` can replace a statement.
4. Migration `0007` is on Neon. For a change, add a new migration. Do not change `0005`, `0006` or `0007`.

### 1.3 Work that is not complete

1. The pull request into `main` is not open yet.
2. The back-fill (January to August 2026) is not started. The Drive folder has only 5 statements.
3. No spread and no goal exists yet. You decide them.
4. `finos eval` has not run with a real model.
5. The time of the monthly routine is not measured yet. The target is 15 minutes or less.
6. Seven September credits in your name go into the SBI account. Claude thinks that they are "Own accounts". You are not sure.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the work into `main`

1. Tell Claude to open the pull request, or open it on GitHub.
2. Read the summary and the checks.
3. Select "Squash and merge".
4. Delete the branch after the merge.

### 2.2 Delete the old branches

> **CAUTION:** The branch `claude/slice-c-transfers` holds a commit with your UPI digits. Pull request 4 still shows that commit.

1. Open the list of branches on GitHub.
2. Delete `claude/slice-c-transfers`.
3. Delete `claude/statement-pipeline-plan` and `claude/sleepy-newton-amzv4r`.

### 2.3 Put the back-fill statements in Drive

1. Find the statements from January to August 2026 for each of the five accounts.
2. Save each PDF to the Drive folder `Finance/Statements`.

### 2.4 Decide the back-fill budget

> **CAUTION:** The back-fill costs money. About 45 statements cost $0.09 to $0.30 each, plus about $0.05 each for categories.

1. Decide if the monthly limit of $10 stays.
2. If necessary, raise it for the month of the back-fill.

### 2.5 Optional: add spreads and goals

1. Run `uv run finos rows 2026-10` to find the row ID.
2. Tell Claude which rows to spread and across which months, for example the quarterly school fee.
3. Tell Claude the goals and their budgets, for example a trip.

### 2.6 Optional: name the SBI credits

1. Tell Claude what the seven September credits are.
2. Claude runs `finos correct "<your name>" "<category>" --direction in`.

## 3. Procedure for the next session

### 3.1 You

1. Do the steps in sections 2.1, 2.3 and 2.4.
2. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
3. Send this prompt:

   > Start from `main`. Create a new branch from `main` for the back-fill. Read `docs/handoff.md`. Run `/import` for all statements in Drive. Tell me the cost before each paid call. Then run `finos eval --model claude-haiku-5-5 --dry-run` and ask me before the real run. Time the routine. Ask me before each commit.

### 3.2 Claude

1. Read this file.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. Run `uv run finos identify`. Every new PDF must match a profile. It costs nothing.
5. Tell the user the number of new statements and the estimated cost. Wait for approval before `finos sync`.
6. Run `uv run finos sync`. Then run `uv run finos review` and `uv run finos month`.
7. Every month from 2026-01 must show for each source in `finos status`.
8. Run `uv run finos eval --model claude-haiku-5-5 --dry-run`. Ask the user before the run with `--yes`.
9. Record the time of the routine. The target is 15 minutes or less.
10. Never put a handle, a name, an account number, a narration or an amount from the record in the repository.
11. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.

If a new statement matches no profile, find its labels with a temporary probe profile. Put candidate phrases as markers. The error message lists only the missing phrases. Delete the probe before a commit.

If a real transfer is not linked, try a candidate transfer marker in the profile. Run `uv run finos transfers` and count the pairs. It costs nothing. Do not change a figure.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($10) continues to apply.
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
