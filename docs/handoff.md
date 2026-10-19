# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-19
- **Branch:** `claude/statement-pipeline-plan`
- **Last commits:** the `fix:` commit for the HDFC profile (rounding and date format), `632ab6e` (Neon cell hosts and `finos check`), `f8a7efa` (setup guide)
- **Plan:** `.claude/plans/statement-pipeline.plan.md`
- **Milestone:** 1, "Trusted monthly record". Slice A is complete and tested with a real statement. Slices B, C and D are not started.

## 1. Status

### 1.1 Work that is complete

1. The plan is approved. The design uses Claude Code cloud sessions only. Nothing runs on your computer.
2. The `finos` tool has three commands:
   - `uv run finos check` examines the settings, the secret names, the database and the Drive folder. It examines each part, also when an earlier part fails. It does not show secret values.
   - `uv run finos sync` downloads new statement PDFs from Google Drive. It opens each PDF with its password from Doppler. Claude reads the transactions from the PDF.
   - `uv run finos status` shows the statements in the record, their problems and the AI cost.
3. After Claude reads a statement, the code does five checks. The checks compare the result with the printed totals, the running balances, the PDF text, the statement period and the account number.
4. If a check fails, Claude tries one more time. If the check fails again, the statement gets the status "flagged" with the problem. The code does not guess a value.
5. The record is a Neon Postgres database. The record stays after each session ends.
6. The network secrets of the cloud environment send the Neon and Doppler credentials. These credentials do not go into the session.
7. The tests use a temporary Postgres database and fake services. They do not need credentials. 216 tests pass. The test coverage is 97%.
8. The ECC plugin is locked to release `v2.2.3`.
9. The first real statement is in the record. The HDFC Tata Neu statement of October 2026 has the status "ok", with 29 transactions.
10. A second `finos sync` showed the statement as "unchanged". It did not call Claude again.
11. The AI cost for this month is $0.30. The cost includes two retries of the HDFC Tata Neu statement.

### 1.2 Corrections in this session

1. New Neon projects have a cell part (for example `c-3`) in the host. The code now accepts this part, and keeps it in the SQL address.
2. When the session's proxy does not pass a connection, the message now names the host, the proxy status and the setting to examine.
3. You corrected the Neon network secret. The database connection now works.
4. HDFC prints the total amount due rounded to the nearest rupee. The profile setting `closing_rounded_to_rupee` now permits this. The check permits it only when Claude also reads the printed debit and credit totals.
5. HDFC prints the statement date as "17 Oct, 2026". The profile setting `extra_date_formats` now adds this format to the default formats.
6. When a date is not found, the message now names each other format in which the date appears.
7. The setup guide, the README and the plan now show the cell part in the Neon examples.

### 1.3 Work that is not complete

1. `FINOS_DRIVE_FOLDER_ID` has the ID of the `Finance` folder, not the `Statements` folder. In this session, Claude gave the correct ID to each command. Do the procedure in section 2.1.
2. Only the HDFC Tata Neu profile exists. The profiles for the other four sources come in Slice B.
3. Categories, transfers, monthly totals, spread costs and goals come in Slices C and D.

## 2. Procedure for you

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

Use a browser for all steps.

### 2.1 Correct the Drive folder ID

The folder ID is not secret.

1. Open https://drive.google.com. Open **Finance → Statements**.
2. Copy the part of the address after `/folders/`. This is the `Statements` folder ID.
3. Open https://claude.ai/code. In the title bar of a session, click the environment name `finos`. Click **Edit**.
4. In **Environment variables**, change the value of `FINOS_DRIVE_FOLDER_ID` to the `Statements` folder ID.
5. Do not change the other values.
6. Save the environment.

### 2.2 Prepare Slice B

Slice B adds the other four sources. Claude needs one real statement from each source.

1. Open Doppler, **finos → prd**.
2. Make sure that these secrets exist: `PW_SBI_CARD`, `PW_AXIS_BANK`, `PW_SBI_BANK` and `PW_CANARA_LOAN`. Add each missing password (setup guide, Part 2).
3. Save the latest statement PDF of each source into Google Drive, in **Finance → Statements**.
4. Put each PDF directly in `Statements`, not in a folder inside it.

Until Slice B is complete, `finos sync` shows these four PDFs as "failed". This is correct, because their profiles do not exist yet.

## 3. Procedure for the next session

### 3.1 You

1. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
2. Tell Claude which steps in section 2 are complete.
3. Tell Claude to use the branch `claude/statement-pipeline-plan`. The work is not on `main` until a pull request merges it.

### 3.2 Claude

1. Read this file and the plan.
2. Run `uv run finos check`. Tell the user the result. Do not show secret values.
3. If a part fails, tell the user which setting to correct. Use the message from `finos check` and `docs/setup-guide.md`. Stop until the user corrects it.
4. If Drive shows 0 PDFs, compare `FINOS_DRIVE_FOLDER_ID` with the `Statements` folder ID. Stop until the user corrects it.
5. Start Slice B (plan Tasks 7 to 10). Use the ECC sequence: plan, tests first, implementation, review. Ask the user to approve the plan.
6. Add one profile for each source. Run `uv run finos sync` with the real statement of that source.
7. If a statement is "flagged", correct the source profile or the check formula. Do not change a figure. Use the format names in the date messages.
8. Ask the user before each `finos sync --retry-flagged`. Each retry calls Claude and costs money.
9. Ask the user before each commit.
10. At the end of the session, update this file. Use ASD-STE100.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($10) continues to apply.
2. The ECC lock uses a release tag. The publisher can move a tag. After an ECC update, examine `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json`.
3. The HDFC rounding rule comes from one statement. The rule rounds half up. No statement has shown a value that ends in exactly 50 paise yet. Examine the rule again with the next HDFC statement.
4. With rounding, the printed closing of one statement can be different from the opening of the next statement by less than one rupee. A check that compares statements (Slice C) must permit this.
5. The HDFC hints are still estimates, except for the markers, the rounding and the statement date format.
6. Drive gives 0 PDFs, not an error, when the folder ID is wrong or the service account cannot see the folder. `finos check` does not yet tell these cases apart.
7. The proxy can fail a short outage with the same error as a refusal. The database client tries again; the Doppler and Drive requests do not.
8. `finos check` does not test `api.anthropic.com`. The first `finos sync` of a session is the first Claude call.
9. `finos check` stops if a part raises an error that is not a `FinosError`, for example a Drive reply with a missing field.
10. The auto mode permission classifier stops Claude from probing the proxy, the network secrets and the Neon connection directly. Claude uses only `finos` commands for these checks.
