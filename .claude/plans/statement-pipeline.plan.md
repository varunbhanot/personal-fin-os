# Plan: Statement Pipeline — Trusted Monthly Record

**Source PRD**: `.claude/prds/statement-pipeline.prd.md`
**Selected Milestone**: 1 — Trusted monthly record
**Complexity**: Large

## Summary
A local Python command-line tool, `finos`, unlocks the password-protected PDF statements in `statements/`, extracts every transaction with a parser written for each of the five sources, and checks each statement against its own printed totals. It writes the results to a SQLite file in `private/`. On top of the raw transactions it records categories, own-account transfers, spread costs and goal budgets. SQL views then give income, expenses by category, savings and investments for each month. The pipeline itself never guesses: numbers come only from the PDF, and anything that doesn't reconcile is flagged.

## Decisions this plan makes (PRD open questions)
| Question | Decision | Why |
|---|---|---|
| Where statements and the record live | On your machine. Statements go in `statements/` and the record in `private/finance.db` (SQLite), both git-ignored. | The PRD says it runs locally with no hosted server. SQLite needs nothing installed, any AI tool can query it, and backing it up means copying one file. S3 or Drive sync can come later and changes nothing here. |
| Where passwords live | The OS keychain, through the `keyring` library, under one entry per source (`finos passwords set sbi-card`). | Passwords never sit in a file in the repo folder, which Claude Code could read and echo into a transcript. |
| Starting category list | A short default list (`categories.default.yaml`, committed: names only, no personal data), revised after the first real month. | The PRD says this needs validating against real data, so start small and cheap to change. |
| Spreading and goal setup | You set them up through CLI commands. There are no automatic suggestions in this milestone. | This is the smallest version that meets the PRD. Suggestions fit under milestone 4, Insights. |
| Tech stack | Python 3.12+, `uv`, `pikepdf` to unlock, `pdfplumber` to extract, stdlib `sqlite3`, `typer` for the CLI, `pytest` and `ruff`. | These are the strongest PDF tools available, and none of them needs a server. |

## Patterns to Mirror
No application code exists yet. The repo holds only the PRD, ECC settings and docs, so there are no naming, error, logging, data-access or test patterns to copy. This plan sets them, and later work should follow it:

| Category | Source | Pattern |
|---|---|---|
| Private data | `.gitignore:7-9`, `CLAUDE.md` "Financial data" | Statements, the database and any account details live only in `private/` or `statements/`. Test fixtures are synthetic. |
| Tooling ignores | `.gitignore:16-20` | `.venv/`, `__pycache__/` and `coverage/` are already ignored, so this fits a Python setup with `uv`. |
| Naming (new) | — | Package `finos`, one module per concern (`unlock`, `extract`, `parsers/<source>`, `reconcile`, `store`, `categorise`, `transfers`, `spread`, `report`), and source IDs `sbi-card`, `hdfc-tataneu`, `axis-bank`, `sbi-bank`, `canara-loan`. |
| Errors (new) | — | Typed exceptions (`WrongPassword`, `UnknownLayout`, `ReconcileMismatch`). Import reports each one per file and moves on to the next file, so it never stops halfway through a batch. A mismatch is stored as a flag, never raised and dropped. |
| Logging (new) | — | Stdlib `logging`, with an INFO summary per statement. Account numbers are masked to their last 4 digits, and passwords and full narrations are never logged. |
| Tests (new) | — | `tests/` mirrors `src/finos/`. Parser tests run on synthetic text-line fixtures under `tests/fixtures/<source>/`. Optional golden tests in `tests/golden/` run against your real PDFs in `statements/` and skip themselves when those files are absent. |

## Architecture
```
statements/*.pdf
  → unlock      (pikepdf + keyring password per source; source detected from page text)
  → extract     (pdfplumber → pages of text lines/words)
  → parse       (per-source parser → ParsedStatement: header totals + transactions)
  → reconcile   (printed totals and running balances vs parsed rows → ok | flagged(gap))
  → store       (SQLite, idempotent upsert keyed by statement fingerprint + txn id)
  → enrich      (categorise via rules · pair own-account transfers · apply spread rules / goals)
  → views       (v_transactions, v_monthly_summary, v_monthly_by_category, v_goal_progress)
```

**Data model (SQLite):** `accounts` (source, kind, last 4 digits, your UPI handles), `statements` (fingerprint, source, account, period, printed totals, reconcile status, gap), `transactions` (deterministic id, statement, date, amount, direction, raw narration, normalised counterparty), `categories`, `category_rules` (match key → category, with a priority; your corrections become rules), `transaction_category` (category plus where it came from: rule, manual or uncategorised), `transfer_links` (the debit and credit sides, or one side with no match), `spread_rules` (match → number of months), `goals` and `goal_transactions`.

**Repeatability:** a statement's fingerprint is the SHA-256 of its unlocked page text. A transaction's ID is a hash of the statement fingerprint, date, amount, direction, narration and its position among identical rows. Importing the same file again changes nothing. A different file for the same account and period replaces that statement's rows in one database transaction and reports what changed.

## Files to Change
| File | Action | Why |
|---|---|---|
| `pyproject.toml` | CREATE | Package, dependencies, `finos` entry point, ruff and pytest config |
| `src/finos/cli.py` | CREATE | `import`, `status`, `passwords`, `accounts`, `categorise`, `rule`, `spread`, `goal` and `month` commands |
| `src/finos/models.py` | CREATE | `ParsedStatement`, `Transaction` and `PrintedTotals` dataclasses, with amounts held as `Decimal` |
| `src/finos/unlock.py` | CREATE | Unlocks a PDF in memory with the keychain password. Never writes an unlocked copy to disk. |
| `src/finos/extract.py` | CREATE | Turns a PDF into lines and words for each page |
| `src/finos/detect.py` | CREATE | Identifies which of the five sources a file comes from by marker text |
| `src/finos/parsers/{sbi_card,hdfc_tataneu,axis_bank,sbi_bank,canara_loan}.py` | CREATE | One parser per layout |
| `src/finos/reconcile.py` | CREATE | Checks for card, bank and loan statements |
| `src/finos/store.py` + `schema.sql` | CREATE | Schema, migrations, idempotent upsert, views |
| `src/finos/normalise.py` | CREATE | Narration → counterparty key, stripping UPI and IMPS reference numbers, dates and IDs |
| `src/finos/categorise.py` | CREATE | Applies rules. A correction becomes a rule and is applied again to rows that aren't marked manual. |
| `src/finos/transfers.py` | CREATE | Matches each card payment and self-transfer to its other side across your accounts |
| `src/finos/spread.py` | CREATE | Spread rules and goal budgets → amounts per month |
| `src/finos/report.py` | CREATE | `finos month YYYY-MM` and `finos status` output |
| `categories.default.yaml` | CREATE | Starting category list, including Investments and Transfer |
| `tests/**` | CREATE | Unit, parser, idempotency and end-to-end tests; synthetic fixtures; golden tests |
| `README.md` | UPDATE | Setup, monthly routine, querying the record |
| `.gitignore` | UPDATE | Add `*.db`, `*.db-*` |
| `.claude/prds/statement-pipeline.prd.md` | UPDATE | Milestone 1 → in-progress, with a link to this plan |

## Tasks
Each slice ends green and can ship as its own pull request.

### Slice A — Skeleton and one source end to end
#### Task 1: Project scaffold
- **Action**: Add `pyproject.toml` (uv, Python 3.12+, src layout), the `finos` entry point, ruff, pytest with coverage, and the `.gitignore` additions.
- **Mirror**: The existing `.gitignore` entries for `.venv`, `__pycache__` and `coverage`.
- **Validate**: `uv run finos --help` and `uv run pytest`

#### Task 2: Models, store and schema
- **Action**: Dataclasses using `Decimal` for amounts, plus the SQLite schema, migrations and idempotent upsert. Tests come first: importing the same statement twice gives the same row count and IDs, and importing a replacement for the same period swaps the rows.
- **Validate**: `uv run pytest tests/test_store.py`

#### Task 3: Unlock, extract and detect
- **Action**: Store passwords per source with `keyring` and unlock in memory with `pikepdf`. Report a wrong password clearly. Tests build a small PDF in a temporary folder, encrypt it with `pikepdf`, and use an in-memory keyring backend.
- **Validate**: `uv run pytest tests/test_unlock.py tests/test_detect.py`

#### Task 4: First parser plus reconciliation (HDFC Tata Neu)
- **Action**: Write the parser against a synthetic fixture shaped like the real layout. The card check is previous balance + purchases + charges − payments − credits = total due, with each figure taken as printed. A mismatch stores `flagged` and the gap. Start with HDFC because the PDF from the Gmail test already exists.
- **Validate**: Parser and reconcile tests, plus `uv run pytest tests/golden -k hdfc` run on your machine against the real PDF

#### Task 5: `finos import` and `finos status`
- **Action**: Process a folder of PDFs one file at a time and report each file as imported, unchanged, replaced, flagged or failed (with the reason).
- **Validate**: An end-to-end test on a temporary folder of synthetic PDFs

### Slice B — Remaining four sources
#### Task 6: SBI Card Aurum parser
#### Task 7: Axis Bank parser. Bank check: opening + credits − debits = closing, and every row's running balance must agree.
#### Task 8: SBI bank account parser (same check as Axis)
#### Task 9: Canara loan parser. Check the running balance and that the EMI, interest and principal columns add up. Its UPI payments are imported as ordinary transactions.
- **Action (each)**: You run `finos debug-dump <pdf>` locally, which prints the line structure with digits masked. I write a synthetic fixture from that dump, then the parser, test first.
- **Validate**: Parser tests, plus `uv run pytest tests/golden` on your machine with all five sources green or flagged with the gap shown

### Slice C — Meaning: categories and transfers
#### Task 10: Normalisation and categorisation rules
- **Action**: Turn each narration into a counterparty key, for example `UPI/DR/412345678901/SWIGGY/YESB/...` becomes `swiggy`. Load `categories.default.yaml`. `finos categorise` lists uncategorised rows grouped by counterparty. `finos rule add <key> <category>` saves a correction, applies it to matching rows, and leaves manual overrides alone. In-session, Claude can suggest categories for that queue, and you approve them as rules.
- **Validate**: Unit tests on real-shaped narrations (UPI, NEFT, IMPS, POS, ACH/NACH SIP mandates) and a "correction carries forward" test

#### Task 11: Own-account transfers
- **Action**: `finos accounts add` registers your accounts by last 4 digits and your UPI handles. Matching pairs a bank debit with a card or bank credit of the same amount within ±5 days when the narration names one of your accounts or the words "payment received". A matched pair is tagged Transfer and left out of income and expenses. A transfer-like row with no partner is flagged in `status`.
- **Validate**: Tests for a card bill paid from Axis, a move from SBI to Axis, a lookalike that is not your account, and a pair split across a statement boundary

### Slice D — Monthly answers
#### Task 12: Monthly views
- **Action**: Views per the PRD definitions: Income (incoming, not a transfer, not a refund), Expenses (outgoing, not a transfer, net of refunds, with the full EMI included), Savings = Income − Expenses, and Investments (category Investments: SIP, brokerage, PPF, FD). `finos month 2026-03` prints the summary.
- **Validate**: A test that pins the expected numbers for a synthetic month containing every kind of row

#### Task 13: Spread costs and goals
- **Action**: `finos spread add --match <key> --months 3` spreads a matching payment evenly across the months it covers, with the cent remainder put in the last month. `finos goal add trip-2026 --budget 300000 --months 12` and `finos goal assign` link transactions to a goal. The views show both a cash view and a spread view, and `v_goal_progress` shows budget against actual spend by month.
- **Validate**: A school fee of ₹45,000 paid in April shows ₹15,000 in each of April, May and June. A trip charged across three months adds up against its budget.

#### Task 14: History back-fill and docs
- **Action**: Import January 2026 onward. Write the README sections: one-time setup, the 15-minute monthly routine, and example SQL queries.
- **Validate**: `finos status` lists every month from 2026-01 for every source

## Validation
```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80
# On your machine only, with real statements in statements/:
uv run pytest tests/golden
uv run finos import statements/ && uv run finos import statements/   # second run: all "unchanged"
uv run finos status
uv run finos month 2026-03
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| **The parsers need your real PDFs, which this cloud session doesn't have and must never commit** | Certain | Slice B is done with you: `finos debug-dump` runs locally and masks the digits, I turn its output into synthetic fixtures, and the golden tests run only on your machine. |
| A layout differs between months, or between statement and e-statement versions | High | Reconciliation and running-balance checks fail loudly. The detector raises `UnknownLayout` instead of guessing. |
| pdfplumber splits or merges table cells (wrapped narrations, multi-line rows) | Medium | Parsers work from word positions per line, not table extraction. Running-balance checks catch dropped rows. |
| A card statement's printed totals don't follow one formula (EMI conversions, reward credits, GST lines) | Medium | Each card parser has its own formula, written from the printed summary block. Anything that doesn't reconcile is flagged with the gap shown. |
| UPI narrations are too vague to categorise | Medium | Counterparty-key rules carry corrections forward. The uncategorised queue is grouped, so one rule clears many rows. Accuracy is measured from month one. |
| Missed transfer pairs inflate expenses | Medium | Unpaired transfer-like rows appear in `status`. This is tracked against the PRD's target of 0. |
| Keyring has no backend on a headless Linux box | Low | Fall back to a `FINOS_PW_<SOURCE>` environment variable, with a clear message. |
| The database is lost or corrupted | Low | It can be rebuilt from `statements/` alone, because imports are deterministic. Corrections, rules, spreads and goals live in the database, so `finos export-config` writes them to `private/config.json` for backup. |

## Acceptance
- [ ] All tasks complete
- [ ] Validation passes, including golden tests for all five sources on your machine
- [ ] Re-importing any month gives no changes and no duplicates
- [ ] Every imported statement is `ok`, or `flagged` with its gap shown
- [ ] Card bill payments and self-transfers count as 0 in expenses
- [ ] `finos month` answers income, expenses by category, savings and investments for every month since 2026-01
- [ ] Patterns set here are followed consistently, not reinvented later
