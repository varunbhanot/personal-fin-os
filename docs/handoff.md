# Session handoff: statement pipeline

Written in ASD-STE100 Simplified Technical English. Claude updates this file at the end of each session that builds or changes something.

- **Last update:** 2026-10-19
- **Branch:** `claude/statement-pipeline-plan`
- **Last commits:** the `fix:` commit for Neon cell hosts and `finos check` (this session), `f8a7efa` (setup guide), `55fc577` (pipeline code)
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
7. The tests use a temporary Postgres database and fake services. They do not need credentials. 196 tests pass. The test coverage is 97%.
8. The ECC plugin is locked to release `v2.2.3`.
9. This session corrected three problems that `finos check` found:
   - New Neon projects have a cell part (for example `c-3`) in the host. The code now accepts this part, and keeps it in the SQL address.
   - `finos check` now examines each part, also when an earlier part fails. It shows the Neon SQL address that the network secret must use.
   - When the session's proxy does not pass a connection, the message now names the host, the proxy status and the setting to examine.
10. The setup guide, the README and the plan now show the cell part in the Neon examples.
11. You corrected the Neon network secret in this session. The database connection now works, and the record's tables exist.

### 1.2 Result of `finos check` in this session

1. Settings: ok. The Neon SQL address is `api.c-3.ap-southeast-1.aws.neon.tech`.
2. Secrets: ok. `ANTHROPIC_KEY` and `PW_HDFC_TATANEU` are in Doppler. The Drive key comes from Doppler.
3. Database: ok.
4. Drive: ok, but with 0 PDFs. `FINOS_DRIVE_FOLDER_ID` has the ID of the `Finance` folder, not the `Statements` folder.
5. With the `Statements` folder ID, `finos check` finds 1 PDF. The service account can read it.

### 1.3 Work that is not complete

1. No real statement has gone through the pipeline.
2. `FINOS_DRIVE_FOLDER_ID` is not correct. Do the procedure in section 2 first.
3. Task 5 is not complete until the pipeline reads one real HDFC Tata Neu statement.
4. Only the HDFC Tata Neu profile exists. The profiles for the other four sources come in Slice B.
5. Categories, transfers, monthly totals, spread costs and goals come in Slices C and D.

## 2. Procedure for you: correct the Drive folder ID

The folder ID is not secret. Use a browser for all steps.

1. Open https://drive.google.com. Open **Finance → Statements**.
2. Copy the part of the address after `/folders/`. This is the `Statements` folder ID.
3. Open https://claude.ai/code. In the title bar of a session, click the environment name `finos`. Click **Edit**.
4. In **Environment variables**, change the value of `FINOS_DRIVE_FOLDER_ID` to the `Statements` folder ID.
5. Do not change the other values.
6. Save the environment.

## 3. Procedure for the next session

### 3.1 You

1. Start a new session. Select the repository `personal-fin-os` and the environment `finos`.
2. Tell Claude that the correction in section 2 is complete.
3. Tell Claude to use the branch `claude/statement-pipeline-plan`. The work is not on `main` until a pull request merges it.

### 3.2 Claude

1. Read this file and the plan.
2. Run `uv run finos check`. Tell the user the result. Do not show secret values.
3. If a part fails, tell the user which setting to correct. Use the message from `finos check` and `docs/setup-guide.md`. Stop until the user corrects it.
4. If Drive shows 0 PDFs, compare `FINOS_DRIVE_FOLDER_ID` with the `Statements` folder ID. Stop until the user corrects it.
5. Run `uv run finos sync` for the HDFC Tata Neu statement.
6. Run `uv run finos status`. Tell the user the result.
7. If the statement is "flagged", correct the source profile or the check formula. Do not change a figure. Then run `uv run finos sync --retry-flagged`.
8. When the HDFC Tata Neu statement is "ok", start Slice B (the other four sources).
9. Use the ECC sequence: plan, tests first, implementation, review. Ask the user before each commit.
10. At the end of the session, update this file. Use ASD-STE100.

## 4. Known limits

1. If a Claude reply stops before it is complete, its cost is not recorded. The monthly AI limit ($10) continues to apply.
2. The ECC lock uses a release tag. The publisher can move a tag. After an ECC update, examine `gitCommitSha` for `ecc@ecc` in `~/.claude/plugins/installed_plugins.json`.
3. The text markers in the HDFC Tata Neu profile are estimates. The first real statement confirms or corrects them.
4. Drive gives 0 PDFs, not an error, when the folder ID is wrong or the service account cannot see the folder. `finos check` does not yet tell these cases apart.
5. In this session, the proxy did not pass the first request to `api.doppler.com` one time. Later requests worked. The proxy also fails short outages this way. The database client tries again; the Doppler and Drive requests do not.
6. `finos check` does not test `api.anthropic.com`. The first `finos sync` is the first Claude call.
7. `finos check` stops if a part raises an error that is not a `FinosError`, for example a Drive reply with a missing field.
8. The auto mode permission classifier stops Claude from probing the proxy, the network secrets and the Neon connection directly. Claude uses only `finos` commands for these checks.
