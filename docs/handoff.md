# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-20
- **Branch:** `claude/sleepy-newton-amzv4r`, cut from `main` at `9313c1d`. A pull request into `main` is open.
- **Last commit:** the `feat:` commit for the monthly views. It also holds the Slice D, part 1 plan.
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent) and `statement-pipeline-slice-d1.plan.md` (done)
- **Milestone:** 1, "Trusted monthly record". Slices A, B and C are on `main`. Slice D, part 1 (Task 13) is complete on the branch. Tasks 14 and 15 are not started.

## 1. Status

### 1.1 Work that is complete

1. Slices A, B and C are on `main` (pull requests 3, 4 and 5).
2. Slice D, part 1 (Task 13, the monthly views) is complete on `claude/sleepy-newton-amzv4r`.
3. The `finos` tool has these commands:
   - `uv run finos check` examines the settings, the secret names, the database and the Drive folder.
   - `uv run finos identify` finds the profile of each PDF in Drive. It costs nothing.
   - `uv run finos sync` imports new statements. Then it links the transfers and categorises the new rows.
   - `uv run finos status` shows the statements, the transfers, the categories and the AI cost.
   - `uv run finos transfers` links the transfers between your own accounts. It costs nothing.
   - `uv run finos accounts` shows your accounts and your handles.
   - `uv run finos categorise` gives each new row a category. `--dry-run` shows the rows and the cost, and calls nothing.
   - `uv run finos review` shows the rows that wait for you. `finos review <id>` shows the rows of one group.
   - `uv run finos accept <id>` keeps the category of a group. `uv run finos correct <id> "<category>"` changes it.
   - `uv run finos notes` shows your household notes. `finos notes add` and `finos notes remove` change them.
   - `uv run finos month` shows the income, expenses, savings and investments of each month. It costs nothing.
   - `uv run finos month 2026-09` shows one month: the coverage, the categories, the refunds and the rows that do not count.
   - `uv run finos sql "<query>"` runs one read-only query. It shows 200 rows and 20 columns at most.
4. SQL views in the database calculate the figures. The views are `v_monthly_summary`, `v_monthly_by_category`, `v_month_coverage`, `v_transactions` and `v_counted_transactions`. No view has a narration column.
5. The views use these rules:
   - A row counts in the month of its date.
   - A linked transfer is neither income nor spending. Its old category does not count.
   - A row with the category "Own accounts" is neither income nor spending.
   - An expense category on money in is a refund. It reduces the spending of that category.
   - "Loan EMI" counts the full EMI as spending.
   - "Investments" is neither income nor spending. The month shows money in, money out and net.
   - Savings is income minus expenses.
6. Only statements with the status `ok` count. A month view shows the flagged statements of that month.
7. The periods of two statements of one account can overlap. On a day that both statements cover, only the statement that starts later counts.
8. The transfer links, the categories and the figures use the same rows.
9. Each month shows the number of days that each account covers. A month is complete when each account covers each day. No month is complete now.
10. `finos month` does not write to the database. It gives a warning when the transfer links are not current.
11. `finos sql` runs the query in a read-only transaction with a limit of 15 seconds. Neon refuses a write. Neon also refuses two statements in one query.
12. The database has only the `plpgsql` extension. Thus a query cannot reach the network.
13. The real run gives figures for August, September and October 2026. Claude showed them in the chat on 2026-10-20. The repository does not hold them.
14. This slice made no Claude call. The AI cost for this month is $2.25 of the $10 limit.
15. 498 tests pass. The test coverage is 99%. The tests do not need credentials.
16. A Python review, a database review and a security review found one high problem and four medium problems. Claude corrected all of them.
17. The high problem was two overlapping statements of one account. Their shared days counted two times. Item 7 corrects this.

### 1.2 Decisions in this session

1. A refund counts in the month that it arrives.
2. The builder's EMI payment and the landlord's settlement arrived in October 2026. Thus October shows negative expenses. Task 14 can set these payments against the months that they cover.
3. A row that waits for review counts with its current category. A row with no category does not count. The month view shows the number of these rows.
4. Migration `0005_views` is on Neon. Migration `0006_views_one_statement_per_day` replaces its views. For a change, add a new migration. Do not change `0005` or `0006`.
5. `CLAUDE.md` has a new rule: with `finos sql`, query the `v_*` views. Do not select a narration, a reason, a handle or a note.

### 1.3 Work that is not complete

1. The pull request into `main` is open. It is not merged yet.
2. Task 14 (spread costs and goals) is not started.
3. Task 15 (the back-fill, `finos eval` and the routine skills) is not started.
4. Seven September credits in your name go into the SBI account. Claude thinks that they come from your own account ("Own accounts"). You are not sure. They are less than ₹10,000 each, so they do not wait for review.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the work into `main`

1. Open the pull request into `main` on GitHub.
2. Read the summary and the checks.
3. Select "Squash and merge".
4. Delete the branch after the merge.

### 2.2 Delete the old branches

> **CAUTION:** The branch `claude/slice-c-transfers` holds a commit with your UPI digits. Pull request 4 still shows that commit.

1. Open the list of branches on GitHub.
2. Delete `claude/slice-c-transfers`.
3. Delete `claude/statement-pipeline-plan`. Pull request 5 merged its work.

### 2.3 Decide the back-fill budget

You do this before Task 15 starts the back-fill.

1. Read the cost: about 45 statements, at $0.09 to $0.30 each, plus about $0.05 each for categories.
2. Decide if the monthly limit of $10 stays, or if you raise it for the month of the back-fill.

### 2.4 Optional: name the SBI credits

The credits are the seven September credits in your name in the SBI account. Claude showed their dates and amounts in the chat on 2026-10-20.

1. Tell Claude what the credits are.
2. Claude runs `finos correct "<your name>" "<category>" --direction in`. The EMI debits in your name do not change.

## 3. Procedure for the next session

### 3.1 You

1. Merge the pull request (section 2.1).
2. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
3. Send this prompt:

   > Start from `main`. Create a new branch from `main` for Slice D, part 2. Read `docs/handoff.md` and the parent plan, Task 14. Run `uv run finos check`, `uv run finos transfers` and `uv run finos month`. Then ask me which costs to spread and which goals to track. Write the plan for spread costs and goals, tell me the plan in five lines and wait for my approval. Ask me before each paid call and before each commit.

4. Tell Claude the costs to spread, for example the quarterly school fee.
5. Tell Claude the goals and their budgets, for example a trip.
6. Read the summary of the plan. Reply "approved", or tell Claude what to change.

### 3.2 Claude

1. Read this file and Task 14 in the parent plan.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. Run `uv run finos transfers`. It must link the same 8 pairs.
5. Run `uv run finos month`. It must show 2026-08, 2026-09 and 2026-10 as partial.
6. Run `uv run finos status`. It must show 186 rows categorised and 0 to review.
7. Ask the user which costs to spread and which goals to track. Keep names and amounts in the database only.
8. Write the plan for Task 14. Use these rules:
   - A spread cost counts in equal parts across the months that it covers. The last month gets the remaining paise.
   - Keep the cash views as they are. Add a spread version next to each view.
   - A refund can pay for earlier months, for example the builder's EMI payment. Ask the user if it must spread across those months.
   - `v_goal_progress` shows the budget of each goal and the actual spending, month by month.
   - Add a new migration. Do not change `0005` or `0006`, because Neon has them.
9. Tell the user the plan in five lines. Wait for approval before you write code.
10. Use the ECC sequence: tests first, implementation, review.
11. Ask the user before each Claude call that costs money.
12. Ask the user before each commit.
13. Never put a handle, a name, an account number, a narration or an amount from the record in the repository. Use made-up values in tests.
14. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.

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
12. The record has five statements only. Some pairs have their other half in a statement that is not imported yet. These show as "unpaired" until the back-fill.
13. A bank code marker ("UTIB", "SBIN", "HDFC Bank") also matches UPI merchants of that bank. About 10 small payments show as "unpaired" for this reason.
14. A digit handle or the last four digits of an account match at the end of any number. The equal amount, the 5-day limit and the one-candidate rule make a false pair unlikely.
15. Pairs with the evidence "your handle" do not show which handle matched.
16. A transfer marker does not separate two accounts of one bank. The last four digits do.
17. If the transfer links fail after a sync, the sync shows a warning. Run `uv run finos transfers` to link them again.
18. A narration without a UPI ID gets a key from its words. Two payees with the same words, for example the same first name and bank, share a key.
19. A small unsure answer (less than ₹10,000) does not wait for review. A wrong small category can stay until you see it in `finos month`.
20. `finos accept --all` also accepts unsure answers. Read `finos review` first. It skips "Unknown" and your own name.
21. `finos correct` with a name changes money in and money out. Use the group ID or `--direction` to change one direction only.
22. A row keeps its old category when it becomes half of a transfer, until the next `finos categorise` or `finos sync`. The views ignore that category.
23. Claude makes the payee names from narrations. A name keeps only letters, digits and `. & ' , -`. Letters from other alphabets are removed.
24. Python and Postgres make some rare letters lower case in different ways, for example the Turkish "İ". Indian payee names do not have this problem.
25. A Claude call that fails is in the AI cost of `finos status`, but not in the cost line of that run.
26. A month is complete only when each account in the record covers each day. An account that closes, or that opens later, keeps its other months partial.
27. On a day that two statements of one account cover, the rows of the earlier statement do not count. If the two statements show different rows for that day, the figures use only the later rows.
28. A refund counts in the month that it arrives. Thus a category or a month can show negative spending.
29. `finos sql` can read each table, also the narrations, the handles and the notes. Its output goes into the chat.
30. `finos sql` permits some actions that do not change data, for example an advisory lock. The privileges of the Neon role limit them.
31. The tests examine the read-only transaction in SQL. They do not examine the read-only header that Neon receives.
