# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-18
- **Branch:** `claude/statement-pipeline-plan`
- **Last commits:** `55fc577` (pipeline code), `3dcadc8` (ECC lock)
- **Plan:** `.claude/plans/statement-pipeline.plan.md`
- **Milestone:** 1, "Trusted monthly record". Slice A is complete. Slices B, C and D are not started.

## 1. Status

### 1.1 Work that is complete

1. The plan is approved. The design uses Claude Code cloud sessions only. Nothing runs on your computer.
2. The `finos` tool has three commands:
   - `uv run finos check` examines the settings, the secret names, the database and the Drive folder. It does not show secret values.
   - `uv run finos sync` downloads new statement PDFs from Google Drive. It opens each PDF with its password from Doppler. Claude reads the transactions from the PDF.
   - `uv run finos status` shows the statements in the record, their problems and the AI cost.
3. After Claude reads a statement, the code does five checks. The checks compare the result with the printed totals, the running balances, the PDF text, the statement period and the account number.
4. If a check fails, Claude tries one more time. If the check fails again, the statement gets the status "flagged" with the problem. The code does not guess a value.
5. The record is a Neon Postgres database. The record stays after each session ends.
6. The network secrets of the cloud environment send the Neon and Doppler credentials. These credentials do not go into the session.
7. The tests use a temporary Postgres database and fake services. They do not need credentials. 183 tests pass. The test coverage is 97%.
8. Two reviewers examined the code, one for Python and one for security. All important findings are corrected.
9. The ECC plugin is locked to release `v2.2.3`.

### 1.2 Work that is not complete

1. No real statement has gone through the pipeline.
2. Task 0 (the connection test) needs your setup. Do the setup first (section 2).
3. Task 5 is not complete until the pipeline reads one real HDFC Tata Neu statement.
4. Only the HDFC Tata Neu profile exists. The profiles for the other four sources come in Slice B.
5. Categories, transfers, monthly totals, spread costs and goals come in Slices C and D.

## 2. Procedure for you: one-time setup

> **WARNING:** Do not type a secret in the chat. A secret is a password, an API key, a token or a connection string. Put secrets only in Doppler or in the "Network secrets" form.

> **CAUTION:** Do not add the environment variable `ANTHROPIC_API_KEY`. If you add it, Claude Code uses it for the full session, and the cost goes to that key.

Use a browser for all steps. The setup takes approximately 25 minutes.

### 2.1 Cloud environment

1. In the session title bar, open the cloud environment menu.
2. Make a new environment. Use it only for this repository.
3. Set "Network access" to "Custom".
4. Keep "Also include default list of common package managers" selected.

### 2.2 Neon (the database)

1. Make a free Neon project.
2. Copy the connection string of the project.
3. In the environment settings, open "Network secrets". Add a secret with these values:
   - **Allowed websites:** `api.<region>.aws.neon.tech`
   - **Header name:** `Neon-Connection-String`
   - **Prefix:** none (remove the prefix)
   - **Value:** the connection string
4. Add the environment variable `FINOS_NEON_HOST`. Its value is the endpoint host only, for example `ep-quiet-sky-123456.<region>.aws.neon.tech`.

### 2.3 Anthropic Console (the API key)

1. Make a workspace with the name `finos`.
2. Set a monthly spend limit for the workspace.
3. Make an API key in this workspace. Keep it for step 2.4.2.

### 2.4 Doppler (the passwords and the API key)

1. Make the project `finos` with the config `prd`.
2. Add these secrets:
   - **`PW_HDFC_TATANEU`, `PW_SBI_CARD`, `PW_AXIS_BANK`, `PW_SBI_BANK`, `PW_CANARA_LOAN`:** the statement passwords.
   - **`ANTHROPIC_KEY`:** the API key from step 2.3.
3. Make a read-only service token for `finos/prd`. Set an expiry date, for example 12 months.
4. In the environment settings, open "Network secrets". Add a secret with these values:
   - **Type:** Bearer
   - **Allowed websites:** `api.doppler.com`
   - **Value:** the service token

### 2.5 Google Drive (the statements)

1. Make a Google Cloud project. Turn on the Drive API.
2. Make a service account with no project roles. Download its JSON key.
3. In Google Drive, make the folder `Finance/Statements`.
4. Share the folder with the email address of the service account. Give it the "Viewer" role.
5. Put the JSON key in one place:
   - If the "Network secrets" form has a GCP or service-account type, add the key there for `www.googleapis.com`.
   - If it has no such type, add the key to Doppler as `GDRIVE_SA_JSON`.
6. Add the environment variable `FINOS_DRIVE_FOLDER_ID`. Its value is the folder ID from the folder URL.
7. Put one HDFC Tata Neu statement PDF in the folder.

### 2.6 Account security

1. Turn on two-factor sign-in for claude.ai, Doppler, Google, Neon and the Anthropic Console.

## 3. Procedure for the next session

### 3.1 You

1. Start a new session in the environment from step 2.1.
2. Tell Claude which setup steps are complete.

### 3.2 Claude

1. Read this file and the plan.
2. Run `uv run finos check`. Tell the user the result. Do not show secret values.
3. If the check fails, tell the user which step in section 2 to correct. Stop until the user corrects it.
4. Run `uv run finos sync` for the HDFC Tata Neu statement.
5. Run `uv run finos status`. Tell the user the result.
6. If the statement is "flagged", correct the source profile or the check formula. Do not change a figure. Then run `uv run finos sync --retry-flagged`.
7. When the HDFC Tata Neu statement is "ok", start Slice B (the other four sources).
8. Use the ECC sequence: plan, tests first, implementation, review. Ask the user before each commit.
9. At the end of the session, update this file. Use ASD-STE100.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($10) continues to apply.
2. The ECC lock uses a release tag. The publisher can move a tag. After an ECC update, examine `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json`.
3. The Neon network secret with a custom header is not tested. Task 0 tests it. If it fails, Claude moves the connection string to Doppler and tells you.
4. The text markers in the HDFC Tata Neu profile are estimates. The first real statement confirms or corrects them.
