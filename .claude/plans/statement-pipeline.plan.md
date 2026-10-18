# Plan: Statement Pipeline — Trusted Monthly Record

**Source PRD**: `.claude/prds/statement-pipeline.prd.md`
**Selected Milestone**: 1 — Trusted monthly record
**Complexity**: Large
**Revision**: 3. Runs only in Claude Code cloud sessions, AI does the extraction and categorisation, and the secrets are redesigned (see "Secrets").

## Summary
Everything runs in Claude Code cloud sessions. Nothing runs on your laptop. You save statement PDFs to a Google Drive folder. In a cloud session, `finos sync` downloads new files, unlocks them with passwords kept encrypted in the database, and asks Claude through your API key to read out every transaction. Code then checks that output against the statement's own printed totals and text. Claude also categorises the transactions, learning from your corrections. The record is a hosted Postgres database (Neon), so it outlives every session and can be reached by any AI tool or dashboard. The pipeline's code is the only part that decides whether a statement is trusted: AI output is accepted only after it passes deterministic checks.

## What changed from revision 1, and why
| Revision 1 | Revision 2 | Why |
|---|---|---|
| Ran on your laptop, with SQLite in `private/` | Runs in Claude Code cloud sessions, with a hosted Neon Postgres database | You don't want to run anything locally, and a cloud container loses its files when the session ends. |
| Passwords in the OS keychain | The database credential is a network secret, so it never enters the session. The passwords and API keys are encrypted in the database. Only a vault key sits in the environment. | A cloud container has no keychain, and plain environment variables can be read by every session in the environment. |
| PDFs in a local `statements/` folder | PDFs saved to a Google Drive folder, which `finos` reads with a Google service account | Statements already arrive in Gmail, and Gmail's "Save to Drive" button works from your phone. Drive also keeps the originals, so the record can always be rebuilt. |
| A hand-written parser per bank, plus regex categorisation rules | Claude reads each statement and categorises the transactions, with code checking the results | You've seen regex-based tools break and leave most transactions uncategorised. AI copes with layout changes and unclear UPI narrations. The checks keep the numbers trustworthy. |

## Decisions
| Question | Decision | Why |
|---|---|---|
| Where the record lives | **Neon Postgres, free plan.** One database, `finos`. | The free plan is permanent, sleeps when idle and wakes up when you connect. It has a web SQL editor, and Postgres works with any AI tool or dashboard (Looker Studio, Metabase, Grafana), which matters for milestones 3 and 4. |
| How the session reaches the database | Neon's **HTTPS SQL endpoint** | I tested this session: outbound connections to database ports such as Postgres 5432 are blocked, and HTTPS works. Neon serves SQL over HTTPS. Turso, which keeps SQLite, is the fallback if this doesn't work out. |
| Where statements come in and are kept | A Google Drive folder, `Finance/Statements`, shared with a service account. `finos` downloads from it through the Drive API. | The Drive and Gmail connectors return files as base64 text that would have to pass through Claude's context, which is slow and fragile for PDFs. The service account lets the code fetch files directly. |
| Where secrets live | See "Secrets" below: a network secret for the database, an encrypted vault in the database for everything else, and one vault key in the environment | This way no single leak exposes a usable secret. |
| Who extracts transactions | Claude (`claude-opus-5-5`) through the API, with **structured JSON output**, verified by code | Details under "How AI is used" below. |
| Who categorises | Claude through the API, using your corrections as memory. **No regex rules.** | Details under "How AI is used" below. |
| Which model | `claude-opus-5-5` by default, set per task (`FINOS_MODEL_EXTRACT`, `FINOS_MODEL_CATEGORISE`) | Accuracy matters most here. Once month 1 is checked, we compare cheaper models against it (see Costs). |
| How you run it | Open a cloud session on this repo and say "import new statements" or run `/import`. Queries are just questions in the session. | Works from the Claude app on your phone or in any browser. |

## Secrets
**What this protects against:**
- a secret ending up in git or in a chat transcript;
- anything that can read the cloud environment's settings, since every session in an environment can read its environment variables;
- a leak of the Neon database or its backups;
- text inside a statement or email that tries to get the session to send secrets somewhere (prompt injection).

**What no design prevents:** code running in a session can use whatever the pipeline uses while it runs. So the design does three things instead:
- keeps credentials out of the session VM wherever the platform allows;
- makes sure no single leak exposes a usable secret;
- limits what each credential can do.

| Secret | Where it lives | If it leaks on its own |
|---|---|---|
| **Neon database credential** | A **network secret** on the cloud environment. Anthropic's proxy adds the `Neon-Connection-String` header (the header Neon's own driver uses) to requests for `api.<region>.aws.neon.tech`, after they leave the session. It never enters the VM, and the settings page never shows it again. | It can't leak from the session. |
| **The five statement passwords** | An encrypted **vault table in Neon**, encrypted with AES-256-GCM in Python, so the key never reaches Neon | A Neon leak gives only ciphertext. |
| **Google service account key** (read-only, one Drive folder) | The same vault | It exposes only password-protected PDFs from one folder. |
| **Anthropic API key** | The same vault. Network secrets never apply to `api.anthropic.com`, so it can't be one. The key lives in its own Console workspace with a monthly spend limit (for example $20). | Spend is capped at that limit, and you can revoke the key in the Console. |
| **Vault key** (a long random passphrase from your password manager, stretched with scrypt) | The only environment variable, `FINOS_VAULT_KEY`. Keep a copy in your password manager. | It's useless on its own: the database is reachable only through the proxy. If it's lost, you re-import the secrets. Nothing else is lost. |

Indian statement passwords are built from your name, date of birth or mobile number, so you can never change them if they leak. That's why they're never stored anywhere in plain text.

**Alternatives considered:**
- **Plain environment variables** (revision 2): every session in the environment can read them.
- **Encrypting inside Neon with pgcrypto** (your suggestion): close, but the key would travel inside every SQL query and could show up in Neon's query logs and statistics. Encrypting in Python keeps the key off Neon while keeping the idea of an encrypted store in Neon.
- **[Google Secret Manager](https://cloud.google.com/secret-manager/pricing)**: solid, with encryption, an audit log of every access, and up to 6 secrets free. But it needs a Google private key inside the VM, and that one key would unlock everything. Worth adding later if you want an access log.
- **[Bitwarden Secrets Manager](https://bitwarden.com/help/secrets-manager-plans/)**: has a free plan, but its access token also sits in the VM and its [Python SDK](https://bitwarden.com/help/secrets-manager-sdk/) is in beta.
- **A small hosted service that unlocks PDFs, so passwords never enter the VM**: the unlocked statement comes back into the VM anyway, so it protects little and adds a server to run.

**Hardening:**
- A **dedicated cloud environment** used only for this repo, so other projects' sessions never get the vault key or the Neon secret.
- **Network access set to Limited**: Neon, Google APIs, Anthropic and package registries only. This narrows where injected instructions could send data.
- Statement text goes to Claude only through an API call with **no tools and schema-constrained output**, so text inside a PDF can't make anything run. The session itself only ever sees verified rows.
- Code never prints or logs a secret, config objects redact themselves, and a test enforces both.
- Two-factor sign-in on your claude.ai, Google, Neon and Anthropic Console accounts.

**Loading secrets once, without the chat and without a terminal:**
1. Add the values as temporary environment variables (`FINOS_IMPORT_PW_SBI_CARD`, …, `FINOS_IMPORT_ANTHROPIC_KEY`, `FINOS_IMPORT_GDRIVE_SA_JSON`).
2. In a new session, run `finos vault import`. It encrypts each value into Neon, checks that each password opens a real statement, and prints only names with ✓ or ✗.
3. Delete the `FINOS_IMPORT_*` variables. From then on, the environment holds only `FINOS_VAULT_KEY`.

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
  → unlock     (pikepdf; tries the vault's statement passwords; in memory only)
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
| `pyproject.toml` | CREATE | Package, dependencies (`anthropic`, `pikepdf`, `pdfplumber`, `httpx`, `psycopg`, `google-api-python-client`, `google-auth`, `cryptography`, `typer`, `pyyaml`), `finos` entry point, ruff and pytest |
| `src/finos/config.py` | CREATE | Reads `FINOS_VAULT_KEY` and settings, with a clear message for each one that's missing. Never echoes values. |
| `src/finos/vault.py` | CREATE | AES-256-GCM vault in Neon, scrypt key derivation, `vault import`, `vault list` (names only), `vault rotate-key`. Secret values are redacted from repr and logs. |
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

## One-time setup you do (all in a browser, about 25 minutes)
1. **Cloud environment:** create a new environment used only for this repo, from the environment menu in the session's title bar. Set network access to Limited and allow `www.googleapis.com` and `oauth2.googleapis.com`. Leave the default package registries ticked.
2. **Neon:** create a free project and copy its connection string. In the environment's **Network secrets**, add a secret:
   - **Allowed websites:** `api.<region>.aws.neon.tech`
   - **Custom header:** name `Neon-Connection-String`, prefix cleared, value = the connection string.

   The proxy adds this header for you, and the host it applies to is reachable even under Limited network access.
3. **Google Cloud:** create a project, turn on the Drive API, and create a service account with no project roles. Download its JSON key.
4. **Drive:** create the folder `Finance/Statements` and share it with the service account's email address as **Viewer**.
5. **Anthropic Console:** create a workspace called `finos`, give it a monthly spend limit, and create an API key in it.
6. **Vault key:** generate a random passphrase of 40 or more characters in your password manager and save it there. Add it to the environment as `FINOS_VAULT_KEY`.
7. **Import the secrets:** add the temporary `FINOS_IMPORT_*` variables, run `finos vault import` in a new session, then delete those variables. The steps are under "Secrets" above.

**Never paste any of these values into the chat.** I'll write a step-by-step version with screenshots of each form into the README in Task 1.

## Tasks
Each slice ends green and ships as its own pull request.

### Slice A — Cloud foundation and one source end to end
#### Task 0: Connectivity spike (needs your one-time setup)
- **Action**: Write a throwaway script that, from a cloud session, does three things:
  1. Runs `select 1` against `https://api.<region>.aws.neon.tech/sql` **without sending any credential**, relying on the network secret, and confirms the connection string appears nowhere in the session's environment variables or files.
  2. Lists the Drive folder through the service account.
  3. Makes one small Claude call with the vault's API key.

  Nothing is committed but the result.
- **Validate**: All three succeed.
  - If the proxy doesn't attach the Neon header, for example because your plan's secret form has no custom headers, fall back to the connection string in an environment variable and tell you before going further.
  - If Neon over HTTPS fails entirely, switch to Turso.

#### Task 1: Scaffold
- **Action**: Add `pyproject.toml`, the `finos` entry point, `config.py` with missing-variable messages, the `uv sync` hook step, and the README setup guide.
- **Mirror**: The guard and warning style in `.claude/hooks/session-start.sh`.
- **Validate**: `uv run finos --help` and `uv run pytest`

#### Task 2: Database layer and vault
- **Action**: Write tests first against a throwaway local Postgres 16 started by a pytest fixture: migrations apply, upsert is idempotent, and a replacement statement swaps its rows. Then build the `NeonHttpDb` implementation, which sends no credential of its own, and test it with mocked HTTP, plus an opt-in live test.
- **Action (vault)**: Write these tests first:
  - values round-trip;
  - a wrong key fails loudly;
  - a tampered ciphertext is rejected by the GCM tag;
  - the key never appears in any SQL sent;
  - no secret appears in reprs, logs or CLI output.

  Then build `vault import`, `vault list` and `vault rotate-key`.
- **Validate**: `uv run pytest tests/test_db.py tests/test_vault.py`, plus `uv run pytest tests/live -k neon`

#### Task 3: Inbox, unlock and identify
- **Action**: Find new Drive files by ID and md5, using a faked Drive client in tests. Unlock by trying each of the vault's statement passwords in memory, tested on a small PDF encrypted with pikepdf during the test. Identify the source from its profile's text markers.
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
| A secret leaks | Low | The database credential never enters the VM. Everything else is encrypted, and its key is useless without the database. The API key is spend-capped, the Drive access is read-only, and there's a dedicated environment with Limited network access. See "Secrets". |
| Prompt injection inside a statement or narration | Low | Extraction is a tool-less API call with schema-constrained output. The session sees only verified rows, and network access is Limited. |
| You lose `FINOS_VAULT_KEY` | Low | You keep a copy in your password manager. Without it, you re-run `finos vault import`, and no data is lost. |
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
