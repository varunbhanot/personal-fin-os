# Plan: Slice C, part 1 — Own-account transfers

**Parent plan**: `.claude/plans/statement-pipeline.plan.md`, Slice C, Task 12
**Source PRD**: `.claude/prds/statement-pipeline.prd.md`, milestone 1
**Complexity**: Medium. One migration, one new module, two CLI commands, one profile setting, tests. No AI call.

## Decision: why this is next

| Candidate | Verdict | Reason |
|---|---|---|
| **Task 12, transfers** | **Next** | The PRD rates "card bill payments and self-transfers double-counted" as High likelihood, High impact, and it is a success metric (0). It is deterministic and costs no AI money. The record already holds pairs to test against: card bills paid from bank accounts, and money moved between Axis, SBI and Canara. Task 11 also gains: a matched transfer needs no AI category. |
| Task 11, categorisation | Directly after (part 2) | It needs your category list and household notes first (a PRD open question). It costs AI money on every new transaction, so it should skip transfers. |
| Task 13, monthly views | After Slice C | Income, expenses and savings are wrong until transfers are excluded and transactions are categorised. |
| Task 15, back-fill | After Slice C | About 45 statements. At $0.09 to $0.30 each, extraction alone could use most of the $10 monthly limit ($7.98 is left this month). Running it after Slice C imports, links and categorises each month in one pass. It needs a budget decision. |
| Loose ends | Folded in | The stale "merge the pull request" handoff step is corrected in this slice's handoff update. A Canara loan-balance profile does not serve any milestone 1 metric, so it waits. |

## Requirements restated
1. Find pairs of transactions that move money between two of your own accounts: a debit in one account and a credit of the same amount in another, within 5 days. Card bill payments are the common case: a bank debit and the card's "payment received" credit.
2. A paired transaction is neither income nor expense. Task 13's views will leave it out.
3. Never guess. A pair needs evidence beyond amount and date (see "Matching rule"). When two candidates fit equally, nothing is paired and both are reported.
4. Report the candidates that are still unpaired: a debit that names one of your accounts but has no matching credit yet. Usually the other statement is simply not imported yet.
5. The pairing survives a re-import. A replaced statement gets new transaction IDs (`store.py:_with_ids` hashes the statement ID into each row), so links are rebuilt from scratch on each run, never patched.
6. No narration text appears in any output. Rows are named by source, date, amount and direction, as `verify._row` does.

## Matching rule
A debit D in account A and a credit C in account B are a pair when all of these hold:
- A and B are different accounts, and both are yours (every source in `finos/sources` is yours).
- The amounts are equal to the paisa.
- C's date is 0 to 5 days after D's date. A card payment can post on the card a few days later.
- **Evidence:** D's narration names B, or C's narration names A. Names come from two places:
  - the profile setting `transfer_markers`, which holds public text such as IFS prefixes and card names (sbi-card: "SBI Card"; canara-bank: "CNRB", "Canara"; sbi-bank: "SBIN"; axis-bank: "UTIB", "Axis"; hdfc-tataneu: "HDFC", "Tata Neu");
  - your own handles (UPI IDs, account digits), which `finos accounts add` stores in the database, never in the repo.
- Exactly one candidate fits on each side. Otherwise nothing is paired and the candidates are reported as ambiguous.

Without the evidence rule, a ₹2,000 UPI payment to a friend and an unrelated ₹2,000 credit to your SBI account in the same week would pair by mistake. That is the "lookalike that isn't yours" case in the parent plan.

## Patterns to mirror
| Category | Source | Pattern |
|---|---|---|
| Schema | `src/finos/migrations/0001_init.sql` | Numbered SQL files, applied by `migrate.py`; comments explain the keys |
| Atomic writes | `src/finos/store.py:store_statement`, `db.batch` | One `batch` per logical change, so a failure leaves nothing half-written |
| Profile settings | `src/finos/identify.py:_profile` | Optional key, validated, `ConfigError` names the file and the key |
| Row naming | `src/finos/verify.py:_row` | Position, date, amount, direction; never narration |
| CLI | `src/finos/cli.py` | Typer command, `_session()`, `_plain()` on every printed value |
| Tests | `tests/test_store.py`, `migrated_db` fixture | Synthetic statements stored in a throwaway Postgres, then asserted with SQL |

## Files to change
| File | Action | Why |
|---|---|---|
| `src/finos/migrations/0002_transfers.sql` | CREATE | `account_handles` (source, handle text) and `transfer_links` (debit and credit txn IDs, both `on delete cascade`, each txn in at most one link) |
| `src/finos/transfers.py` | CREATE | Load candidates, apply the matching rule, rebuild links in one batch, return pairs, unpaired and ambiguous rows |
| `src/finos/identify.py` | UPDATE | Optional `transfer_markers` list on a profile |
| `src/finos/sources/*.yaml` | UPDATE | `transfer_markers` for each of the five sources |
| `src/finos/cli.py` | UPDATE | `finos transfers` (rebuild and report), `finos accounts` (list) and `finos accounts add <source> <handle>` |
| `src/finos/sync.py` | UPDATE | Rebuild transfer links at the end of every sync that imported or replaced a statement |
| `src/finos/report.py` | UPDATE | `finos status` shows the number of linked pairs and unpaired candidates |
| `tests/test_transfers.py` | CREATE | The cases below |
| `tests/test_identify.py`, `tests/test_cli.py`, `tests/test_sync.py` | UPDATE | Profile setting, commands, rebuild after sync |
| `README.md`, `docs/handoff.md`, parent plan | UPDATE | Commands, status, handoff in ASD-STE100 |

## Tasks

### C1.1 Migration and matching (tests first)
- Tests in `tests/test_transfers.py`, with synthetic statements:
  1. An SBI Card bill paid from Axis pairs: Axis debit "SBI Card" with the card's credit 2 days later.
  2. SBI to Axis by NEFT ("UTIB" in the SBI narration) pairs.
  3. A lookalike does not pair: the same amount and week, but no narration names the other account.
  4. A pair split across statement periods pairs (the debit on 30 Sep in one statement, the credit on 2 Oct in the next).
  5. Two equal candidates: nothing pairs, and both are reported as ambiguous.
  6. A debit that names an account whose statement is not imported is reported as unpaired.
  7. A user handle from `account_handles` is evidence.
  8. Replacing a statement and rebuilding gives the same pairs, by date and amount.
  9. Rebuilding twice changes nothing.
  10. No output contains a narration.
- Then the migration and `transfers.py`.

### C1.2 Profile setting and markers
- `transfer_markers`: optional list of text, validated like `extra_date_formats`.
- Add the markers above to the five profiles. Confirm on the real record with C1.4, because the free run shows which pairs each marker finds.

### C1.3 Commands
- `finos transfers` rebuilds the links and prints pairs and unpaired candidates. It uses the database only and makes no Claude call.
- `finos accounts` lists the accounts seen in statements and their handles. `finos accounts add <source> <handle>` adds a handle. Handles are personal, so they go to the database and are never printed in logs.
- `finos sync` rebuilds the links when a statement was imported or replaced. `finos status` adds a transfers line.

### C1.4 Real run (free)
1. Run `uv run finos transfers` on the five statements already in the record. No Claude call, no cost.
2. Check the pairs with you by source, date and amount. You confirm that each pair is yours.
3. If a real transfer is unpaired, add a marker or a handle and run it again. Never change a figure.

### C1.5 Review, docs and commit
- Review: `python-reviewer` and `database-reviewer`. Fix every CRITICAL and HIGH finding.
- Docs: README commands, parent plan status, handoff in ASD-STE100 (including the corrected merge step).
- Gate 2: diff summary and commit messages. Nothing is committed until you confirm. Then ask you about a pull request.

## Part 2 preview: Task 11, categorisation (separate plan and approval)
- Needs from you: the category list (or approval of a default list), household notes, and how fine-grained the categories should be.
- Design already fixed by the parent plan: memory of confirmed counterparties first, then batched Claude calls with your corrections as examples, a review queue, and `finos review` and `finos correct`.
- Linked transfers get no AI call.
- Like links, categorisations must survive a statement replacement: memory is kept by counterparty, not by transaction ID.

## Validation
```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80
uv run finos check
uv run finos transfers     # free: database only
uv run finos status
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| A real transfer has no marker in either narration (for example a bare UPI ID) | Medium | It shows as unpaired, not as spending in disguise. You add the UPI ID as a handle, and it pairs on the next run. |
| A false pair from a coincidental amount | Low | Evidence rule plus the one-candidate rule. Every pair is listed for you to check in C1.4. |
| A pair whose other half is in a statement not yet imported | High until the back-fill | Reported as unpaired. Rebuilding after each sync pairs it later. |
| Links lost when a statement is replaced | Certain without care | Links are rebuilt from scratch after each change, never patched. A test covers it. |
| A card refund or reversal mistaken for a payment | Low | A refund's narration names the merchant, not one of your accounts, so the evidence rule leaves it alone. |

## Acceptance
- [ ] Every test in C1.1 passes, and coverage stays at 80% or more.
- [ ] `finos transfers` on the real record lists each pair by source, date and amount, and you confirm each one.
- [ ] Rebuilding twice gives the same pairs.
- [ ] No narration appears in any output.
