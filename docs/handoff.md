# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-19
- **Branch:** `claude/statement-pipeline-plan`
- **Last commits:** the `feat:` commit for SBI bank and Canara (Slice B, part 2), `1f9a9ae` (SBI Card rounding), `504c26d` (SBI Card, Axis Bank and `finos identify`)
- **Plans:** `.claude/plans/statement-pipeline.plan.md`, with Slice B in `statement-pipeline-slice-b.plan.md` and `statement-pipeline-slice-b2.plan.md`
- **Milestone:** 1, "Trusted monthly record". Slices A and B are complete and tested with real statements. Slices C and D are not started.

## 1. Status

### 1.1 Work that is complete

1. The plan is approved. The design uses Claude Code cloud sessions only. Nothing runs on your computer.
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
8. The AI cost for this month is $2.02 of the $10 limit.
9. 266 tests pass. The test coverage is 98%. The tests do not need credentials.

### 1.2 Changes in Slice B

1. The SBI Card statement prints only the last two digits of the card number. The Axis statement masks all digits. The profile setting `account_digits` sets this.
2. SBI Card prints its debits on two summary lines. Claude copies each line, and the code adds them. The setting `closing_rounded_to_rupee` permits the rounded total.
3. Each card profile needs "Minimum Amount Due". Thus a bank statement that names a card in a payment does not match the card profile.
4. The Canara statement is the savings account that pays the loan EMI. Its profile is `canara-bank`, of the kind "bank". The EMI is a withdrawal row, so the full EMI counts as an expense.
5. The Canara statement has no password. A profile can now leave out `password_secret`. A blank value is an error.
6. `finos identify` now shows "opened with PW_..." or "no password" for each file. It shows the secret name, never the value.

### 1.3 Work that is not complete

1. Categories and own-account transfers come in Slice C (plan Tasks 11 and 12).
2. Monthly totals, spread costs, goals and the back-fill from January 2026 come in Slice D (plan Tasks 13 to 15).
3. The plan asks for one pull request for each slice. Slices A and B are not on `main` until a pull request merges them.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

### 2.1 Merge the work into `main`

1. Open the pull request from `claude/statement-pipeline-plan` into `main` on GitHub.
2. Read the summary and the checks.
3. Merge the pull request.

If no pull request exists, tell Claude to open one.

### 2.2 Prepare Slice C

Slice C sorts transactions into categories. It also finds transfers between your own accounts.

1. Write down the categories that you want, for example "Food", "Household help" and "Investments".
2. Write down facts about your household that help to sort payments, for example "UPI to R. Kumar is the cook's salary".
3. Write down the last four digits of each of your accounts and cards, and your UPI IDs.
4. Do not put these notes in the repository. Give them to Claude in the session.

## 3. Procedure for the next session

### 3.1 You

1. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
2. Tell Claude if the pull request is merged. If it is merged, Claude uses `main`.
3. Give Claude your notes from section 2.2.

### 3.2 Claude

1. Read this file and the plan.
2. Run `uv run finos check`. Tell the user the result. Do not show secret values.
3. If a part fails, tell the user which setting to correct. Use the message from `finos check` and `docs/setup-guide.md`. Stop until the user corrects it.
4. Run `uv run finos identify`. Each file must match its own profile.
5. If a new statement matches no profile, find its labels with a temporary probe profile. Put candidate phrases as markers. The error message lists only the missing phrases. Delete the probe before a commit.
6. Start Slice C (plan Tasks 11 and 12). Use the ECC sequence: plan, tests first, implementation, review. Ask the user to approve the plan.
7. Ask the user before each `finos sync` that calls Claude, and before each `finos sync --retry-flagged`.
8. If a statement is "flagged", correct the source profile or the check formula. Do not change a figure.
9. Ask the user before each commit.
10. At the end of the session, update this file. Use ASD-STE100.

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
