# Plan: Slice B, part 1 — SBI Card Aurum and Axis Bank

**Parent plan**: `.claude/plans/statement-pipeline.plan.md`, Slice B, Tasks 7 and 8
**Size**: standard. Two new profiles, small changes to `identify.py`, `sync.py` and `cli.py`, and tests. A security review joins because the new command unlocks PDFs with passwords from Doppler.
**Out of scope**: SBI bank account (Task 9) and Canara loan (Task 10). They come in a later session.

## Starting state (2026-10-19)
- `finos check` passes. Drive shows 3 PDFs: the HDFC statement already in the record, and the new Axis Bank and SBI Card statements.
- `finos check` lists only the secrets that a profile names. It will show `PW_AXIS_BANK` and `PW_SBI_CARD` once their profiles exist.
- Without profiles, `finos sync` reports both new PDFs as failed ("matches no source profile"). This costs nothing, because identification runs before any Claude call.

## What the research says about the layouts
Sources: third-party copies of real statements (court filings, Scribd uploads) and SBI Card's FAQ. They may be older than your statements, so the real run decides.
- **Axis Bank**: a heading "Statement of Axis Account No ... for the period". Columns Tran Date, Chq No, Particulars, Debit, Credit, Balance, Init. Br. An OPENING BALANCE line, a TRANSACTION TOTAL row with total debits and credits, and a CLOSING BALANCE line. Some statements add a charge breakup section.
- **SBI Card**: an account summary with Previous Balance; Payments, Reversals & other Credits; Purchases & Other Debits; Fee, Taxes & Interest Charges; and Total Outstanding. Total Amount Due can differ from Total Outstanding by the balance of Flexipay or EMI plans.

## Risks this plan handles
1. **A bank statement names a card in its narrations.** If you pay SBI Card or HDFC Tata Neu from Axis, the Axis statement can contain "SBI Card", "HDFC Bank" or "Tata Neu". A card profile would then also match, and the file would fail as "matches more than one source profile". So each card profile also needs a phrase that only card statements print, such as "Minimum Amount Due". This also applies to the HDFC profile.
2. **SBI Card prints debits on two summary lines** (purchases, and fees with taxes). There is no single printed total of debits to copy, so `total_debits` is null for SBI Card. The closing check still covers every row exactly. If SBI Card also rounds the amount due, the rounding rule needs both totals; I will then add a profile setting, tests first, and tell you before I do.
3. **Guessing markers costs a paid run.** A new free command, `finos identify`, shows which profile each PDF matches without calling Claude, so markers are settled before any paid call.

## Task list

### B1. Free identification diagnostics (tests first)
- When a statement matches no profile, the message names each profile's missing markers. It shows only the marker text from our profiles, never statement text.
- New command `uv run finos identify`. For each PDF in the Drive folder, it downloads, unlocks and reads the text, then prints the matched profile or the reason it failed. It makes no Claude call and does not use the database.
- `sync` and `identify` share one open-and-identify step, so they cannot disagree.
- Tests: the missing-marker message, the command with a fake Drive, and a wrong password reported per file.

### B2. SBI Card profile, `src/finos/sources/sbi-card.yaml` (Task 7)
- `kind: card`, `password_secret: PW_SBI_CARD`, first-guess markers `[SBI Card, Minimum Amount Due]`, `period_slack_days: 5` (as for HDFC).
- Hints: closing is the Total Amount Due, not Total Outstanding. An amount marked C is a credit, and one marked D is a debit. `total_debits` is null, because purchases and fees are printed on separate summary lines. `total_credits` is the "Payments, Reversals & other Credits" figure. Include the rows of add-on cards. Skip reward point lines.

### B3. Axis Bank profile, `src/finos/sources/axis-bank.yaml` (Task 8)
- `kind: bank`, `password_secret: PW_AXIS_BANK`, first-guess markers `[Axis Bank, Statement of Axis Account]`.
- Hints: opening and closing are the OPENING BALANCE and CLOSING BALANCE lines. `total_debits` and `total_credits` are the TRANSACTION TOTAL row. These three lines are not transactions. Every row prints a running balance. Skip the charge breakup section, because its charges are already rows in the table.

### B4. A card-only marker for HDFC Tata Neu
- Add the card-only phrase to the HDFC markers, but only after `finos identify` confirms it on the real HDFC file.
- Test: a synthetic Axis statement whose narrations name SBI Card, HDFC Bank and Tata Neu identifies as `axis-bank`.

### B5. Synthetic tests for the formulas
- The bank formula already has an Axis-style test. Add an SBI-style card test: a fee row, `total_debits` null, C and D rows. It must pass. The same statement with the fee row dropped must be flagged.
- The shipped-profiles test checks all three profiles: their kinds, secrets and settings, and that no two profiles name the same password secret.

### B6. Real run in this session
1. Run `uv run finos check`. It must list `PW_AXIS_BANK` and `PW_SBI_CARD` as ok.
2. Run `uv run finos identify` (free). Each file must match its own profile. Adjust markers until it does.
3. Run `uv run finos sync` once. **Cost:** 1 or 2 Claude calls per new statement, about $0.10 to $0.25 each, so $0.50 at most. This month's spend is $0.30 of the $10 limit. Approving this plan approves this one sync.
4. If a statement is flagged, correct the profile hints or settings, never a figure. I will ask you before each `finos sync --retry-flagged`, because each retry costs money.
5. Run `uv run finos sync` again. Every file must show "unchanged", with no Claude call.

### B7. Review, docs and commit
- Review: `python-reviewer` and `code-reviewer`, plus `security-reviewer` for the new command. Fix every CRITICAL and HIGH finding.
- Docs: the README command list, the parent plan's Slice B status, and `docs/handoff.md` (in ASD-STE100).
- Gate 2: I show the diff summary and the commit messages (`feat:` for B1 to B5, `docs:` for the docs). Nothing is committed until you confirm.

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
- [ ] `finos identify` matches each of the three real files to its own profile.
- [ ] The Axis Bank and SBI Card statements are "ok", or "flagged" with the gap shown.
- [ ] A second `finos sync` shows every file unchanged, with no Claude call.
- [ ] All tests pass, and coverage stays at 80% or more (now 97%).
