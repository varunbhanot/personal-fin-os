# Plan: Statement Pipeline — Trusted Monthly Record

**Source PRD**: `.claude/prds/statement-pipeline.prd.md`
**Selected Milestone**: 1 — Trusted monthly record
**Complexity**: Large
**Revision**: 2. Runs only in Claude Code cloud sessions, and AI does the extraction and categorisation.

## Summary
Everything runs in Claude Code cloud sessions. Nothing runs on your laptop. You save statement PDFs to a Google Drive folder. In a cloud session, `finos sync` downloads new files, unlocks them with passwords stored in the cloud environment's settings, and asks Claude through your API key to read out every transaction. Code then checks that output against the statement's own printed totals and text. Claude also categorises the transactions, learning from your corrections. The record is a hosted Postgres database (Neon), so it outlives every session and can be reached by any AI tool or dashboard. The pipeline's code is the only part that decides whether a statement is trusted: AI output is accepted only after it passes deterministic checks.

## What changed from revision 1, and why
| Revision 1 | Revision 2 | Why |
|---|---|---|
| Ran on your laptop, with SQLite in `private/` | Runs in Claude Code cloud sessions, with a hosted Neon Postgres database | You don't want to run anything locally, and a cloud container loses its files when the session ends. |
| Passwords in the OS keychain | Passwords stored as environment variables in the cloud environment's settings | A cloud container has no keychain. |
| PDFs in a local `statements/` folder | PDFs saved to a Google Drive folder, which `finos` reads with a Google service account | Statements already arrive in Gmail, and Gmail's "Save to Drive" button works from your phone. Drive also keeps the originals, so the record can always be rebuilt. |
| A hand-written parser per bank, plus regex categorisation rules | Claude reads each statement and categorises the transactions, with code checking the results | You've seen regex-based tools break and leave most transactions uncategorised. AI copes with layout changes and unclear UPI narrations. The checks keep the numbers trustworthy. |

## Decisions
| Question | Decision | Why |
|---|---|---|
| Where the record lives | **Neon Postgres, free plan.** One database, `finos`. | The free plan is permanent, sleeps when idle and wakes up when you connect. It has a web SQL editor, and Postgres works with any AI tool or dashboard (Looker Studio, Metabase, Grafana), which matters for milestones 3 and 4. |
| How the session reaches the database | Neon's **HTTPS SQL endpoint** | I tested this session: outbound connections to database ports such as Postgres 5432 are blocked, and HTTPS works. Neon serves SQL over HTTPS. Turso, which keeps SQLite, is the fallback if this doesn't work out. |
| Where statements come in and are kept | A Google Drive folder, `Finance/Statements`, shared with a service account. `finos` downloads from it through the Drive API. | The Drive and Gmail connectors return files as base64 text that would have to pass through Claude's context, which is slow and fragile for PDFs. The service account lets the code fetch files directly. |
| Where secrets live | Environment variables in the cloud environment's settings: `FINOS_DATABASE_URL`, `FINOS_ANTHROPIC_API_KEY`, `FINOS_GDRIVE_SA_JSON` (base64) and `FINOS_PW_<SOURCE>` for each of the five sources | This is the only secret store a cloud session has. **Don't name the key `ANTHROPIC_API_KEY`**, or Claude Code itself would start billing the whole session to it. The code never prints secrets. Anything in the environment can be read by the session, so treat the environment as private. |
| Who extracts transactions | Claude (`claude-opus-5-5`) through the API, with **structured JSON output**, verified by code | Details under "How AI is used" below. |
| Who categorises | Claude through the API, using your corrections as memory. **No regex rules.** | Details under "How AI is used" below. |
| Which model | `claude-opus-5-5` by default, set per task (`FINOS_MODEL_EXTRACT`, `FINOS_MODEL_CATEGORISE`) | Accuracy matters most here. Once month 1 is checked, we compare cheaper models against it (see Costs). |
| How you run it | Open a cloud session on this repo and say "import new statements" or run `/import`. Queries are just questions in the session. | Works from the Claude app on your phone or in any browser. |

## How AI is used, and how the numbers stay trustworthy
**Extraction.** For each unlocked PDF, Claude receives the document and a short profile of the source (whether it's a card, bank or loan statement, plus layout hints). It returns JSON in a fixed schema: the printed summary totals, and every transaction with its date, amount, debit or credit, narration and running balance where printed. Code then runs four checks:
1. **Totals.** The transactions must add up to the printed summary. For a card: previous balance + purchases + charges − payments − credits = total due. For a bank or loan account: opening + credits − debits = closing.
2. **Running balance.** For bank and loan statements, every row's balance must equal the previous row's balance plus or minus its amount. This catches a dropped or duplicated row.
3. **Grounding.** Every amount and date Claude returns must appear word for word in the PDF's own text layer, read separately with pdfplumber. This catches made-up numbers.
4. **Period.** Every date must fall inside the statement period.

If a check fails, Claude retries once and is told exactly which check failed. If it still fails, the statement is stored as **flagged**, with the gap shown. It is never accepted silently.

**Repeatability.** Each statement's verified result is stored with the file's hash, the model and the prompt version. Importing the same file again reuses the stored result, so it gives identical transactions and never creates duplicates. Claude is called only for files it hasn't seen before, or when you ask for a re-extraction.

**Categorisation.** Claude assigns each new transaction a category, a clean merchant or counterparty name, a type (expense, income, transfer, investment or refund), a confidence level and a one-line reason. With each request it receives:
- the category list, with a description of each category;
- your notes about your household (for example, "UPI to R. Kumar is the cook's salary");
- your past corrections, starting with any for the same counterparty.

Its memory works like this:
- Once you've confirmed or corrected a counterparty, later transactions with that counterparty use your answer directly and don't call Claude.
- Low-confidence results and new counterparties go into a **review queue**. You clear the queue in conversation, for example: "Swiggy is Food; the ₹2,000 to Ramesh is Household help."
- Each correction is saved and becomes an example for later requests.
- Accuracy is the share of transactions you had to correct, measured from month 1.

**Transfers.** Matching is deterministic: a debit and a credit of the same amount within ±5 days, between accounts registered as yours. Claude's "transfer" type is a hint that helps find candidates, but only a matched pair is excluded from income and expenses. A transfer-like row with no match is flagged.

## Costs (your $100 of API credit)
Prices per million tokens, input / output: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50.

These are rough figures, assuming 6 statements a month of about 4 pages each, about 300 transactions a month, and about 2,500 tokens per PDF page:

| | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|
| Back-fill Jan–Oct 2026 (extraction + categorisation, including retries) | ~$15–25 | ~$8–12 | under $1 |
| Each month after that | ~$2–3 | ~$1–1.5 | a few cents |

- **Tracking.** `finos` records every API call's tokens and cost in an `ai_usage` table.
- **Cap.** It refuses to run past a monthly limit (`FINOS_AI_BUDGET_USD`, default $10).
- **Report.** `finos status` shows spend to date.
- **Choosing a model.** After month 1 is verified, `finos eval` re-runs it on a cheaper model and compares the results field by field. You then decide whether to switch.

## Patterns to Mirror
No application code exists yet, so this plan sets the patterns:

| Category | Source | Pattern |
|---|---|---|
| Private data | `.gitignore:7-9`, `CLAUDE.md` "Financial data" | Statements, database contents and account details never enter git. Test fixtures are synthetic. Downloaded PDFs exist only in the session's git-ignored `statements/` folder. |
| Setup | `.claude/hooks/session-start.sh` | Cloud-only steps go in this hook (`CLAUDE_CODE_REMOTE` guard, `warn` and carry on). It gains a `uv sync` step. |
| Naming (new) | — | Package `finos`, one module per concern, and source IDs `sbi-card`, `hdfc-tataneu`, `axis-bank`, `sbi-bank`, `canara-loan`. |
| Errors (new) | — | Typed exceptions (`WrongPassword`, `UnknownSource`, `VerificationFailed`, `BudgetExceeded`). A batch handles each file separately and reports every file's outcome. Verification failures are stored as flags. |
| Logging (new) | — | Stdlib `logging`. Account numbers masked to the last 4 digits. Secrets and narrations never logged. |
| Tests (new) | — | `tests/` mirrors `src/finos/`. The database tests run against a throwaway local Postgres 16, which is installed in the cloud image. Claude and Drive calls are faked with recorded synthetic responses. Live checks (`tests/live/`) run only when their environment variables are set. |

## Architecture
```
Google Drive  Finance/Statements/*.pdf
  → inbox      (Drive API via service account; new = Drive file id + md5 not yet in DB)
  → unlock     (pikepdf; tries FINOS_PW_* passwords; in memory only)
  → identify   (text markers → source profile; UnknownSource if none match)
  → extract    (Claude, PDF document block + profile → JSON schema; cached by file hash)
  → verify     (totals · running balance · grounding vs pdfplumber text · period → ok | flagged + gap)
  → store      (Neon Postgres over HTTPS; idempotent upsert)
  → categorise (memory of confirmed counterparties → else Claude → review queue)
  → transfers  (deterministic pairing across your registered accounts)
  → views      (v_transactions, v_monthly_summary, v_monthly_by_category, v_goal_progress)
```

**Database tables:**
- **Sources and files:** `accounts`, `source_files` (Drive ID, hash), `statements` (period, printed totals, status, gap) and `extractions` (raw JSON, model, prompt version).
- **Transactions:** `transactions`, with a deterministic ID.
- **Categories and memory:** `categories`, `counterparties` (confirmed category, used as memory), `categorisations` (category, kind, confidence, reason, and whether it came from memory, AI or you), `corrections` and `household_notes`.
- **Transfers:** `transfer_links`.
- **Spreads and goals:** `spread_rules`, `goals` and `goal_transactions`.
- **Spend tracking:** `ai_usage`.

**Database access:** a small `Db` interface with `execute` and `batch` (a batch runs as one transaction) has two implementations:
- `NeonHttpDb`, used in cloud sessions;
- `PsycopgDb`, used in tests and by anything that can connect directly.

Both run the same SQL.

## Files to Change
| File | Action | Why |
|---|---|---|
| `pyproject.toml` | CREATE | Package, dependencies (`anthropic`, `pikepdf`, `pdfplumber`, `httpx`, `psycopg`, `google-api-python-client`, `google-auth`, `typer`, `pyyaml`), `finos` entry point, ruff and pytest |
| `src/finos/config.py` | CREATE | Reads `FINOS_*` environment variables, with a clear message for each one that's missing. Never echoes values. |
| `src/finos/db.py` + `schema.sql` + `migrations/` | CREATE | `Db` interface, Neon HTTPS and psycopg implementations, schema, views |
| `src/finos/inbox.py` | CREATE | Lists and downloads new files from the Drive folder |
| `src/finos/unlock.py` / `identify.py` | CREATE | Password unlock in memory, source detection |
| `src/finos/sources/*.yaml` | CREATE | One profile per source: type, text markers, check formula, prompt hints. No personal data. |
| `src/finos/ai.py` | CREATE | Anthropic client with an explicit key and base URL, structured outputs, usage and cost recording, budget cap |
| `src/finos/extract.py` / `verify.py` | CREATE | AI extraction, the four checks, retry once with feedback |
| `src/finos/categorise.py` | CREATE | Memory lookup, AI batch categorisation, review queue, corrections |
| `src/finos/transfers.py` / `spread.py` / `report.py` | CREATE | Transfer pairing, spreads and goals, `month` and `status` output |
| `src/finos/cli.py` | CREATE | `sync`, `status`, `review`, `correct`, `note`, `accounts`, `spread`, `goal`, `month`, `sql`, `eval`, `reextract` |
| `categories.default.yaml` | CREATE | Starting categories with descriptions, including Investments and Transfer |
| `.claude/skills/import/SKILL.md`, `.claude/skills/month/SKILL.md` | CREATE | The monthly routine, run in the session: sync, then review, then summary |
| `.claude/hooks/session-start.sh` | UPDATE | Add a `uv sync` step |
| `tests/**` | CREATE | Unit, database, verification, idempotency and end-to-end tests with fakes; opt-in live tests |
| `README.md` | UPDATE | One-time setup (Neon, Drive, environment variables), monthly routine, example queries |
| `.claude/prds/statement-pipeline.prd.md` | UPDATE | Milestone 1 → in-progress; scope changed from local to cloud; storage question answered |

## One-time setup you do (all in a browser, about 20 minutes)
1. **Neon:** create a free project and copy the connection string into `FINOS_DATABASE_URL`.
2. **Google Cloud:** create a project and turn on the Drive API.
3. **Service account:** create one, download its JSON key, base64 it, and store it in `FINOS_GDRIVE_SA_JSON`.
4. **Drive:** create the folder `Finance/Statements` and share it with the service account's email address.
5. **Anthropic Console:** create an API key and store it in `FINOS_ANTHROPIC_API_KEY`.
6. **Statement passwords:** add `FINOS_PW_SBI_CARD`, `FINOS_PW_HDFC_TATANEU`, `FINOS_PW_AXIS_BANK`, `FINOS_PW_SBI_BANK` and `FINOS_PW_CANARA_LOAN`.

To add each value, open the cloud environment menu in the session's title bar, choose Edit, and add it under Network secrets if that section is offered, or as an environment variable otherwise. New sessions pick values up. **Never paste them into the chat.** Network access must allow `*.neon.tech`, `www.googleapis.com`, `oauth2.googleapis.com` and `api.anthropic.com`. The current setting already does.

I'll write a step-by-step version of this into the README in Task 1.

## Tasks
Each slice ends green and ships as its own pull request.

### Slice A — Cloud foundation and one source end to end
#### Task 0: Connectivity spike (needs your one-time setup)
- **Action**: Write a throwaway script that, from a cloud session, runs `select 1` on Neon over HTTPS, lists the Drive folder through the service account, and makes one small Claude call with `FINOS_ANTHROPIC_API_KEY`. Nothing is committed but the result.
- **Validate**: All three succeed. If Neon over HTTPS fails, switch to Turso before going further.

#### Task 1: Scaffold
- **Action**: Add `pyproject.toml`, the `finos` entry point, `config.py` with missing-variable messages, the `uv sync` hook step, and the README setup guide.
- **Mirror**: The guard and warning style in `.claude/hooks/session-start.sh`.
- **Validate**: `uv run finos --help` and `uv run pytest`

#### Task 2: Database layer
- **Action**: Write tests first against a throwaway local Postgres 16 started by a pytest fixture: migrations apply, upsert is idempotent, and a replacement statement swaps its rows. Then build the `NeonHttpDb` implementation and test it with mocked HTTP, plus an opt-in live test.
- **Validate**: `uv run pytest tests/test_db.py`, plus `uv run pytest tests/live -k neon`

#### Task 3: Inbox, unlock and identify
- **Action**: Find new Drive files by ID and md5, using a faked Drive client in tests. Unlock by trying each `FINOS_PW_*` password in memory, tested on a small PDF encrypted with pikepdf during the test. Identify the source from its profile's text markers.
- **Validate**: `uv run pytest tests/test_inbox.py tests/test_unlock.py tests/test_identify.py`

#### Task 4: AI client, budget and usage
- **Action**: An `anthropic` client built with an explicit `api_key` and `base_url="https://api.anthropic.com"`, because this session sets its own `ANTHROPIC_BASE_URL`. Add structured outputs, refusal handling, typed error handling, the `ai_usage` table and the budget cap.
- **Validate**: Unit tests with a fake client, covering the budget cap and cost arithmetic

#### Task 5: Extraction and verification (HDFC Tata Neu first)
- **Action**: Write the verification checks test first, against synthetic statements, including deliberately broken ones: a dropped row, a made-up amount, a total that's off, and a date outside the period. Then the extraction prompt, the JSON schema, retry with feedback, and caching by file hash.
- **Validate**: `uv run pytest tests/test_verify.py tests/test_extract.py`, then in-session `finos sync` against your real HDFC statements in Drive, giving ok or flagged with the gap

#### Task 6: `finos sync` and `finos status`
- **Action**: The whole flow for each file, reporting each as imported, unchanged, replaced, flagged or failed. Status lists every statement by month and source, plus AI spend.
- **Validate**: An end-to-end test with fakes, then run it twice on real files. The second run must show every file unchanged and no Claude calls.

### Slice B — Remaining four sources
#### Task 7: SBI Card Aurum · Task 8: Axis Bank · Task 9: SBI bank · Task 10: Canara loan
- **Action (each)**: Add a source profile (YAML) and its check formula. No parser code. Check it against your real statements in Drive during the session. If a statement is flagged, adjust the profile hints or the formula, never the numbers. Add a synthetic test for each formula.
- **Validate**: `finos status` shows all five sources ok, or flagged with the gap

### Slice C — Categories and transfers
#### Task 11: AI categorisation with memory and a review queue
- **Action**: Add the default categories with descriptions, plus household notes. Memory lookup comes first, then batched Claude calls with your corrections as examples. Add `finos review`, which lists the queue grouped by counterparty, and `finos correct`, which saves a correction, updates the counterparty's memory and re-applies it.
- **Validate**: Tests with a fake client: memory skips the AI call, a correction carries forward, and low confidence lands in review. On real data, count your corrections for month 1.

#### Task 12: Own-account transfers
- **Action**: `finos accounts add` (by last 4 digits and your UPI handles), deterministic pairing, and unpaired candidates flagged.
- **Validate**: Tests for a card bill paid from Axis, SBI → Axis, a lookalike that isn't yours, and a pair split across statement periods

### Slice D — Monthly answers and the routine
#### Task 13: Monthly views
- **Action**: Income, expenses by category (full EMI included, net of refunds, transfers excluded), savings and investments, per the PRD definitions. `finos month 2026-03` and `finos sql "<query>"` read them.
- **Validate**: A test that pins the numbers for a synthetic month containing every kind of row

#### Task 14: Spread costs and goals
- **Action**: `finos spread add` spreads a cost evenly, with the paise remainder in the last month. `finos goal add` and `finos goal assign` link spending to a goal. Every view has a cash version and a spread version, and `v_goal_progress` shows budget against actual spend.
- **Validate**: A ₹45,000 April school fee shows ₹15,000 in each of April, May and June. A trip charged across three months adds up against its budget.

#### Task 15: Back-fill, `finos eval` and the routine skills
- **Action**: Import January 2026 onward. Add `finos eval --model <id>` to compare a cheaper model against the verified results. Add the `/import` and `/month` project skills, which run in the session: sync, then review, then summary. Time the routine.
- **Validate**: `finos status` shows every month from 2026-01 for every source, and the routine takes 15 minutes or less

## Validation
```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80        # local Postgres + fakes, no network
uv run pytest tests/live                              # in a session with FINOS_* set
uv run finos sync && uv run finos sync                # second run: all unchanged, 0 Claude calls
uv run finos status
uv run finos month 2026-03
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Neon over HTTPS is awkward to use from Python | Medium | Task 0 tests it before anything else. Turso, which uses SQLite over HTTPS through an official Python client, is the fallback. Everything goes through the `Db` interface, so switching is contained. |
| Claude misreads a row or makes up a number | Medium | The totals, running-balance and grounding checks catch it, and the statement is flagged rather than stored as ok. Verified results are cached, so a good result never changes. |
| The checks are too strict for one layout (rounding, "Cr" suffixes, EMI conversion lines) | Medium | Each source profile sets its own formula. The amount check compares normalised numbers, not raw text. |
| Categorisation confidence is poorly calibrated | Medium | New counterparties always go to review. Your corrections become memory and examples. Month-1 corrections are counted. |
| API cost runs over | Low | The default model, Opus, costs about $15–25 for the back-fill and is checked against a hard monthly cap. `finos eval` measures cheaper models. |
| Secrets in the environment are readable by the session | Medium | Code never prints them, they're never pasted into chat, and there's a separate API key just for `finos` that you can revoke. |
| Statement contents are sent to the Anthropic API | Certain | This already happens in today's routine. The third-party unlock website drops out, which is a net improvement. |
| A hosted database holds financial data | Certain | The connection string is stored as a secret, there's one database for one user, and Neon encrypts data at rest. The originals stay in your own Drive. |
| A Neon free plan limit is reached | Low | A few thousand rows a year is far below free storage. Scale-to-zero means no idle cost. |

## Acceptance
- [ ] All tasks complete
- [ ] Unit and database tests pass in CI-like conditions, and live tests pass in a configured session
- [ ] Re-syncing any month gives no changes, no duplicates and no Claude calls
- [ ] Every statement for all five sources is `ok`, or `flagged` with its gap shown
- [ ] Card bill payments and self-transfers count as 0 in expenses
- [ ] `finos month` answers income, expenses by category, savings and investments for every month since 2026-01
- [ ] Month-1 corrections are counted, and the target from month 2 is set
- [ ] The monthly routine takes 15 minutes or less, run entirely from a cloud session
