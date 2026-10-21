# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-21
- **Branch:** `claude/axis-account-statement`, cut from `main` at `6a31a1e`.
- **Last commit:** the `fix:` commit for the profiles, the review groups and `finos lines`.
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent) and `statement-pipeline-slice-d2.plan.md` (done)
- **Milestone:** 1, "Trusted monthly record". The code is complete. The back-fill is complete. The eval run and the routine time are not done.

## 1. Status

### 1.1 Work that is complete

1. Pull request 7 (spread costs, goals, `finos eval`, `/import`, `/month`) is on `main`.
2. The back-fill is complete. The record has statements from January to October 2026 for the five accounts.
3. January to August 2026 are complete months. September and October are partial.
4. All statements have the status `ok`. 1,796 rows have a category. 0 rows wait for review.
5. 59 transfers are linked. 121 rows are unpaired.
6. The AI cost for October is $14.10. The run used `FINOS_AI_BUDGET_USD=40` for the back-fill only.
7. The branch has these changes:
   - The Axis profile matches the statement from net banking and the monthly statement.
   - The SBI Card profile adds the tax of an "(EXCL TAX x)" row when the statement prints no tax row.
   - The SBI Card profile permits a refund dated up to 15 days before the period.
   - `finos correct` and `finos accept` with an ID of an "Unknown" group change only the rows of that group.
   - `uv run finos recategorise <row-id>... "<category>"` changes single rows. It does not change the memory.
   - `uv run finos lines "<file>" "<text>"` shows the lines of one PDF around a text. It costs nothing.
8. 638 tests pass. The tests do not need credentials.

### 1.2 Decisions in this session

1. The payments for the house sale are "Investments". They are neither income nor spending.
2. Consulting fees, money from your father and the income tax refund are "Other income".
3. Six small "Unknown" credits are "Other income". Their earlier category is not known.
4. `finos lines` shows statement text in the chat. Use it only when a check fails, and only with the agreement of the user.

### 1.3 Work that is not complete

1. The pull request for `claude/axis-account-statement` is not open yet.
2. `finos eval` has not run with a real model.
3. The time of the monthly routine is not measured with a normal month. The back-fill took about 26 minutes for 19 statements.
4. The target for corrections in month 2 is not set.
5. 28 transfers are ambiguous and not linked.
6. The file `0077449478748004_24022025.pdf` is from 2025 and has an unknown password. Sync skips it.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the work into `main`

1. Tell Claude to open and merge the pull request, or do it on GitHub.
2. Delete the branches `claude/slice-d2-mvp` and `claude/axis-account-statement` after the merge.

### 2.2 Delete the old branches

> **CAUTION:** The branch `claude/slice-c-transfers` holds a commit with your UPI digits. Pull request 4 still shows that commit.

1. Open the list of branches on GitHub.
2. Delete `claude/slice-c-transfers`, `claude/statement-pipeline-plan` and `claude/sleepy-newton-amzv4r`.

### 2.3 Optional: clean the Drive folder

1. Delete `0077449478748004_24022025.pdf` from `Finance/Statements`.
2. Delete the SBI Card files that start with a date. They have the same content as the other SBI Card files.

### 2.4 Before the import in November

> **CAUTION:** The AI cost for October is more than $10. Until 1 November, a paid `finos` command stops at the limit.

1. Put the new statements in `Finance/Statements`.
2. Start a session and run `/import`.

## 3. Procedure for the next session

### 3.1 You

1. Merge the pull request (section 2.1).
2. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
3. Send this prompt:

   > Start from `main`. Read `docs/handoff.md`. Run `finos eval --model claude-haiku-5-5 --dry-run` and ask me before the real run. Then look at the 28 ambiguous transfers. Ask me before each paid call and before each commit.

### 3.2 Claude

1. Read this file.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. Run `uv run finos status`. It must show 0 to review and no flagged statement.
5. Run `uv run finos eval --model claude-haiku-5-5 --dry-run`. Ask the user before the run with `--yes`.
6. Run `uv run finos transfers`. Examine the 28 ambiguous pairs. It costs nothing.
7. Ask the user for the correction target of month 2.
8. Never put a handle, a name, an account number, a narration or an amount from the record in the repository.
9. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.

If a statement is flagged, run `uv run finos lines "<file>" "<amount>"` with the agreement of the user. Fix the profile hint. Then run `finos sync --retry-flagged`.

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
37. The Axis profile and the SBI account profile both see "Statement of Account" and "IFSC". Only "Nominee" separates them. If a statement matches two profiles, `identify` shows an error.
38. The SBI Card period check permits 15 days before the period. A wrong date in that window is not found.
39. The extraction adds the tax rows of "(EXCL TAX x)" from a hint. If the statement layout changes, the totals check finds a gap.
