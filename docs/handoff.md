# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-19
- **Branch:** `main`. No work branch is open. The next session cuts a new branch from `main`.
- **Last commits:** `d59b466` (merge of pull request 3: Slices A and B), then the `docs:` commit with the Slice C plan and this handoff
- **Plans:** `.claude/plans/statement-pipeline.plan.md` (parent), `statement-pipeline-slice-b.plan.md` and `statement-pipeline-slice-b2.plan.md` (done), and `statement-pipeline-slice-c1.plan.md` (next, not approved)
- **Milestone:** 1, "Trusted monthly record". Slices A and B are complete and on `main`. Slice C is planned. Slice D is not started.

## 1. Status

### 1.1 Work that is complete

1. Slices A and B are on `main` (pull request 3, merged).
2. The `finos` tool has four commands:
   - `uv run finos check` examines the settings, the secret names, the database and the Drive folder. It does not show secret values.
   - `uv run finos identify` finds the profile of each PDF in Drive. It also shows the name of the secret that opens each PDF. It does not call Claude and it costs nothing.
   - `uv run finos sync` downloads new statement PDFs, opens them and sends them to Claude. The code then checks the result.
   - `uv run finos status` shows the statements in the record, their problems and the AI cost.
3. After Claude reads a statement, the code does five checks. The checks compare the result with the printed totals, the running balances, the PDF text, the statement period and the account number.
4. If a check fails, Claude tries one more time. If the check fails again, the statement gets the status "flagged" with the problem.
5. The record is a Neon Postgres database. The record stays after each session ends.
6. All five sources have a profile, and each real statement has the status "ok":

   | Source | Statement | Transactions |
   |---|---|---|
   | `hdfc-tataneu` | October 2026 | 29 |
   | `sbi-card` | September 2026 | 80 |
   | `axis-bank` | September 2026 | 39 |
   | `sbi-bank` | September 2026 | 21 |
   | `canara-bank` | September to October 2026 | 33 |

7. A second `finos sync` showed all five files as "unchanged". It did not call Claude.
8. The AI cost for this month is $2.02 of the $10 limit. $7.98 is left.
9. 266 tests pass. The test coverage is 98%. The tests do not need credentials.

### 1.2 Decisions in this session

1. The next step is own-account transfers (plan Task 12). The PRD rates double counting of card bills and own transfers as likely and serious. It is also a success metric.
2. The transfer work uses no Claude call. It costs nothing.
3. Categories (plan Task 11) follow directly. They need your category list and household notes first.
4. Monthly totals (Task 13) and the back-fill from January 2026 (Task 15) come after Slice C. The totals are wrong until transfers are left out and transactions have categories.
5. The back-fill is about 45 statements. It can use most of the AI limit. You must decide the budget before it starts.
6. The Slice C plan is written in `.claude/plans/statement-pipeline-slice-c1.plan.md`. The plan has a matching rule, a task list, tests and risks.
7. You asked Claude to push this documentation commit straight to `main`. Future work uses a branch and a pull request.

### 1.3 Work that is not complete

1. You did not approve the Slice C plan yet. No code for Slice C exists.
2. Slice C, part 2 (Task 11, categories) has no plan yet.
3. Slice D (Tasks 13 to 15) is not started. It has the monthly views, the spread costs, the goals and the back-fill.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Prepare your notes for Slice C

Slice C finds transfers between your own accounts. It also sorts transactions into categories.

1. Write down the last four digits of each of your accounts and cards.
2. Write down your UPI IDs. A UPI ID is not a secret, but it is personal.
3. Write down the categories that you want, for example "Food", "Household help" and "Investments".
4. Write down facts about your household that help to sort payments, for example "UPI to R. Kumar is the cook's salary".
5. Do not put these notes in the repository. Give them to Claude in the session.

### 2.2 Decide the back-fill budget

You do this before Slice D. It does not stop Slice C.

1. Read the cost in section 1.2, item 5.
2. Decide if the monthly limit of $10 stays, or if you raise it for the month of the back-fill.

## 3. Procedure for the next session

### 3.1 You

1. Open https://claude.ai/code. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
2. Send this prompt:

   > Start from `main`. Create a new branch `claude/slice-c-transfers` from `main`. Read `docs/handoff.md` and `.claude/plans/statement-pipeline-slice-c1.plan.md`. Run `uv run finos check` and `uv run finos identify`. Then tell me the plan in five lines and wait for my approval. After I approve, build Slice C part 1 (own-account transfers) with tests first. Ask me before each paid sync and before each commit. When the slice is complete, update the handoff and ask me about a pull request into `main`.

3. Read the summary of the plan. Reply "approved", or tell Claude what to change.
4. Give Claude your notes from section 2.1 when Claude asks.

### 3.2 Claude

1. Read this file and the Slice C plan.
2. Cut a new branch from `main`. Do not work on `main`.
3. Run `uv run finos check`. Tell the user the result. Do not show secret values.
4. If a part fails, tell the user which setting to correct. Use the message from `finos check` and `docs/setup-guide.md`. Stop until the user corrects it.
5. Run `uv run finos identify`. Each file must match its own profile.
6. Tell the user the plan in five lines. Wait for approval before you write code.
7. Build tasks C1.1 to C1.5 of the plan. Use the ECC sequence: tests first, implementation, review.
8. Run `uv run finos transfers` on the real record. It is free. Show each pair by source, date and amount only. Never show narration text.
9. Ask the user to confirm each pair. If a real transfer is unpaired, add a marker or a handle. Do not change a figure.
10. Ask the user before each `finos sync` that calls Claude, and before each `finos sync --retry-flagged`.
11. Ask the user before each commit.
12. At the end of the session, update this file. Use ASD-STE100. Then ask the user about a pull request into `main`.
13. Plan Slice C, part 2 (Task 11) after part 1. Use the notes of the user.

If a new statement matches no profile, find its labels with a temporary probe profile. Put candidate phrases as markers. The error message lists only the missing phrases. Delete the probe before a commit.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($10) continues to apply.
2. The ECC lock uses a release tag. The publisher can move a tag. After an ECC update, examine `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json`.
3. The HDFC and SBI Card rounding rules come from one statement each. No statement has shown a value that ends in exactly 50 paise yet.
4. With rounding, the printed closing of one statement can be different from the opening of the next statement by less than one rupee. A check that compares statements (Slice C) must permit this.
5. The record does not show the outstanding balance of the Canara loan. Only the EMI payments from the savings account are in the record. A `loan` profile can add the balance later.
6. The Axis account number is fully masked. The record knows the account only by its source. A second Axis account would replace statements of the first.
7. Unlock tries the passwords in name order. If two secrets have the same value, `identify` shows the first name. The HDFC file shows `PW_AXIS_BANK` for this reason.
8. The marker checks use five real files only. A new statement layout can stop a match. `finos identify` shows this without cost.
9. The proxy can fail a short outage with the same error as a refusal. The database client tries again; the Doppler and Drive requests do not.
10. `finos check` does not test `api.anthropic.com`. The first `finos sync` of a session is the first Claude call.
11. The auto mode permission classifier stops Claude from probing the proxy, the network secrets and the Neon connection directly. Claude uses only `finos` commands for these checks.
12. The record has five statements only. Most transfer pairs have their other half in a statement that is not imported yet. Many pairs show as "unpaired" until the back-fill.
