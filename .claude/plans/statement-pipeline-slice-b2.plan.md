# Plan: Slice B, part 2 — SBI bank and the Canara account

**Parent plan**: `.claude/plans/statement-pipeline.plan.md`, Slice B, Tasks 9 and 10
**Previous part**: `.claude/plans/statement-pipeline-slice-b.plan.md` (Tasks 7 and 8, done)
**Size**: standard. Two new profiles, a small change to `identify.py`, `sync.py` and `cli.py`, tests and docs.

## Starting state (2026-10-19)
- `finos check` passes. Drive holds 5 PDFs. `finos identify` matches the HDFC, Axis and SBI Card files to their own profiles. Those three statements are "ok" in the record.
- AI spend this month: $1.77 of the $10 limit.
- **SBI bank** (`AccountStatement_19102026_165453.pdf`): no password in Doppler opens it. `PW_SBI_BANK` exists, so its value is probably wrong.
- **Canara** (`canara_statement_2026-10-19 ….pdf`): the user confirmed it is the savings account that pays the loan EMI, not the loan account itself. It opens, although `PW_CANARA_LOAN` is not in Doppler. So it has no password, or another `PW_*` value opens it.

## What free identify probes showed on the Canara file
Probed with a throwaway profile whose missing-marker list names only our candidate text. No statement text was printed.
- Present: "Canara", "CNRB", "IFSC", "Customer Id", "Branch Code", "Branch Name", "Product", "Particulars", "Withdrawals", "Deposits", "Opening Balance", "Closing Balance", "Statement", "Page", "Debit Card", "UPI", "NEFT", "IMPS", "ATM", "SMS", "XXXX".
- Absent: "Loan", "Interest", "EMI", "Outstanding", "Total", "Credit", "Value Date", "Statement of Account", "Account Number", "Txn Date", "Transaction Date", "Description", "Narration".
- Dates appear as `dd/mm/yyyy`, `dd-mm-yyyy` and `dd-Mon-yyyy`. All three are already default formats. The period spans September and October 2026.
- It names "Axis Bank" in a narration. The Axis profile still does not match, because "Statement of Account" and "Value Date" are absent.

## Decisions for you
1. **Source id.** The parent plan calls it `canara-loan` (kind `loan`). The file is a savings account, so I propose id `canara-bank`, kind `bank`. The EMI is a debit row in it, so the PRD rule "the full EMI is an expense" still holds.
2. **No password.** If identify confirms that the Canara file has no password, profiles may leave `password_secret` out. `finos check` then expects no secret for it, and `PW_CANARA_LOAN` leaves the setup guide.
3. **The loan balance is not tracked.** Without the loan account's own statement, the record has no outstanding principal. That suits milestone 1 (income, expenses, savings). A loan profile can come later if you want the balance.

## Task list

### C1. Show which secret opened each file (tests first)
- `finos identify` adds the name of the Doppler secret that opened each PDF, or "no password". Only the name, never the value.
- Tests: a file opened by a named secret, and a file with no password.

### C2. Optional password secret (tests first; only if C1 shows "no password" for Canara)
- A profile may leave out `password_secret`. `finos check` then expects no secret for that profile.
- Tests: loading a profile without it, and the expected-secret list in `finos check`.

### C3. Canara profile, `src/finos/sources/canara-bank.yaml` (Task 10)
- `kind: bank`. Markers: "Canara", "Customer Id", "Branch Code", "Withdrawals", "Deposits". Confirm with identify that they match only this file of the five.
- `account_digits`: 4 (the default). The header seems to print the number in full, or masked with its last digits shown. The grounding check confirms it.
- Hints: opening and closing are the Opening Balance and Closing Balance lines, not rows. The statement prints no debit or credit totals: both are null. Withdrawals are debits, deposits are credits. Every row prints a running balance. A balance can carry a Cr or Dr mark: give its size. The EMI paid to the loan account is a normal debit row.

### C4. SBI bank profile, `src/finos/sources/sbi-bank.yaml` (Task 9) — needs your corrected `PW_SBI_BANK`
- `kind: bank`. First-guess markers come from free probes with identify, as for Canara. The SBI IFS prefix "SBIN" and header labels are candidates. A narration that pays an SBI account from Axis or Canara can also contain "SBIN", so the final set is checked against all five files.
- `account_digits` and the date formats come from the same probes.
- Hints as for Canara, adjusted to what the probes find (SBI prints Debit and Credit columns and a "Value Date").

### C5. Synthetic tests
- The shipped-profiles test covers all five profiles: kinds, secrets and settings, and no two profiles naming the same secret.
- A synthetic Canara-style statement (no printed totals, Withdrawals and Deposits, a Cr mark on balances) passes. The same statement with one row dropped is flagged.
- Collision tests: a synthetic Canara statement naming Axis Bank identifies as `canara-bank`. A synthetic Axis statement naming Canara and CNRB identifies as `axis-bank`. The same for SBI.

### C6. Real run
1. Run `uv run finos check` and `uv run finos identify` (free). Every file must match its own profile.
2. **Ask you**, then run `uv run finos sync` once. **Cost:** 2 new statements, 1 or 2 Claude calls each, about $0.10 to $0.25 per call, so $1.00 at most. The spend after this would be at most $2.77 of $10.
3. If a statement is flagged, correct the profile hints or settings, never a figure. Ask you before each `finos sync --retry-flagged`.
4. Run `uv run finos sync` again (free). Every file must show "unchanged", with no Claude call.

### C7. Review, docs and commit
- Review: `python-reviewer` and `code-reviewer`. Fix every CRITICAL and HIGH finding.
- Docs: the README command list, the setup guide (`PW_CANARA_LOAN`), the parent plan's source list and Slice B status, the PRD's Canara line, and `docs/handoff.md` in ASD-STE100. The handoff also catches up on Tasks 7 and 8, which the last session did not record there.
- Gate 2: I show the diff summary and the commit messages. Nothing is committed until you confirm.
- Then I ask you about a pull request into `main`.

## Validation
```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80
uv run finos check
uv run finos identify
uv run finos sync && uv run finos sync    # the second run: all unchanged, no Claude call
uv run finos status
```

## Acceptance
- [x] `finos identify` matches each of the five real files to its own profile.
- [x] `finos status` shows all five sources "ok": Canara 33 transactions, SBI bank 21, each on the first try.
- [x] A second `finos sync` shows every file unchanged, with no Claude call.
- [x] All tests pass (266), and coverage is 98%.

## Outcome
- Decisions 1 and 2 were taken: `canara-bank` (kind `bank`) with no password secret. Decision 3 stands: the loan balance is not tracked.
- `PW_SBI_BANK` first held a wrong value; `finos identify` now names the secret that opens each file, which settled it.
- SBI bank probes: markers "State Bank of India", "Statement of Account", "Drawing Power", "Clear Balance"; the opening is a Brought Forward line; Total Debit and Total Credit are printed; dates are default formats. `account_digits` stays 4, confirmed by the grounding check on the real run.
- Cost of the two paid syncs: $0.25. Spend this month: $2.02 of $10.
