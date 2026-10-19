# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-19
- **Branch:** `claude/slice-c-transfers`. A pull request into `main` is the next step.
- **Last commits:** `04d7cc0` (transfers, first part), `273145d` (test data without personal digits), then the commit with the review fixes, the docs and this handoff
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent), `statement-pipeline-slice-b.plan.md` and `statement-pipeline-slice-b2.plan.md` (done), `statement-pipeline-slice-c1.plan.md` (done)
- **Milestone:** 1, "Trusted monthly record". Slices A and B are on `main`. Slice C, part 1 is complete on the branch. Slice C, part 2 has no plan yet. Slice D is not started.

## 1. Status

### 1.1 Work that is complete

1. Slices A and B are on `main` (pull request 3, merged).
2. Slice C, part 1 (own-account transfers) is complete on `claude/slice-c-transfers`.
3. The `finos` tool has six commands:
   - `uv run finos check` examines the settings, the secret names, the database and the Drive folder. It does not show secret values.
   - `uv run finos identify` finds the profile of each PDF in Drive. It does not call Claude and it costs nothing.
   - `uv run finos sync` downloads new statement PDFs and sends them to Claude. The code then checks the result. After an import, it links the transfers again.
   - `uv run finos status` shows the statements, their problems, the transfers and the AI cost.
   - `uv run finos transfers` links the transfers between your own accounts. It uses the database only and costs nothing.
   - `uv run finos accounts` shows your accounts and your handles. `finos accounts add` and `finos accounts remove` change the handles.
4. A transfer pair is a debit in one of your accounts and a credit in a different one. The amounts are equal. The credit is 0 to 5 days after the debit.
5. A pair also needs evidence: one narration names the other account. The evidence is one of these:
   - a transfer marker in the profile of the other account, for example "UTIB" or "SBI Card";
   - the last four digits of the other account, from its statement;
   - one of your handles, in the debit narration only.
6. If two rows fit equally, the tool links nothing. It shows the rows as "ambiguous".
7. A handle is text that names you in a narration. The database holds two handles: the last four digits of your UPI phone number, and your name. The repository does not hold them.
8. The output shows each row by source, date and amount only. It never shows a narration.
9. On the five real statements, the tool links 8 pairs. You confirmed that all 8 pairs are correct.
10. The tool shows 16 rows as "unpaired". These rows name another account, but the other half is not in the record.
11. A Python review and a database review found no critical problems. Claude corrected the high and medium problems. One medium problem is not corrected (section 4, item 14).
12. 311 tests pass. The test coverage is 98%. The tests do not need credentials.
13. The AI cost for this month is $2.02 of the $10 limit. This session used no AI money.

### 1.2 Decisions in this session

1. A handle belongs to you, not to one account. You do not need to give account numbers: each statement holds its own last four digits.
2. Your name is a handle. A transfer to your own account prints your name, for example "OF Mr. <name>".
3. A handle is evidence only in a debit narration. A payment from another person also prints your name as the receiver.
4. A debit that names only you, with no partner, goes to your own account outside the record. Examples are the fixed deposit and the Canara loan EMI. Slice D must not count these as spending.
5. The marker "Axis" is removed, and "HDFC" changed to "HDFC Bank". The short names also matched UPI merchants of those banks.
6. The SBI payment on 1 September goes to your landlord. It is not a transfer. It stays "unpaired" because its narration has an Axis bank code.
7. The commit `04d7cc0` holds your UPI digits in the test data. The commit `273145d` removes them. Use "Squash and merge" so that `main` does not get them.

### 1.3 Work that is not complete

1. The pull request into `main` is not open or merged yet.
2. Slice C, part 2 (Task 11, categories) has no plan yet.
3. Slice D (Tasks 13 to 15) is not started. It has the monthly views, the spread costs, the goals and the back-fill.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the pull request

> **CAUTION:** Use "Squash and merge". A normal merge puts your UPI digits from commit `04d7cc0` into the history of `main`.

1. Open the pull request from `claude/slice-c-transfers` into `main`.
2. Read the changes.
3. Select "Squash and merge".
4. Delete the branch after the merge.

### 2.2 Prepare your notes for Slice C, part 2

Part 2 sorts transactions into categories.

1. Write down the categories that you want, for example "Food", "Household help" and "Investments".
2. Write down facts about your household that help to sort payments, for example "UPI to R. Kumar is the cook's salary".
3. Do not put these notes in the repository. Give them to Claude in the session.

### 2.3 Decide the back-fill budget

You do this before Slice D. It does not stop Slice C.

1. Read the cost: about 45 statements, at $0.09 to $0.30 each.
2. Decide if the monthly limit of $10 stays, or if you raise it for the month of the back-fill.

## 3. Procedure for the next session

### 3.1 You

1. Merge the pull request (section 2.1).
2. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
3. Send this prompt:

   > Start from `main`. Create a new branch `claude/slice-c-categories` from `main`. Read `docs/handoff.md` and the parent plan, Task 11. Run `uv run finos check` and `uv run finos transfers`. Then ask me for my category notes, write the Slice C part 2 plan, tell me the plan in five lines and wait for my approval. Ask me before each paid sync and before each commit.

4. Give Claude your notes from section 2.2 when Claude asks.
5. Read the summary of the plan. Reply "approved", or tell Claude what to change.

### 3.2 Claude

1. Read this file and Task 11 in the parent plan.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. Run `uv run finos transfers`. It must link the same 8 pairs.
5. Ask the user for the category list and the household notes.
6. Write `.claude/plans/statement-pipeline-slice-c2.plan.md`. Linked transfers get no category call. Debits to your own accounts outside the record (section 1.2, item 4) get no category call.
7. Tell the user the plan in five lines. Wait for approval before you write code.
8. Use the ECC sequence: tests first, implementation, review.
9. Ask the user before each Claude call that costs money.
10. Ask the user before each commit.
11. Never put a handle, a name, an account number or a narration in the repository. Use made-up values in tests.
12. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.

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
12. The record has five statements only. Some pairs have their other half in a statement that is not imported yet, for example the SBI Card bill of 30 September. These show as "unpaired" until the back-fill.
13. A bank code marker ("UTIB", "SBIN", "HDFC Bank") also matches UPI merchants of that bank. About 10 small payments show as "unpaired" for this reason. They cannot become a pair without an equal credit in your own account within 5 days.
14. A digit handle or the last four digits of an account match at the end of any number. A reference number or an amount with the same last digits also matches. The equal amount, the 5-day limit and the one-candidate rule make a false pair unlikely. You check each pair.
15. Pairs with the evidence "your handle" do not show which handle matched. This keeps the handle values out of the output.
16. A transfer marker does not separate two accounts of one bank. The last four digits do.
17. If the transfer links fail after a sync, the sync shows a warning. Run `uv run finos transfers` to link them again. `finos status` counts the pairs from the record, so it stays correct.
