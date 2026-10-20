# Plan: Statement Pipeline — Trusted Monthly Record

**Source PRD**: `.claude/prds/statement-pipeline.prd.md`
**Selected Milestone**: 1 — Trusted monthly record
**Complexity**: Large
**Revision**: 4. Runs only in Claude Code cloud sessions, AI does the extraction and categorisation, and secrets follow researched best practice (see "Secrets" and `docs/research/cloud-session-secrets.md`).

## Summary
Everything runs in Claude Code cloud sessions. Nothing runs on your laptop. You save statement PDFs to a Google Drive folder. In a cloud session, `finos sync` downloads new files, unlocks them with passwords fetched at run time from a secret manager (Doppler), and asks Claude through your API key to read out every transaction. Code then checks that output against the statement's own printed totals and text. Claude also categorises the transactions, learning from your corrections. The record is a hosted Postgres database (Neon), so it outlives every session and can be reached by any AI tool or dashboard. The pipeline's code is the only part that decides whether a statement is trusted: AI output is accepted only after it passes deterministic checks.

## What changed from revision 1, and why
| Revision 1 | Revision 2 | Why |
|---|---|---|
| Ran on your laptop, with SQLite in `private/` | Runs in Claude Code cloud sessions, with a hosted Neon Postgres database | You don't want to run anything locally, and a cloud container loses its files when the session ends. |
| Passwords in the OS keychain | The database and Doppler credentials are network secrets that never enter the session. Statement passwords and the API key are in Doppler and fetched into memory. Nothing secret is in the environment. | A cloud container has no keychain, and Anthropic's docs say environment variables are readable by anyone who uses the environment. |
| PDFs in a local `statements/` folder | PDFs saved to a Google Drive folder, which `finos` reads with a Google service account | Statements already arrive in Gmail, and Gmail's "Save to Drive" button works from your phone. Drive also keeps the originals, so the record can always be rebuilt. |
| A hand-written parser per bank, plus regex categorisation rules | Claude reads each statement and categorises the transactions, with code checking the results | You've seen regex-based tools break and leave most transactions uncategorised. AI copes with layout changes and unclear UPI narrations. The checks keep the numbers trustworthy. |

## Decisions
| Question | Decision | Why |
|---|---|---|
| Where the record lives | **Neon Postgres, free plan.** One database, `finos`. | The free plan is permanent, sleeps when idle and wakes up when you connect. It has a web SQL editor, and Postgres works with any AI tool or dashboard (Looker Studio, Metabase, Grafana), which matters for milestones 3 and 4. |
| How the session reaches the database | Neon's **HTTPS SQL endpoint** | I tested this session: outbound connections to database ports such as Postgres 5432 are blocked, and HTTPS works. Neon serves SQL over HTTPS. Turso, which keeps SQLite, is the fallback if this doesn't work out. |
| Where statements come in and are kept | A Google Drive folder, `Finance/Statements`, shared with a service account. `finos` downloads from it through the Drive API. | The Drive and Gmail connectors return files as base64 text that would have to pass through Claude's context, which is slow and fragile for PDFs. The service account lets the code fetch files directly. |
| Where secrets live | See "Secrets" below: network secrets for Neon and Doppler, and everything else in Doppler, fetched into memory | This follows Anthropic's guidance for cloud sessions. Nothing secret is at rest in the session or its settings. |
| Who extracts transactions | Claude (`claude-opus-5-5`) through the API, with **structured JSON output**, verified by code | Details under "How AI is used" below. |
| Who categorises | Claude through the API, using your corrections as memory. **No regex rules.** | Details under "How AI is used" below. |
| Which model | `claude-opus-5-5` by default, set per task (`FINOS_MODEL_EXTRACT`, `FINOS_MODEL_CATEGORISE`) | Accuracy matters most here. Once month 1 is checked, we compare cheaper models against it (see Costs). |
| How you run it | Open a cloud session on this repo and say "import new statements" or run `/import`. Queries are just questions in the session. | Works from the Claude app on your phone or in any browser. |

## Secrets
Based on the research in `docs/research/cloud-session-secrets.md`.

**Anthropic's rule for cloud sessions:** environment variables are not for secrets, because "anyone who uses the environment can read the values". Keys should be **network secrets**: Anthropic's proxy attaches them to requests after the requests leave the session's VM, so they never enter it. The design below follows that rule everywhere the platform allows.

| Secret | Where it lives | How the pipeline uses it |
|---|---|---|
| **Neon database credential** | **Network secret** on host `api.[c-<N>.]<region>.aws.neon.tech` (the endpoint host with its first label replaced by `api`, as Neon's driver does), as a custom header `Neon-Connection-String` (the header Neon's own driver sends) | The pipeline sends SQL with no credential, and the proxy adds it. It never enters the VM. |
| **Doppler service token**: read-only, limited to the single config `finos/prd`, with an expiry | **Network secret** on host `api.doppler.com`, type Bearer | At run time the pipeline calls Doppler's secrets download endpoint and keeps the values in memory only. The token never enters the VM. |
| **The five statement passwords** | **[Doppler](https://www.doppler.com/pricing)**, free Developer plan. You type them into Doppler's web page once, and never into the chat. | They're fetched into memory and used by pikepdf, never written to disk or printed. A network secret can't decrypt a file locally, so this is the closest the platform allows. |
| **Anthropic API key** | Doppler. Network secrets never apply to `api.anthropic.com`. The key comes from its own Console workspace with a monthly spend limit. **It's never stored as `ANTHROPIC_API_KEY`**, which has broken sessions and moved Claude Code usage onto API billing. | Fetched into memory and passed to the SDK explicitly. |
| **Google Drive access**: a service account with Viewer access on one folder | **Preferred:** a network secret of type "GCP access token" on `www.googleapis.com`, where the proxy itself swaps the service-account key for tokens. **Fallback:** the JSON key kept in Doppler. | With the network secret, the Drive API is called without credentials. With the fallback, the key is used from memory. |
| **Environment variables** | Only non-secret settings, such as the Neon host and the Drive folder ID | Nothing in the environment is secret. |

**What this achieves:**
- No secret sits in the environment settings, in a file, in git or in a transcript.
- Two credentials never enter the VM at all.
- The others exist only in memory while `finos` runs.
- Secrets are entered and changed in Doppler's web page, which works from a phone, with no temporary environment variables to set up and delete.
- Doppler keeps a log of every access (3 days on the free plan).

**What no design prevents:** while a session runs, anything in it can use what the pipeline uses. That includes me, or instructions hidden in a document. This is true of every option, because the passwords must be in memory to unlock PDFs. It's contained by:
- **Narrow credentials:** the Doppler token reads only the `finos` config, Drive access is read-only and limited to one folder, and the Anthropic key is spend-capped.
- **A dedicated cloud environment** used only for this repo, so other projects' sessions get none of these secrets.
- **Custom network access** with a minimal allowlist. "Trusted" isn't used, because it already allows all of `*.googleapis.com`. The secret hosts are reachable anyway.
- **Connectors switched off** in finos sessions unless needed. Connector traffic bypasses the allowlist, so the connected Gmail, Drive, Notion and other services are all exit routes.
- **Extraction calls with no tools and a fixed output format**, so text inside a PDF can't make anything run. Narrations are cleaned (printable, one line, 200 characters at most), check messages name rows by number, date and amount rather than narration, and the CLI cleans everything it prints. Narrations still reach the session when you review categories, so `CLAUDE.md` says to treat them as data, never as instructions.
- **A guard hook** (`.claude/hooks/guard_secrets.py`) that blocks shell commands calling `api.doppler.com` directly, plus a rule in `CLAUDE.md` that only `finos` code reads secrets. This isn't airtight: Claude has printed secrets despite instructions in reported cases. But it stops the casual route.
- **Nothing secret in a setup script**, since setup output is cached as a snapshot.
- **`finos` never prints a secret value.** Config objects redact themselves, and a test enforces both.
- **Two-factor sign-in** on claude.ai, Doppler, Google, Neon and the Anthropic Console.

**Rotation:** to replace a Doppler token, mint a new one in Doppler, then delete and re-add its network secret. Statement passwords can't be rotated, because banks build them from your name, date of birth or mobile number. That's why they live only in Doppler and in memory.

**Alternatives considered:**
- **Encrypted vault in Neon, with a key in an environment variable** (revision 3, close to your pgcrypto idea): this leaves a readable key in the environment and means writing our own cryptography.
- **Infisical** (Token Auth): works the same way and is open source, but has no access log on the free plan. It's the runner-up.
- **1Password and Bitwarden:** they decrypt on the client, so their token would have to sit inside the VM.
- **Google, AWS and Azure secret managers:** they need signed requests or short-lived tokens that the proxy can't attach. Google might work through the GCP token type, which is unconfirmed.
- **HashiCorp Vault:** you'd have to run and expose a server.

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
| Naming (new) | — | Package `finos`, one module per concern, and source IDs `sbi-card`, `hdfc-tataneu`, `axis-bank`, `sbi-bank`, `canara-bank`. |
| Errors (new) | — | Typed exceptions (`WrongPassword`, `UnknownSource`, `VerificationFailed`, `BudgetExceeded`). A batch handles each file separately and reports every file's outcome. Verification failures are stored as flags. |
| Logging (new) | — | Stdlib `logging`. Account numbers masked to the last 4 digits. Secrets and narrations never logged. |
| Tests (new) | — | `tests/` mirrors `src/finos/`. The database tests run against a throwaway local Postgres 16, which is installed in the cloud image. Claude and Drive calls are faked with recorded synthetic responses. Live checks (`tests/live/`) run only when their environment variables are set. |

## Architecture
```
Google Drive  Finance/Statements/*.pdf
  → inbox      (Drive API via service account; new = Drive file id + md5 not yet in DB)
  → unlock     (pikepdf; statement passwords fetched from Doppler into memory; nothing written to disk)
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

**Database access:** one client, `NeonHttpDb`, sends SQL to Neon's HTTPS endpoint with no credential of its own. Tests run that same client against a throwaway local Postgres 16 behind an emulation of Neon's HTTPS protocol, so the production code path is what gets tested. (This replaced a planned second, direct-connection client.)

## Files to Change
| File | Action | Why |
|---|---|---|
| `pyproject.toml` | CREATE | Package, dependencies (`anthropic`, `pikepdf`, `pdfplumber`, `httpx`, `psycopg`, `google-auth`, `typer`, `pyyaml`), `finos` entry point, ruff and pytest |
| `src/finos/config.py` | CREATE | Reads non-secret settings (Neon host, Drive folder ID, budget), with a clear message for each one that's missing |
| `src/finos/secrets.py` | CREATE | Fetches the `finos` config from Doppler (no credential sent; the proxy adds it) into memory. Values are redacted from repr and logs. `finos secrets check` prints names with ✓ or ✗, never values. |
| `.claude/hooks/guard_secrets.py` + `.claude/settings.json` | CREATE / UPDATE | PreToolUse hook that blocks shell commands calling the secret hosts directly |
| `CLAUDE.md` | UPDATE | Rule: only `finos` code reads secrets, and secret values are never printed |
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
1. **Cloud environment:** create a new environment used only for this repo, from the environment menu in the session's title bar, then Edit. Set **Network access** to **Custom** with no extra domains, and keep the default package registries ticked. The secret hosts below are reachable anyway. If Drive ends up using the fallback, add `www.googleapis.com` and `oauth2.googleapis.com`.
2. **Neon:** create a free project and copy its connection string. Under the environment's **Network secrets**, add a secret:
   - **Allowed websites:** `api.[c-<N>.]<region>.aws.neon.tech`
   - **Custom header:** name `Neon-Connection-String`, prefix cleared, value = the connection string.
3. **Doppler** (free Developer plan):
   - Create the project `finos` with the config `prd`.
   - Add `PW_SBI_CARD`, `PW_HDFC_TATANEU`, `PW_AXIS_BANK`, `PW_SBI_BANK` and `ANTHROPIC_KEY` (the Canara statement has no password) in Doppler's web page.
   - Create a **read-only service token** for `finos/prd` with an expiry, for example 12 months.
   - Add it as a network secret: type **Bearer**, allowed website `api.doppler.com`.
4. **Anthropic Console:** create a workspace called `finos`, give it a monthly spend limit, create an API key there, and paste it into Doppler as `ANTHROPIC_KEY`.
5. **Google Cloud:** create a project, turn on the Drive API, and create a service account with no project roles. Create the folder `Finance/Statements` in Drive and share it with the service account as **Viewer**. Then:
   - **If the Network secrets form offers a GCP or service-account type:** add the JSON key there for `www.googleapis.com`.
   - **Otherwise:** paste the JSON key into Doppler as `GDRIVE_SA_JSON`.
6. **Account security:** turn on two-factor sign-in for claude.ai, Doppler, Google, Neon and the Anthropic Console. In finos sessions, switch off connectors you don't need.

**Never paste any of these values into the chat.** Task 1 writes this into the README step by step, with what each form looks like.

## Tasks
Each slice ends green and ships as its own pull request.

### Slice A — Cloud foundation and one source end to end
#### Task 0: Connectivity spike (needs your one-time setup)
- **Action**: Write a throwaway script that, from a cloud session, does four things:
  1. Runs `select 1` against `https://api.[c-<N>.]<region>.aws.neon.tech/sql` **sending no credential**.
  2. Fetches `finos/prd` from `api.doppler.com` sending no credential, and prints only the secret names.
  3. Lists the Drive folder.
  4. Makes one small Claude call with the key from Doppler.

  It also confirms that no secret value appears in the session's environment variables or files. Nothing is committed but the result.
- **Validate**: All four succeed. The research couldn't confirm these points, so this task settles them:
  - **Custom headers on your plan:** if the form offers none, the Neon connection string moves into Doppler.
  - **Missing headers:** the proxy must add a header the client doesn't send.
  - **GCP secret type:** if it isn't offered, use the Drive fallback.

  If Neon over HTTPS fails entirely, switch to Turso. I'll tell you about any fallback before going further.

#### Task 1: Scaffold
- **Action**: Add `pyproject.toml`, the `finos` entry point, `config.py` with missing-variable messages, the `uv sync` hook step, and the README setup guide.
- **Mirror**: The guard and warning style in `.claude/hooks/session-start.sh`.
- **Validate**: `uv run finos --help` and `uv run pytest`

#### Task 2: Database layer, secrets client and guard hook
- **Action**: Write tests first against a throwaway local Postgres 16 started by a pytest fixture: migrations apply, upsert is idempotent, and a replacement statement swaps its rows. Then build the `NeonHttpDb` implementation, which sends no credential of its own, and test it with mocked HTTP, plus an opt-in live test.
- **Action (secrets)**: Write these tests first, against a faked Doppler response:
  - secrets load into memory;
  - a missing secret fails with its name;
  - no value appears in reprs, logs, exceptions or CLI output.

  Then build `secrets.py` and `finos secrets check`. Add the guard hook, with a test that it blocks `curl api.doppler.com…` and allows `uv run finos …`, plus the `CLAUDE.md` rule.
- **Validate**: `uv run pytest tests/test_db.py tests/test_secrets.py tests/test_guard_hook.py`, plus `uv run pytest tests/live -k "neon or doppler"`

#### Task 3: Inbox, unlock and identify
- **Action**: Find new Drive files by ID and md5, using a faked Drive client in tests. Unlock by trying each statement password from Doppler, in memory, tested on a small PDF encrypted with pikepdf during the test. Identify the source from its profile's text markers.
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

### Slice B — Remaining four sources (done 2026-10-19)
Plans: `statement-pipeline-slice-b.plan.md` (Tasks 7 and 8) and `statement-pipeline-slice-b2.plan.md` (Tasks 9 and 10). All five sources import as ok.

#### Task 7: SBI Card Aurum · Task 8: Axis Bank · Task 9: SBI bank · Task 10: Canara account
Task 10 became `canara-bank`: the statement is the Canara savings account that pays the loan EMI, not the loan account, so the loan's outstanding balance is not tracked.
- **Action (each)**: Add a source profile (YAML) and its check formula. No parser code. Check it against your real statements in Drive during the session. If a statement is flagged, adjust the profile hints or the formula, never the numbers. Add a synthetic test for each formula.
- **Validate**: `finos status` shows all five sources ok, or flagged with the gap

### Slice C — Categories and transfers
#### Task 11: AI categorisation with memory and a review queue (done 2026-10-20, plan `statement-pipeline-slice-c2.plan.md`)
- **Action**: Add the default categories with descriptions, plus household notes. Memory lookup comes first, then batched Claude calls with your corrections as examples. Add `finos review`, which lists the queue grouped by counterparty, and `finos correct`, which saves a correction, updates the counterparty's memory and re-applies it.
- **Validate**: Tests with a fake client: memory skips the AI call, a correction carries forward, and low confidence lands in review. On real data, count your corrections for month 1.
- **Result**: Claude categorises every row that is not a linked transfer. Only a broken rule, or an unsure answer for ₹10,000 or more, waits in `finos review`. Memory is per payee and direction. Month 1: 186 rows, $0.24, 3 corrections (about 98% right without one). Slice D must treat a row in `transfer_links` as a transfer whatever its category, and count Loan EMI on money in (the builder pays the EMI) as an offset of the EMI.

#### Task 12: Own-account transfers (done 2026-10-19, plan `statement-pipeline-slice-c1.plan.md`)
- **Action**: `finos accounts add` (by last 4 digits and your UPI handles), deterministic pairing, and unpaired candidates flagged.
- **Validate**: Tests for a card bill paid from Axis, SBI → Axis, a lookalike that isn't yours, and a pair split across statement periods
- **Result**: Handles belong to you, not to one account (phone digits, your name), and the matcher also uses each statement's own last four digits. On the five real statements: 8 pairs, all confirmed. A debit that names only you and has no partner is a move to an account outside the record (a fixed deposit, the loan); Task 13 must not count it as spending.

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
| A secret leaks | Low | Nothing secret is in environment variables, files, git or transcripts. The Neon and Doppler credentials never enter the VM. The Doppler token is read-only and expires, the API key is spend-capped, and Drive access is read-only for one folder. A dedicated environment, Custom network access and the guard hook add further protection. See "Secrets". |
| Something in a running session misuses the secrets (me by mistake, or injected instructions) | Low | This can't be fully prevented, because passwords must be in memory to unlock PDFs. It's contained by narrow and capped credentials, the guard hook, connectors switched off, Custom network access, and extraction calls that have no tools. |
| Doppler is unavailable, or its free plan changes | Low | A sync fails cleanly and nothing is half-imported. Infisical is a drop-in alternative, because `secrets.py` is one small module. |
| A network-secret detail differs from the docs (custom headers, GCP type) | Medium | Task 0 tests each one before any code depends on it, with a fallback for each, and I'll tell you before using any fallback. |
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
