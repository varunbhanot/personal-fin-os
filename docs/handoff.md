# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-20
- **Branch:** `claude/statement-pipeline-plan`, cut from `main`. A pull request into `main` is the next step.
- **Last commit:** the `feat:` commit for categories, memory and the review queue. It also holds the Slice C, part 2 plan.
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent), `statement-pipeline-slice-c1.plan.md` and `statement-pipeline-slice-c2.plan.md` (done)
- **Milestone:** 1, "Trusted monthly record". Slices A, B and C, part 1 are on `main`. Slice C, part 2 is complete on the branch. Slice D is not started.

## 1. Status

### 1.1 Work that is complete

1. Slices A and B are on `main` (pull request 3). Slice C, part 1 (transfers) is on `main` (pull request 4).
2. Slice C, part 2 (categories) is complete on `claude/statement-pipeline-plan`.
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
4. The category list is in `src/finos/categories.yaml`. It has 22 categories. "Own accounts" is for a transfer whose other half is not in the record.
5. Memory comes first. A row with known narration text, or a payee that you decided on, gets its category without a Claude call.
6. Claude categorises the other rows in batches of 40. Claude gets the category list, your notes and your corrections.
7. A row waits for you only in two cases:
   - the category breaks a rule, for example money out with an income category;
   - Claude is not sure, and the amount is ₹10,000 or more (`FINOS_REVIEW_MIN_INR`).
8. Memory keeps one category for each payee and direction. "Money out" and "money in" are separate.
9. Memory never keeps your own name or "Unknown" as a payee. Their rows are known by their narration text after you decide on them.
10. The output never shows a narration. Each review group has a 6-character ID. You give the ID to `accept` and `correct`.
11. The real run on the five statements categorised 186 rows. It cost $0.24. After your answers, no row waits.
12. You made 3 corrections (4 rows). Claude was correct for about 98% of the rows without a correction.
13. The database holds your 8 household notes. The repository does not hold them.
14. 420 tests pass. The test coverage is 98%. The tests do not need credentials.
15. The AI cost for this month is $2.25 of the $10 limit.
16. A Python review, a database review and a security review found no critical problems. Claude corrected the high and medium problems. Section 4 lists the other items.

### 1.2 Decisions in this session

1. The loan EMI counts as spending ("Loan EMI"), as the PRD says. A fixed deposit counts as "Investments". This replaces the earlier decision to skip these rows.
2. The builder pays your home-loan EMI until possession. This money in has the category "Loan EMI", so it reduces the EMI spending.
3. The settlement from your previous landlord has the category "Rent" on money in. It reduces the rent spending.
4. A small card charge is an annual fee ("Bank fees & interest"). `correct --once` changed it without a memory of the name "Credit Card".
5. Society maintenance is in "Utilities".
6. The first plan commit held household facts (employer, school, brokers). Claude replaced that commit and force-pushed the branch. No pull request held the old commit.

### 1.3 Work that is not complete

1. The pull request into `main` is not open or merged yet.
2. Slice D (plan Tasks 13 to 15) is not started. It has the monthly views, the spread costs, the goals and the back-fill.
3. Seven September credits in your name go into the SBI account. Claude thinks that they come from your own account ("Own accounts"). You are not sure. They are less than ₹10,000 each, so they do not wait for review.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the work into `main`

1. Tell Claude to open the pull request, if it is not open.
2. Read the summary and the checks.
3. Select "Squash and merge".
4. Delete the branch after the merge.

### 2.2 Delete the old transfers branch

> **CAUTION:** The branch `claude/slice-c-transfers` holds a commit with your UPI digits. Pull request 4 still shows that commit.

1. Open the list of branches on GitHub.
2. Delete `claude/slice-c-transfers`.

### 2.3 Decide the back-fill budget

You do this before Slice D starts the back-fill.

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

   > Start from `main`. Create a new branch from `main` for Slice D. Read `docs/handoff.md` and the parent plan, Task 13. Run `uv run finos check`, `uv run finos transfers` and `uv run finos status`. Then write the plan for the monthly views, tell me the plan in five lines and wait for my approval. Ask me before each paid call and before each commit.

4. Read the summary of the plan. Reply "approved", or tell Claude what to change.

### 3.2 Claude

1. Read this file and Task 13 in the parent plan.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. Run `uv run finos transfers`. It must link the same 8 pairs.
5. Run `uv run finos status`. It must show 186 rows categorised and 0 to review.
6. Write the plan for Task 13 (monthly views). Use these rules:
   - A row in `transfer_links` is a transfer. Its category does not count.
   - A category of the kind "transfer" ("Own accounts") is neither income nor spending.
   - An expense category on money in is a refund. It reduces that category's spending. Examples are the builder's EMI payment and the landlord's settlement.
   - "Loan EMI" counts the full EMI as spending.
   - "Investments" is neither income nor spending. Show it separately.
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
12. The record has five statements only. Some pairs have their other half in a statement that is not imported yet. These show as "unpaired" until the back-fill.
13. A bank code marker ("UTIB", "SBIN", "HDFC Bank") also matches UPI merchants of that bank. About 10 small payments show as "unpaired" for this reason.
14. A digit handle or the last four digits of an account match at the end of any number. The equal amount, the 5-day limit and the one-candidate rule make a false pair unlikely.
15. Pairs with the evidence "your handle" do not show which handle matched.
16. A transfer marker does not separate two accounts of one bank. The last four digits do.
17. If the transfer links fail after a sync, the sync shows a warning. Run `uv run finos transfers` to link them again.
18. A narration without a UPI ID gets a key from its words. Two payees with the same words, for example the same first name and bank, share a key.
19. A small unsure answer (less than ₹10,000) does not wait for review. A wrong small category can stay until you see it in the monthly views.
20. `finos accept --all` also accepts unsure answers. Read `finos review` first. It skips "Unknown" and your own name.
21. `finos correct` with a name changes money in and money out. Use the group ID or `--direction` to change one direction only.
22. A row keeps its old category when it becomes half of a transfer, until the next `finos categorise` or `finos sync`. Slice D must give `transfer_links` priority.
23. Claude makes the payee names from narrations. A name keeps only letters, digits and `. & ' , -`. Letters from other alphabets are removed.
24. Python and Postgres make some rare letters lower case in different ways, for example the Turkish "İ". Indian payee names do not have this problem.
25. A Claude call that fails is in the AI cost of `finos status`, but not in the cost line of that run.
