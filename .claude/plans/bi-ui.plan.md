# Plan: BI UI — a local dashboard and a chat over the record

**Parent plan**: none. This is milestone 2 work, after milestone 1 ("Trusted monthly record") in `.claude/plans/statement-pipeline.plan.md`.
**Source**: the user's product goal (no PRD). Research inputs: AG-UI/CopilotKit packages, the finos data layer, the local secret design, the TypeScript server stack report of 2026-10-24, and the security and feasibility reviews of the second revision (summarised in "Decisions" and "Review points").
**Complexity**: Large. One migration (safe views, one role, grants, cost checks; done, two check constraints to add), a Node server in TypeScript under `ui/server` (macOS Keychain, Doppler, Neon read-only client, dashboard JSON API, AG-UI agent endpoint), a React app under `ui/web`, tests in Vitest, Playwright and pytest. **No Claude call and no live database call while building.** All tests use fakes and synthetic data, and a Vitest setup file refuses every real network call.
**Branches**: this plan on `claude/bi-ui`. Each slice on its own branch cut from `main` after the slice before it is merged: `claude/bi-ui-e1` (E1 + E1b), `claude/bi-ui-e2` … `claude/bi-ui-e5`.
**Revision**: 2026-10-24, third revision. The second revision moved the backend from Python to TypeScript (Node). The third applies the security and feasibility reviews. "Review points" at the end lists what changed and what was rejected.

## Open question for the user
1. **Chat frontend: CopilotKit or a small own chat component?** Requirement 3 named CopilotKit. The feasibility review shows that `@copilotkit/react-core` 1.78.0 brings 1,069 packages with 23 audit advisories (1 critical: `dompurify` through `mermaid`/`streamdown`), and it locks the web tree to zod 3, which has an advisory with no fix on zod 3. **This plan now uses a small own chat component** (option B: `fetch("/agent")`, a 50–80 line SSE reader, `@ag-ui/core` schemas). The web tree is then 44 packages. If the user keeps CopilotKit (option A), E4 goes back to the CopilotKit wiring of the second revision, and the critical and high audit findings become a recorded exception. E4 does not start before the user answers.

## State at the start (2026-10-24)
- Milestone 1 code is on `main` (`72ad7fc`). 638 tests pass without credentials.
- Migrations `0001` to `0007` are on Neon. The live views are `0006` + `0007` (`0005` is replaced).
- **Done in the working tree, green, not yet committed (E1):** `src/finos/migrations/0008_ui_access.sql`, the `$$`-aware statement splitter in `src/finos/migrate.py`, `tests/test_migrate.py`, `tests/test_ui_views.py`, `tests/ui_grants.snapshot.json`, the `ui_db` fixture and `NeonEmulator(role=…)` in `tests/conftest.py`. `ai.check_budget` and `ai.spent_this_month` (through `v_ai_spend`) are split out of `structured`. `0008` gets two more check constraints (`purpose`, `model`) in E1b.0 before it is committed.
- **Discarded, to be reverted in E1b.0:** the Python keychain, the Python AG-UI server, the Python `ui` extra, and the laptop code in `ai.py`, `config.py`, `db.py` and `secrets.py` (list in E1b.0).
- Migrations still run from Python (`finos migrate`, through any `finos` command in a cloud session). The Node server never runs DDL.
- `NeonHttpDb` sends no credential; the cloud proxy adds `Neon-Connection-String` and the Doppler token. **On the laptop nothing adds them.** The Node server builds that path itself. **In a cloud session the proxy adds them to any request**, also one from a Node test, so no Node test may reach the real network (E1b.2.4).
- `month.month_view()` and `report.status()` load every narration into Python (transfer checks). The UI does not port them; it reads the safe views only.
- `categories` rows come from `load_categories(path or …)`, and `sync_categories` keeps rows dropped from the file. A category name in the database is not proof that it is in the packaged `categories.yaml`.
- `ai_usage.purpose` values written by Python: `extract`, `categorise`, `eval-extract`, `eval-categorise`. The chat adds `chat`.
- Cloud container: Node v22.22.0; Postgres 16 binaries in `/usr/lib/postgresql/16/bin`; the container runs as root, so `runuser -u postgres` works; Playwright 1.63.0 at `/opt/node-tools/node_modules/playwright` (linked from `NODE_PATH=/usr/local/lib/node_modules_global`), browsers in `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH` is set); `npm audit` works through the proxy. The laptop's Node version is not known yet (user step 1).

## Requirements restated
1. `npm --prefix ui run ui` starts a local Node server on the user's macOS laptop on `127.0.0.1` and opens the browser with a one-time launch link. It serves two pages: **Dashboard** and **Chat**. Only the user runs it (CLAUDE.md).
2. **Dashboard** (no question needed), with a cash/spread toggle and a month picker:
   1. Month KPIs: income, expenses, savings, investments, each with the change from the month before.
   2. A 12-month trend of income, expenses and savings, with partial months marked.
   3. Spending by category for the month, with the change from the month before (amount and %).
   4. Goals (budget, spent, remaining) and spreads (row, amount, start, months), and the month's cash and spread figures side by side.
   5. Data health: coverage per account per month, complete and partial months, the review queue (rows and amount), uncategorised rows, unlinked transfer rows, flagged statements, AI spend this month against `FINOS_AI_BUDGET_USD` by purpose, and the schema version.
3. **Chat**: the user asks a free-form question. A Claude agent (`claude-sonnet-5-5`) reads the record through six server-owned tools and chooses UI components (KPI tiles, bar or line chart, table, category breakdown). The browser renders them. Protocol: AG-UI 1.0 over SSE. Frontend: React (Vite) with a small own chat component (see "Open question"; CopilotKit is option A).
4. The chat's spend is recorded in `ai_usage` (`purpose = 'chat'`) with the same prices and rounding as `src/finos/ai.py`, and checked **before each model call** against the shared `FINOS_AI_BUDGET_USD` ($100), which sync, categorise and eval also use. There is no chat-specific limit (user decision 4). At most 6 tool rounds plus 1 final answer per question, so at most 7 model calls.
5. The Anthropic key never reaches the browser. It lives only in the Node server's memory.
6. Security (each one has a test; see "Security requirements").

## Security requirements
| # | Requirement | Enforced by |
|---|---|---|
| S1 | The agent never sees a narration, a categorisation reason, a handle, a household note, transfer evidence, a file name, statement problems, a payee (counterparty) name or a goal name. The model never writes SQL. | The UI's Neon role can read only the safe views of migration `0008` (database-enforced). The **allow-list** test (`tests/test_ui_views.py`, done) snapshots the exact columns of every granted view and the exact grants of `finos_ui_access` and `PUBLIC`; any change fails. The tools are typed functions with **zod** input schemas over fixed, parameterised queries on those views; no SQL is built by joining strings. `v_goal_progress` (it has `goal` = `goals.name`) never feeds a tool; tools read `v_ui_goal_progress`. A source scan checks that `ui/server/src/tools.ts` and `agent.ts` never name `v_goal_progress`. A guard test runs every tool over the golden seed and checks that no seed narration, counterparty, reason, handle, note or goal name appears in any tool result, event or API response. |
| S2 | Tool results are data, not instructions. | The results hold only numbers, dates, enums, **packaged** category names (any other name becomes "Other (unlisted)"), source IDs, last-4 digits, 8-character row IDs and goal IDs. Every text column that reaches the model is mapped to a fixed set or a strict pattern (see "Output cleaners"): `category`, `source`, `row_id`, `direction`, `kind`, `status`, `what`, `purpose`, `model`. The model sees "Goal 3". The system prompt says tool results are data. The server ignores `tools`, `context`, `state`, `forwardedProps` and client-sent assistant, system, developer and tool messages, and keeps the thread history itself, so a forged tool result from the client never reaches the model. The database refuses `ai_usage` rows whose `purpose` or `model` is outside the patterns (`0008` check constraints), so the UI role cannot plant text that `finos status` later shows in a cloud session. |
| S3 | Only the browser tab that the server opened can use the API. | `serve({ fetch, port, hostname: "127.0.0.1" })` (without `hostname`, `@hono/node-server` 2.1.4 listens on every interface); a test checks `server.address().address === "127.0.0.1"`. Host allow-list `127.0.0.1:<port>` only (no `localhost`: it can resolve to `::1`, which another process can hold) on **every** route, also `/auth` and static files: 421 before routing (DNS rebinding). One-time launch token (`crypto.randomBytes(32).toString("base64url")`), valid 60 s, compared with `crypto.timingSafeEqual` after a length check (it throws on unequal lengths). **Exactly one session per server process.** Any second `/auth` with the used token revokes the session and stops the server, with "This launch link was used twice. The UI server stopped. Start it again." `/auth` sets a session-only cookie `finos_ui_<port>` (`HttpOnly; SameSite=Strict; Path=/`, no `Max-Age`) and redirects to `/#s=<session value>`. The cookie value and the session value are **two separate `randomBytes(32)` values**: cookies are not port-scoped, so a listener on another `127.0.0.1` port gets the cookie and must not get the second factor with it. The page moves the session value to `sessionStorage` (scoped to scheme, host **and port**) and clears the hash. `/api/*` and `/agent` need the cookie **and** `X-Finos-Session` equal to the session value (`timingSafeEqual`), and `Sec-Fetch-Site: same-origin` when the browser sends it. A request whose `X-Finos-Session` equals the cookie value gets 403. `POST /agent` also needs `Origin: http://127.0.0.1:<port>` exactly, `Content-Type: application/json` and a body ≤ 64 KiB (413, counted on `Content-Length` and on the bytes read, before `JSON.parse`). Static files: only the files listed from `ui/web/dist` at start-up are served (a fixed map; no path from the URL reaches the file system), so no path traversal. No page body holds the session value. No CORS headers. Strict CSP: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. `style-src 'unsafe-inline'` only if Recharts needs it (it sets inline `style` attributes on SVG); the reason is recorded in `app.ts`. A test checks that `script-src` never holds `'unsafe-eval'` or `'unsafe-inline'`. |
| S4 | No secret in an environment variable, a file, an argument or a log; the laptop holds no statement password, no Google key and no owner database string. | One bootstrap secret: a read-only Doppler service token for the **root config `ui`** of a new Doppler environment `ui` (not a branch of `prd`). It lives in the macOS **login** Keychain, item service `finos-ui`, account `doppler`, made fresh (delete, then add without `-U`) with an empty trusted-app list (`-T ""`), so every read prompts. The server reads it with `execFile("/usr/bin/security", ["find-generic-password", "-s", "finos-ui", "-a", "doppler", "-w", "<home>/Library/Keychains/login.keychain-db"], {env: {}})`: absolute path, no shell, no token in argv, and the login keychain named, so an item in a keychain earlier in the search list is not used. **Root-config check, by token and config:** (1) the token matches `^dp\.st\.ui\.[A-Za-z0-9]+$` (refuses `dp.st.prd.`, `dp.st.ui_*`, `dp.pt.`, `dp.ct.`); (2) the download's `DOPPLER_PROJECT` = `finos`, `DOPPLER_ENVIRONMENT` = `ui` and `DOPPLER_CONFIG` = `ui` (authoritative). Second check: any non-`DOPPLER_*` name other than `ANTHROPIC_KEY` and `NEON_READONLY_URL` stops the start, and the message names the extras, never a value. The two values live only in closures in memory, never in `process.env`. **Boot order:** the entry module `boot.ts` statically imports only `harden.ts`; it runs `hardenEnv()`, then `await import("./main.js")`, so every `ANTHROPIC_*` variable is deleted before the SDK module is evaluated (ESM evaluates static imports first). The `ui` and `ui-check` scripts run `env -u NODE_OPTIONS -u NODE_PATH node server/dist/boot.js`, so no preload runs. `hardenEnv({ env, execArgv })` is detection on top: it refuses to start when `NODE_OPTIONS` or `execArgv` holds `--require`, `--import`, `--loader`, `--experimental-loader`, `--inspect*`, `--use-env-proxy`, `--insecure-http-parser` or `--openssl-*`, or when `NODE_TLS_REJECT_UNAUTHORIZED=0`, `NODE_EXTRA_CA_CERTS` or `NODE_USE_ENV_PROXY` is set (each can expose the secret-bearing TLS traffic). The Anthropic client gets an explicit `apiKey`, `authToken: null`, `baseURL: "https://api.anthropic.com"`, `logLevel: "off"`, and a `fetch` that refuses any other host, removes `authorization` and `proxy-authorization`, and uses `redirect: "error"`. Neon and Doppler requests also use `redirect: "error"` (a cross-origin redirect would re-send `Neon-Connection-String`). **Logging is process-wide:** no request log; `process.on("uncaughtException")` and `process.on("unhandledRejection")` write one fixed line and exit 1; an error inside `streamSSE` after the headers are sent becomes a `RUN_ERROR` with a fixed text; a failed `ai_usage` insert in the `finally` writes a fixed line. No error object is ever printed. Error texts name a secret, never its value. The guard hook blocks Keychain readers, Node one-liners that load the server's secret or database modules, the `ui` and `ui-check` scripts, `node …/dist/boot.js`/`main.js`, and requests to the real server port (E1b.7.6). |
| S5 | Chat spend is recorded and checked before each call. | Before every `messages.stream` call: `select coalesce(sum(cost_usd),0) from v_ai_spend where month = date_trunc('month', now())::date` ≥ `FINOS_AI_BUDGET_USD` → refuse (same query and message as `ai.check_budget`). **The check fails closed:** a database error in `checkBudget` gives `RUN_ERROR` and no model call. The insert into `ai_usage` runs in a `finally` around each call. Usage: for each field, the value from the latest event that carries it (`message_delta` replaces `message_start`; never add them, because `message_delta` usage is cumulative). If the call ends without `message_stop` (abort, disconnect, break, error), `output_tokens = max(seen, max_tokens)`, so a disconnect cannot under-record (handoff known limit 1); with Sonnet this bound is at most $0.04 per call. If the insert fails, the run stops with `RUN_ERROR` code `record` and makes no more calls. Database checks (`0008`): `cost_usd >= 0` and token counts `>= 0`, so no row can lower the spend; `purpose` and `model` patterns. At most 6 tool rounds plus 1 final answer = at most 7 `messages.stream` calls per question. No `cache_control` sets `ttl: "1h"` (`ai.py` prices 5-minute cache writes only). One run at a time: an in-flight flag is set synchronously before the first `await` and cleared in a `finally`. A client disconnect aborts an `AbortController` whose `signal` goes to the SDK stream; no next call starts. |
| S6 | No statement data or real figures in the repository. | Fixtures are synthetic (the `build_ui` record of `tests/test_ui_views.py`, exported once to `tests/ui_golden/seed.sql`). `ui/` tests and the fake backend use that synthetic record. `ui/web/dist/`, `ui/server/dist/` and `node_modules/` are git-ignored (`.gitignore` already ignores `dist/` and `node_modules/` at any depth). |
| S7 | The browser renders typed data only and keeps no chat after the tab closes. | Components take numbers, labels and series. React text nodes only, never `dangerouslySetInnerHTML`. The assistant's text renders as plain text nodes (no Markdown, links, images or KaTeX). No chat message or tool result is written to `localStorage`, `sessionStorage` or IndexedDB (tested); `sessionStorage` holds only the session value. |
| S8 | No Node test and no fake backend reaches the real network or a real secret, in any run. | A Vitest `setupFiles` entry (`test/no-network.ts`) in both trees replaces `globalThis.fetch` and `neonConfig.fetchFunction` with stubs that throw and fail the test; a test passes its own fake explicitly. A test proves the guard is active. In a cloud session the proxy would attach the `finos/prd` Doppler token or the owner's `Neon-Connection-String` to a real request. `fake.ts` installs the same guard. In a cloud session the server's `boot`/`main`, `ui` and `ui-check` never run (CLAUDE.md, guard hook). |
| S9 | The supply chain of both trees is pinned and checked. | Exact pins, lock files, `npm ci --ignore-scripts` written out in every command (not only `.npmrc`), never `npm install` on the laptop. Lock-file tests: every `resolved` URL under `https://registry.npmjs.org/` (no git, file or tarball URL), every package has a `sha512` `integrity`, the server tree has no `hasInstallScript: true`, the web tree has it only on an allow-list (`esbuild`, `fsevents`). `npm audit signatures` and `npm audit --omit=dev` in both `check` scripts. `engine-strict=true`. On the laptop only `ci --ignore-scripts` and the builds run, never the web Vitest suite. |

## Decisions

| Question | Decision | Why |
|---|---|---|
| Server language | **TypeScript on Node** (user decision 1), in `ui/server`, compiled with `tsc` into git-ignored `ui/server/dist` and run with plain `node` from `dist/boot.js`. No `tsx` or type stripping at run time. Separate `ui/server/package.json` and lock file from the frontend's `ui/web`, so the process that holds the secrets loads only `hono`, `@hono/node-server`, `@neondatabase/serverless`, `@anthropic-ai/sdk`, `@ag-ui/core` and `zod`, never the React tree. | One language for server and browser; the `@ag-ui/core` types are shared. The migration, views and grants do not depend on the server language. A small dependency tree (12 runtime packages) in the secret-holding process. |
| Where secrets come from on the laptop | **macOS login Keychain holds one read-only Doppler service token** (`dp.st.ui.…`) for the root config `ui` of a new Doppler environment `ui` in project `finos`. The user makes the item fresh in Terminal (user step 8: delete, then `add-generic-password … -T "" -w` without `-U`; hidden prompt; no value in argv or history). The server sends `Authorization: Bearer` on the Doppler download only. Config `ui` holds exactly `ANTHROPIC_KEY` (a copy of the pipeline key, user decision 3) and `NEON_READONLY_URL` (user decision 2). The root-config proof is the token prefix and the download's `DOPPLER_*` identity, not the secret names. | One revocable, expiring, read-only bootstrap secret, encrypted by macOS. A root config inherits nothing. `-U` would keep the ACL of an older permissive item. `doppler run` puts secrets in env vars; `.env` is a plain file. Both are against CLAUDE.md. |
| Keychain access from Node | `/usr/bin/security` through `execFile`, with the login keychain path. Not `keytar` (archived 2022), not `@napi-rs/keyring` (a native binary; "Always Allow" would trust the `node` binary, so every Node script could read the item). The user chooses **"Allow"**, not "Always Allow": one prompt per server start, and only right after the user started the server. | No native dependency, no shell, an absolute path. With `-T ""` every read prompts; any process that runs `/usr/bin/security` shows the same prompt, so the user must not allow a prompt they did not cause. |
| Which Neon role the UI uses | A login role `finos_ui`, member of the group role `finos_ui_access` that migration `0008` creates and grants. The user creates `finos_ui` once in `psql`. `checkConnectionString` (port of the Python rules) refuses a URL that is not `postgres(ql)://`, the user `neondb_owner` or any user other than `finos_ui`, a host other than `FINOS_NEON_HOST` or its `-pooler` form, and anything but exactly one `sslmode=require`; no message holds the string. At every start the server runs `select 1 from transactions limit 1` and refuses to start unless it fails with a permission error. | The rule "do not select a narration" becomes a grant. An owner string used by mistake is refused. |
| Neon client | `@neondatabase/serverless` 1.2.0, `neon(url, { fetchOptions: { redirect: "error" } })`. It speaks the same HTTP protocol as `NeonHttpDb` (`https://api.<region domain>/sql`, `Neon-Connection-String`, `Neon-Raw-Text-Output`, `Neon-Array-Mode`, `Neon-Batch-Read-Only`). Reads run in `sql.transaction([...], { readOnly: true })` with `set local statement_timeout = '5s'`. The one write is the `ai_usage` insert, with no `RETURNING`. `numeric` stays a string; the `date` parser (OID 1082) is overridden to keep the raw `YYYY-MM-DD`; `bigint` stays a string. All queries sit behind a `Db` interface (`read`, `insertUsage`). | Same wire protocol as the emulator in `tests/conftest.py`. Strings avoid float and time-zone drift. |
| Which views the UI role reads | Only: `v_monthly_summary[_spread]`, `v_monthly_by_category[_spread]`, `v_month_coverage`, `v_goal_progress` (browser only), `v_spread_problems`, `v_ui_rows`, `v_ui_spreads`, `v_ui_goal_progress`, `v_ai_spend`, `v_statement_health`, plus `select (version)` on `schema_migrations` and `insert` on the cost columns of `ai_usage`. **Not** `v_transactions` or `v_transactions_spread`. | Every column is on the allow-list snapshot. The Node server needs no more grants (the identity insert needs no sequence grant; `test_ui_views.py` shows it). |
| Migrations from the UI | None. At start the server compares `max(version)` in `schema_migrations` (it holds the file name without `.sql`, as `migrate._migrations` writes it) with the largest file name in `src/finos/migrations/` with `.sql` removed (read from the repo checkout) and stops with "Run any finos command in a cloud session to migrate first" when the database is older. | The UI role cannot run DDL. |
| Model-written SQL | **None.** The agent has typed tools only. | Free SQL is the injection channel. |
| Agent pattern | **Backend tool rendering, six tools.** Four render tools (`show_kpis`, `show_chart`, `show_table`, `show_category_breakdown`) take a *query spec*; the server runs it and returns the rows in `TOOL_CALL_RESULT`, which the model also reads. Two read tools (`get_health`, `get_rows`) cover what no component shows. The browser draws each render tool by `toolCallName` from `TOOL_CALL_RESULT.content`. No frontend tools. | The model never writes a figure. Validation stays on the server. |
| AG-UI on the server | No agent framework. The server validates the body with `RunAgentInputSchema` and the events with `EventSchema`, both from the **`@ag-ui/core/schemas`** subpath of 1.0.2 (the root export has only the types and `EventType`). It writes events with Hono `streamSSE` as `data: <JSON>\n\n` (what `@ag-ui/encoder` does for SSE; the encoder and its protobuf stack are not installed). Events: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END/RESULT`. Optional fields that are null are left out. | No binary transport; one schema source for server and browser. |
| Thread history | The server keeps **one** thread in memory (the latest `threadId`; a new `threadId` replaces it), at most 20 turns. From `RunAgentInput` it reads only `threadId`, `runId` and the **last user message** (text only, at most 2,000 characters). | One user, one tab. Client-sent messages cannot be forged into the model request. A restart forgets the chat. |
| Chat model call | `@anthropic-ai/sdk` 0.133.0 (exact; 1.x is a new major from 2026-10-21), `client.messages.stream(...)` per call, model `claude-sonnet-5-5`, `max_tokens` 4,096, `maxRetries` 3, prompt caching (5-minute, no `ttl`) on the system prompt and the last tool schema, `signal` from the run's `AbortController`. Error mapping as `ai._status_message`; the 401 text names `ANTHROPIC_KEY` in Doppler config `ui`. **No server-side fallback beta** (closed; 0.133.0 has `server-side-fallback-2026-07-01` only in the `beta` namespace, and one model, one user and `maxRetries` 3 are enough). | The key stays in the server; the client ignores the laptop's Claude Code environment. |
| Cost | `ui/server/src/cost.ts` mirrors `ai.PRICES` and `ai.cost_usd`: strip `-\d{8}$` for pricing only; unknown model → the first entry with the highest output price (`claude-opus-5`) and a warning; a missing usage field counts 0; integer arithmetic only (prices × 1,000 are integers, so Σ tokens × price-milli is in 1e-9 USD; divide by 100,000 with **half-even** rounding to 1e-4 USD, as Python's `Decimal.quantize`). The served model (`message.model`, else the requested model) goes into `model` after the model cleaner. A Vitest test parses `src/finos/ai.py` and fails if the two tables differ; both languages check the same cost vectors file. | `numeric(10,4)`; no floats; the two sides cannot drift. |
| Budget | Only the shared `FINOS_AI_BUDGET_USD` (from the laptop shell profile, default 100, must be > 0), checked before every call, failing closed. The laptop value is independent of the cloud value, so `ui-check` and `/api/meta` show the value in use, and user step 10 says to set the same value as the cloud environment. No `FINOS_CHAT_BUDGET_USD`, no per-question cap (user decision 4). Round cap 6 + 1. | The user chose no chat-specific limits. The check before every call is the house rule. Two different values would split the shared limit. |
| Run control | A module-level in-flight flag, set before the first `await` in the handler; a second run gets `RUN_ERROR` "busy". The stream's abort (`stream.onAbort` / request `signal`) aborts the run's `AbortController`. The loop checks it before each call. A `finally` closes every open message and tool call, records the usage, and clears the flag. | Node is single-threaded; a synchronous flag is enough. |
| Web framework | **Hono 4.13.13 + `@hono/node-server` 2.1.4.** No dependencies, Web `Request`/`Response`, built-in `streamSSE` (`hono/streaming`), `bodyLimit` (`hono/body-limit`) and `secureHeaders` (`hono/secure-headers`), tests through `app.request()` with no socket (plus one real-socket test for a missing Host header). Not Fastify (15 direct dependencies). | Small tree in the secret-holding process; simple tests. |
| Chat frontend | **Option B (pending the user, see "Open question")**: an own `ChatPage` with `fetch("/agent", { method: "POST", headers: { "X-Finos-Session", "Content-Type": "application/json", Accept: "text/event-stream" } })`, a 50–80 line SSE reader, every event parsed with `EventSchema` from `@ag-ui/core/schemas` before use, render tools drawn by `toolCallName` from `TOOL_CALL_RESULT.content` with the E3 components, and assistant text as text nodes. Web tree: `react`, `react-dom`, `react-is`, `recharts`, `@ag-ui/core`, `zod`. No `@copilotkit/*`, no `@ag-ui/client`. Option A (CopilotKit 1.78.0 `/v2`, `agents__unsafe_dev_only`, `HttpAgent`) only if the user keeps it, with the audit findings as a recorded exception. | 44 packages instead of 1,069; no Markdown, KaTeX, Mermaid, inspector or MCP renderer to turn off; the web tree can move to zod 4. |
| Charts | `recharts`. One palette from the `dataviz` skill, light and dark. | Mature, React-native, no canvas. |
| Pages | Two tabs in one app, by URL hash (`#/dashboard`, `#/chat`). No router library. The `#s=` hash is read once at start and replaced. | Two pages do not need one. |
| Build, serve and frontend development | `npm --prefix ui run build` builds `ui/web` first (`npm --prefix ui/web ci --ignore-scripts && vite build`), then the server (`npm --prefix ui/server ci --ignore-scripts && tsc`), so the server tree and `dist` are fresh from the lock file at every build (user decision 8). The server serves `ui/web/dist` on the same origin. If `ui/web/dist/index.html` is missing, it stops with the build command. **No Vite dev server, no dev proxy, no `--dev`, `--no-browser` or `--print-url` flag**: the server only opens the browser. Frontend work uses Vitest and `vite build --watch` with the fake backend (`npm --prefix ui run fake`) in a cloud session. | One origin, so no CORS. The Host and Origin allow-lists never widen. No flag prints the launch URL. |
| `ui-check` | The same start-check function as `ui`, called with `--check`: it runs every boot check, prints names and states, and exits without listening. Not a second code path. | One path to test. |
| Packaged categories | `ui/server/src/categories.json` holds the names, kinds and order of `src/finos/categories.yaml`. A pytest fails when the two differ. | No YAML parser in the secret-holding process. |
| Zod | Tool schemas and API shapes are written with `import { z } from "zod/v4"` and converted with `z.toJSONSchema` while the pin is zod 3.25.76 (the `@ag-ui/core` schemas use `zod/v4` too, so the server has one zod API). After the move to zod 4.6.7 the root `zod` import is used. | One API; no `zod-to-json-schema` dependency. |
| Version pins | Exact pins, no `^` or `~`, each published at least two weeks before use. Both `ui/server/.npmrc` and `ui/web/.npmrc`: `save-exact=true`, `ignore-scripts=true`, `engine-strict=true`, `before=2026-10-10`. Lock files committed. `npm audit signatures` and `npm audit --omit=dev` in each `check` script. `engines.node` `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` (the same as vitest 5.0.3; `>=22.12` would accept Node 23 and 25, which vitest refuses). | The two-week rule; the Anthropic SDK releases almost daily. `ignore-scripts` also stops install analytics. |
| Audit exception | `npm audit --omit=dev` on 2026-10-24 shows **one high advisory in each tree with option B**: zod `<4.6.6` (GHSA-mrhx-c7xc-m3w5). No fixed zod passes the two-week rule yet (4.6.6 is from 2026-10-11, 4.6.7 from 2026-10-12). **Recorded exception until 2026-10-26**: the 64 KiB body limit before `JSON.parse`, `.max()` on every array and `.max()` on every string in the schemas. The `check` script allows only this advisory ID (an allow-list file, `ui/<tree>/audit-allow.json`, with the reason and an end date; the check fails after the end date). After 2026-10-26: move both trees to zod 4.6.7 with `before=2026-10-13`, remove the exception; the audit gate then passes with none. | The gate stays honest: one named exception with an end date. |
| Telemetry | No CopilotKit, so no runtime telemetry, inspector or Scarf. CSP `connect-src 'self'`. | Nothing leaves the laptop except Neon, Doppler and Anthropic calls from the server. |

### Version pins
| Package | Where | Pin | Published |
|---|---|---|---|
| `hono` | server | 4.13.13 | 2026-10-04 |
| `@hono/node-server` | server | 2.1.4 (not 2.1.5, 10-13) | 2026-10-08 |
| `@neondatabase/serverless` | server | 1.2.0 | 2026-10-01 |
| `@anthropic-ai/sdk` | server | 0.133.0 (not 0.136+, not 1.x) | 2026-10-09 |
| `@ag-ui/core` | server and web | 1.0.2 (schemas from `@ag-ui/core/schemas`) | 2026-10-05 |
| `zod` | server and web | 3.25.76 now (audit exception), 4.6.7 after 2026-10-26. `@ag-ui/core` accepts 3 or 4. One copy in each tree (`npm ls zod`). | 2025-07-08 / 2026-10-12 |
| `typescript` | server and web | 6.0.3. Not 7.x (a new major; the toolchain is not checked against it). | 2026-04-16 |
| `vitest` | server and web | 5.0.3 | 2026-09-30 |
| `pg` | server, dev only | 8.23.1 (the test emulator) | 2026-09-30 |
| `react`, `react-dom` | web | 19.3.0. Re-run the audit at the start of E3; if an advisory names 19.3.0, take 19.3.1 as a recorded exception. | 2026-09-09 |
| `react-is` | web | 19.3.0 (peer of `recharts`) | 2026-09-09 |
| `vite` | web | 8.3.4 | 2026-10-08 |
| `@vitejs/plugin-react` | web | 6.1.2 | 2026-10-05 |
| `recharts` | web | 3.10.1 | 2026-07-25 |
| `jsdom` | web, dev | 28.1.0 (not 30.1.2: jsdom 30.1.2 needs Node 22.22.2 or later, which breaks engine-strict on older laptop 22.x) | 2026-10-04 |
| `@testing-library/react` | web, dev | 16.3.3 | 2026-08-27 |
| `@testing-library/dom` | web, dev | newest 10.x before 2026-10-10, exact (peer of `@testing-library/react`) | — |
| `@types/node` | server and web, dev | newest 24.x before 2026-10-10, exact (peer of `vitest`: `^22 \|\| >=24`) | — |
| `@types/pg`, `@types/react`, `@types/react-dom`, `@testing-library/user-event` | dev | newest before 2026-10-10, resolved once in a cloud session with `npm install --before=2026-10-10 --ignore-scripts`, saved exact | — |
| `playwright` | not a dependency | the preinstalled 1.63.0 in the cloud container (`/opt/node-tools`), browsers in `/opt/pw-browsers`; never `playwright install` | — |

Too new, do not use: `@ag-ui/*` ≥ 1.0.3, `@anthropic-ai/sdk` ≥ 0.136 and 1.x, `@hono/node-server` 2.1.5, `vitest` 5.0.4+, zod 4.x before 2026-10-26. Not used: `@copilotkit/*` (option A only), `@ag-ui/client`, `@ag-ui/encoder`, `@ag-ui/proto`, `fastify`, `keytar`, `@napi-rs/keyring`, `tsx` (at run time), `zod-to-json-schema`.

## Migration `src/finos/migrations/0008_ui_access.sql` (done, two constraints to add)
The file is written and green (`tests/test_migrate.py`, `tests/test_ui_views.py`). It is not changed by the move to TypeScript. The `ai_usage_text` constraint (marked below) is in its own migration `0009_ai_usage_text.sql`: `0008` was committed and pushed in `5ff0851` before E1b.0, and finos records migrations by file name, so an edit to `0008` would never reach a database that already ran it.

```sql
-- No row can lower the month's AI spend: costs and token counts are never negative.
alter table ai_usage add constraint ai_usage_not_negative check (
  cost_usd >= 0 and input_tokens >= 0 and output_tokens >= 0
  and cache_read_tokens >= 0 and cache_write_tokens >= 0);

-- (E1b.0, migration 0009_ai_usage_text) No free text in purpose or model: finos status shows them in cloud sessions.
alter table ai_usage add constraint ai_usage_text check (
  purpose ~ '^[a-z_-]{1,20}$' and model ~ '^claude-[a-z0-9-]{1,60}$');

-- Rows for the UI and the chat: the columns of v_transactions without counterparty,
-- with the 8-character row ID that finos prints (spread.SHOWN_ID).
create view v_ui_rows as
select left(txn_id, 8) as row_id, txn_date, month, source, account_last4, amount, direction,
       category, linked, kind, refund, value, needs_review
from v_transactions;

-- Spreads without any text: which row, how many months, from when.
create view v_ui_spreads as
select spread_id, left(txn_id, 8) as row_id, txn_date, source, account_last4, direction,
       amount, start_month, months
from spreads;

-- Goal progress without the goal name (user text). The tools read this, never v_goal_progress.
create view v_ui_goal_progress as
select goal_id, budget, month, rows, spent, spent_to_date, remaining
from v_goal_progress;

-- AI cost by month, purpose and model. The UI role reads this, not ai_usage.
create view v_ai_spend as
select date_trunc('month', at)::date as month, purpose, model,
       count(*)::int as calls, sum(cost_usd) as cost_usd
from ai_usage group by 1, 2, 3;

-- Statement status without file names or problem texts (both can hold third-party text).
create view v_statement_health as
select s.source, s.account_last4, s.period_start, s.period_end, s.status,
       count(t.txn_id)::int as rows
from statements s left join transactions t on t.statement_id = s.statement_id
group by 1, 2, 3, 4, 5;

do $$ begin
  if not exists (select from pg_roles where rolname = 'finos_ui_access') then
    create role finos_ui_access nologin;
  end if;
end $$;

grant usage on schema public to finos_ui_access;
grant select on v_monthly_summary, v_monthly_summary_spread, v_monthly_by_category,
  v_monthly_by_category_spread, v_month_coverage, v_goal_progress, v_spread_problems,
  v_ui_rows, v_ui_spreads, v_ui_goal_progress, v_ai_spend, v_statement_health to finos_ui_access;
grant select (version) on schema_migrations to finos_ui_access;
grant insert (purpose, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_usd) on ai_usage to finos_ui_access;
```
- The `purpose` pattern allows `-`, because Python writes `eval-extract` and `eval-categorise`. The `model` pattern matches every model name in `ai.PRICES` and dated forms. If an old row on Neon breaks a pattern, the migration stops in its transaction and names the constraint.
- `at` is not in the insert grant, so no row can be backdated.
- `v_goal_progress.goal` is user text. It reaches the browser through `/api/goals`, never the model. `tests/test_ui_views.py` checks that `ui/server/src/tools.ts` and `agent.ts` never name `v_goal_progress` (E1b.1 points the scan at the TS sources and fails when the files are missing after E2).
- `v_spread_problems` has the full `txn_id`. The API and the tools cut it to 8 characters.
- A later view needs its own explicit grant in its migration, and the allow-list snapshot fails until the snapshot is updated. No `alter default privileges`.
- No sequence grant is needed: `test_ui_views.py` inserts into `ai_usage` as `finos_ui_access`.
- `finos_ui` (login, password, `connection limit 10`, `statement_timeout '15s'`) is created by the user in `psql` as `create role finos_ui login in role finos_ui_access …` and `\password finos_ui`. **Not** in the Neon Console: roles made there join `neon_superuser` and the grants mean nothing. `npm --prefix ui run ui-check` and the server start test the effect every time: a select on `transactions` must fail with a permission error, or they refuse to start.

## HTTP surface (all on `127.0.0.1:<port>`, default 8765)
```
GET  /auth?t=<launch token>      one use, 60 s, one session per process; sets the session cookie;
                                 303 to /#s=<session value>; a second use stops the server
GET  /                           index.html from ui/web/dist (no secret in it; no-store)
GET  /assets/*                   the files of ui/web/dist/assets listed at start-up
GET  /api/meta                   schema version, months available, FINOS_AI_BUDGET_USD in use, spent this month
GET  /api/summary?spread=0|1&months=12
GET  /api/month/<YYYY-MM>?spread=0|1        KPIs, change from the month before, categories with MoM
GET  /api/goals                  goals (id, name, budget, spent, remaining) and month lines
GET  /api/spreads                spreads (v_ui_spreads) and spread problems (8-character IDs)
GET  /api/health                 coverage grid, complete/partial months, review, uncategorised,
                                 unlinked transfer rows, flagged statements, AI spend by purpose
POST /agent                      AG-UI RunAgentInput -> text/event-stream
```
- **Every** route, `/auth` included, needs the Host check `127.0.0.1:<port>` (421 before routing).
- Every route except `/auth` needs the session cookie `finos_ui_<port>`.
- `/api/*` and `/agent` also need `X-Finos-Session` (`timingSafeEqual`, never equal to the cookie value) and, when present, `Sec-Fetch-Site: same-origin`.
- `POST /agent` also needs `Origin: http://127.0.0.1:<port>`, `Content-Type: application/json` and a body ≤ 64 KiB (413 before `JSON.parse`).
- `Cache-Control: no-store` on `/`, `/api` and `/agent`. Errors are JSON `{error}` with a plain message, never a stack, a header or SQL.
- No request log. Process-wide error handlers write one fixed line (S4).

## Agent tools (server-owned; inputs validated with zod)
| Tool | Input | Returns (data only) |
|---|---|---|
| `show_kpis` | `month`, `spread`, `metrics` ⊆ {income, expenses, savings, investments}, `title?` | the tiles' numbers and changes from the month before; month complete or partial |
| `show_chart` | `kind` ∈ {bar, line}, `series` ⊆ metrics **or** `category` (packaged list), `from_month`, `to_month`, `spread`, `title?` | x, y rows |
| `show_table` | `source` ∈ {months, month_categories, rows, goals, spreads, coverage} + that source's arguments, `title?` | columns, rows (≤ 50). `goals` reads `v_ui_goal_progress` and labels "Goal <id>". |
| `show_category_breakdown` | `month`, `spread`, `compare` (bool), `title?` | category, net, previous, change |
| `get_health` | — | the `/api/health` numbers |
| `get_rows` | `month?`, `category?`, `source?` (a profile ID), `min_amount?`, `limit` ≤ 50 | `v_ui_rows` rows; total count |

- Titles are model text: at most 80 printable characters, shown as a text node.
- Months are parsed with `parseMonth` (port of `month.parse_month`: full match of `YYYY-MM`, year ≥ 1, month 1 to 12); a bad input gives a tool result with `is_error` and a plain reason, not an exception.
- Every category name in a result is checked against `categories.json`; any other name becomes "Other (unlisted)".
- Zod schemas are `.strict()`, so unknown fields fail; every array and string has a `.max()`.

## Read API to port (`ui/server/src/record.ts`)
The discarded Python `src/finos/ui/record.py` is the reference; it reads only the `0008` views. The views do the arithmetic. The port holds the post-processing:
- `months(spread, last=12)`: the last N rows of `v_monthly_summary[_spread]`, oldest first.
- `month(m, spread)`: summary for `m` and `m − 1 month`; null if `m` is missing. KPI change = now − prev; `pct` null when prev = 0, else change × 100 / |prev| rounded half-even to 0.1, in decimal-string arithmetic, never floats. Category merge by (kind, mapped name) over both months, ordered by the minimum `position`; `previous` = 0 when absent last month, null when there is no last month. Coverage from `v_month_coverage` (`days_covered`, `days_in_month`). Flagged = `v_statement_health` rows with `status='flagged'` that overlap `m`. `spread_problems` = `v_spread_problems where what='spread'` count, only with spread on.
- `goals()`: `v_goal_progress`, total line `month is null`, month lines nested; the name passes a printable filter and is cut to 60 characters (browser only).
- `spreads()`: `v_ui_spreads` by `spread_id`, problems from `v_spread_problems` (`what desc, id, txn_date`), `txn_id` cut to 8. A state outside {`not counted`, `transfer`, `no category`, `not an expense`} becomes `not counted`. Never join `v_ui_rows` on the 8-character `row_id` (not unique). No per-month parts (the views do not give them; the spread figures are in `v_monthly_summary_spread`).
- `health()`: coverage grid, complete/partial months, `review_rows`, `review_amount`, `uncategorised_rows`, unlinked transfer rows as `sum(own_rows)` (and `own_out`/`own_in`) from `v_monthly_summary` (it already computes `kind='transfer' and not linked`), flagged statements, AI spend this month by purpose, schema version.
- `rows(filter)`: `v_ui_rows` with optional filters, `limit` 1 to 50, `count(*) over ()` total, ordered by `txn_date, source, account_last4, row_id`. "Other (unlisted)" becomes `category is not null and category <> all($n)` with a JS array parameter.
- **Output cleaners** (every text column that reaches the model or the browser): `source` `[a-z0-9-]{1,40}` else `"unknown"`; `account_last4` `[0-9]{0,4}` else `"?"`; `row_id` 8 lowercase hex else `"????????"`; `direction` `debit|credit` else `debit`; `kind` ∈ {income, expense, investment, transfer} else `expense`; `v_statement_health.status` ∈ {ok, flagged} else `flagged`; `v_spread_problems.what` ∈ {spread, goal} else `spread`; `v_ai_spend.purpose` ∈ {extract, categorise, eval-extract, eval-categorise, chat} else `other`; `v_ai_spend.model` `^claude-[a-z0-9-]{1,60}$` else `unknown`.
- Not ported (the views cannot give them): the transfer-link agreement of `month._links_stale`, and `finos status` counts from a live match and from `corrections`. The health panel says "Run finos transfers in a cloud session" for detail.

## Patterns to mirror
| Category | Source | Pattern |
|---|---|---|
| Schema | `0006_…sql`, `0007_spreads_goals.sql`, `0008_ui_access.sql` | A comment above each view; plain statements |
| Read path | `src/finos/month.py`, discarded `src/finos/ui/record.py` | Typed rows from the views; decimal strings |
| Secrets | `src/finos/secrets.py`, `Secret` | Values in closures, revealed only at the header; error texts name the item |
| Paid path | `ai.Claude.structured`, `_record`, `cost_usd`, `check_budget` | Budget check before, record after, plain error text |
| IDs | `spread.SHOWN_ID` | 8-character row IDs everywhere |
| Tests | `tests/conftest.py` (`NeonEmulator`, `migrated_db`, `ui_db`), `tests/test_ui_views.py:build_ui`, `tests/test_ai.py:FakeMessages` | Synthetic record in a throwaway Postgres behind an emulator; fake Doppler, Keychain and Claude; inputs injected (`hardenEnv({ env, execArgv })`, `readToken({ execFile })`) |

## Layout of `ui/`
```
ui/package.json            scripts only (no dependencies): ui, ui-check, build, check, check:server, fake, e2e
ui/server/                 package.json, package-lock.json, .npmrc, audit-allow.json, tsconfig.json, vitest.config.ts
  src/boot.ts              entry: hardenEnv(), process error handlers, then await import("./main.js")
  src/harden.ts            hardenEnv({ env, execArgv }); no other import
  src/main.ts              start(flags): Keychain, Doppler, Neon checks, listen, open browser; --check stops before listen
  src/keychain.ts          the only Keychain reader
  src/doppler.ts           download + root-config checks
  src/db.ts                Db interface, Neon client, checkConnectionString, schema gate, role check
  src/record.ts            the read API over the safe views, output cleaners
  src/categories.json      packaged categories (pytest drift check)
  src/cost.ts              price table, costUsd, budget check, insertUsage, usage accumulator
  src/anthropic.ts         the locked-down client
  src/app.ts               createApp(deps): middleware, /auth, /api/*, static, /agent
  src/tools.ts, agent.ts   six tools; the AG-UI run (E2)
  src/fake.ts              fake backend: real createApp + golden seed record + scripted fake Claude + network guard (E5)
  test/                    Vitest: no-network setup file, unit tests, emulator, globalSetup (Postgres), golden tests
ui/web/                    package.json, package-lock.json, .npmrc, audit-allow.json, vite.config.ts, tsconfig.json, index.html, src/**
ui/e2e/smoke.mjs           Playwright smoke test against the fake backend (E5, cloud)
```

## Files to change
| File | Action | Slice | Why |
|---|---|---|---|
| `src/finos/migrations/0008_ui_access.sql` | DONE | E1 | Cost checks, safe views, group role, grants |
| `src/finos/migrations/0009_ai_usage_text.sql` | NEW (`ai_usage_text`) | E1b.0 | Text checks for `purpose` and `model` |
| `src/finos/migrate.py`, `tests/test_migrate.py`, `tests/ui_grants.snapshot.json`, `tests/conftest.py` (`ui_db`, `NeonEmulator(role=…)`) | DONE | E1 | `$$` splitter, snapshot, fixtures |
| `tests/test_ui_views.py` | DONE, then UPDATE | E1/E1b | Point `UI_SOURCES` at `ui/server/src` and scan `tools.ts`/`agent.ts`; `purpose`/`model` constraint tests |
| `src/finos/ai.py` | UPDATE | E1b | Keep `check_budget` and `spent_this_month`; remove `from_ui_key`, `check_chat_budget`, `laptop_client` |
| `src/finos/config.py`, `src/finos/db.py`, `src/finos/secrets.py` | REVERT the laptop parts | E1b | Python has no laptop path any more (list in E1b.0) |
| `src/finos/keychain.py`, `src/finos/ui/`, `tests/test_ui_record.py` | DELETE (untracked) | E1b | Discarded Python UI |
| `tests/test_ai.py`, `tests/test_config.py`, `tests/test_secrets.py` | REVERT the laptop tests | E1b | Match the reverted code |
| `tests/ui_golden/seed.sql`, `tests/ui_golden/expected.json`, `tests/ui_golden/cost_vectors.json`, `tests/test_ui_golden.py` | CREATE | E1b | One synthetic record and one set of expected figures for both languages; cost vectors checked by Python `cost_usd`; `categories.json` drift check |
| `ui/package.json`, `ui/server/**` | CREATE | E1b/E2 | The Node server |
| `ui/web/**` | CREATE | E3/E4 | The React app |
| `ui/server/src/fake.ts`, `ui/e2e/smoke.mjs` | CREATE | E5 | Fake backend and Playwright smoke test |
| `.claude/hooks/guard_secrets.py`, `tests/test_guard_hook.py` | UPDATE | E1b | Node, Keychain, server-start and server-port rules |
| `CLAUDE.md` | UPDATE | E1b | Two readers of secrets; the Keychain item as the only file exception; what Claude must not run on the laptop or in a cloud session (approved, user decision 5) |
| `docs/research/cloud-session-secrets.md` | UPDATE | E1b | Section 4 names the laptop Keychain exception and the Node reader |
| `tests/live/test_ui_grants.py` | CREATE | E1b | Optional cloud check: finos code runs `set local role finos_ui_access` inside a `NeonHttpDb.batch` |
| `docs/setup-guide.md` | UPDATE | E5 | "Part 8. Laptop UI", in ASD-STE100 |
| `README.md`, `docs/handoff.md` | UPDATE | each | Commands, status, handoff in ASD-STE100 |

## Tasks

Each slice ends with: `uv run ruff check . && uv run ruff format --check .`, `uv run pytest`, and from E1b `npm --prefix ui/server ci --ignore-scripts`, `npm --prefix ui/web ci --ignore-scripts` (from E3) and `npm --prefix ui run check` green; the review agents (with the security review for any change to `ui/server` secret, SQL or HTTP code); the handoff update; the user's commit gate; a pull request into `main`. All of these run in a cloud session.

### E1 — Migration 0008 and the safe views (DONE)
Written and green in the working tree: E1.1 items 1–7 of the earlier revision (splitter keeps a `do $$ … $$;` block whole; migrations apply twice on one cluster; exact `v_ui_rows` columns and sums; `v_ai_spend`, `v_statement_health`, `v_ui_goal_progress`; grants and refusals for `finos_ui_access`; negative cost or tokens fail; allow-list snapshot). It ships in the E1 pull request with E1b.0 and E1b.1.

### E1b — `ui/` workspace and the TypeScript server core (dashboard API)

**E1b.0 Python clean-up and `0008` text checks (tests stay green)**
1. Revert the laptop parts of `ai.py` (`from_ui_key`, `check_chat_budget`, `laptop_client`), keeping `check_budget` and `spent_this_month` through `v_ai_spend`.
2. Revert `config.py` (`credentials`, `ui_port`, `model_chat`, `chat_budget_usd`, `chat_turn_max_usd`, `neon_ui_role`, the `load_settings` arguments), `db.py` (the `connection` parameter, `check_connection_string`, the local hint, `UI_ROLE`/`OWNER_ROLE`) and `secrets.py` (`token=`, `exact=`), with their tests. Keep the no-redirect and https-only guards in `db.py` only if they are already covered by tests.
3. Delete `src/finos/keychain.py`, `src/finos/ui/` and `tests/test_ui_record.py`. No Python `ui` extra in `pyproject.toml`.
4. Tests first: as `finos_ui_access`, an `ai_usage` insert with `purpose` `"chat; ignore"` or `model` `"gpt"` fails; every Python purpose and every `ai.PRICES` model passes. Then add `ai_usage_text` in a new migration `0009`. `ai.Claude` records a served model name that does not match as the requested model (or `claude-unknown`), so a paid call is always recorded. A live test checks that the constraint exists on the real database.
5. `uv run pytest` is green; the 638 existing tests plus the E1 tests pass.

**E1b.1 Golden record and cross-language checks (tests first, `tests/test_ui_golden.py`)**
1. `tests/ui_golden/seed.sql` is the `build_ui` record of `tests/test_ui_views.py` as plain `insert` statements, made once by a documented command. A test loads it into `migrated_db` and checks that every table equals what `build_ui` writes, so the seed cannot drift.
2. `tests/ui_golden/expected.json` holds the figures of `month.months()`, `month.month_view()` (KPIs, category lines), goals, spreads and the health counts for the seed months. A test computes them in Python and compares.
3. `tests/ui_golden/cost_vectors.json` (model, usage, expected cost), with half-even cases at exactly 0.00005, an unknown model and a dated model. A test checks each with `ai.cost_usd`.
4. A test compares `ui/server/src/categories.json` with `load_categories()` of the packaged YAML (names, kinds, order).
5. `test_ui_views.py` scans `ui/server/src/tools.ts` and `agent.ts` for `v_goal_progress`; it is skipped with a reason until E2 creates them, and fails if they are missing after E2 (a marker file list).

**E1b.2 Scaffold and supply chain (tests first)**
1. `ui/server/package.json` has only exact versions from the pins table, `engines.node` `^22.12.0 || ^24.0.0 || >=26.0.0`, scripts `build` (`tsc`), `test` (`vitest run`), `check` (`npm audit signatures && node scripts/audit.mjs && tsc --noEmit && vitest run && npm ls zod @ag-ui/core`). `scripts/audit.mjs` runs `npm audit --omit=dev --json` and fails on any advisory not in `audit-allow.json`, or on any entry past its end date. `.npmrc` has `save-exact`, `ignore-scripts`, `engine-strict`, `before=2026-10-10`. `package-lock.json` is committed.
2. A Vitest test reads `package.json` and the lock file: every dependency is exact; the server tree has no `react`, `@copilotkit/*`, `@ag-ui/client`, `@ag-ui/encoder`, `@ag-ui/proto` or `tsx` in `dependencies`; every `resolved` URL starts with `https://registry.npmjs.org/` (no git, file or tarball URL); every package has a `sha512-` `integrity`; no package has `hasInstallScript: true`.
3. `ui/package.json` has scripts only; `npm --prefix ui run check` runs the server and web checks (cloud), `npm --prefix ui run check:server` the server check only (laptop).
4. **Network guard (S8)**: `vitest.config.ts` has `setupFiles: ["test/no-network.ts"]`, which replaces `globalThis.fetch` and `neonConfig.fetchFunction` with stubs that throw "real network call in a test" and mark the test failed. `test/no-network.test.ts` proves it: a bare `fetch("https://api.doppler.com/")` and a bare `neon(url)` query both fail. Tests pass fakes explicitly (`loadSecrets({ fetch })`, `createDb({ fetchFunction })`).

**E1b.3 Process hardening and Keychain (tests first, `test/harden.test.ts`, `test/boot.test.ts`, `test/keychain.test.ts`)**
1. `hardenEnv({ env, execArgv })` (fake inputs; the test never reads the worker's real `process.execArgv`) removes every `ANTHROPIC_*` variable from `env`; it refuses, and names the flag or variable, for `--require`, `--import`, `--loader`, `--experimental-loader`, `--inspect*`, `--use-env-proxy`, `--insecure-http-parser`, `--openssl-*` in `NODE_OPTIONS` or `execArgv`, and for `NODE_TLS_REJECT_UNAUTHORIZED=0`, `NODE_EXTRA_CA_CERTS` and `NODE_USE_ENV_PROXY`.
2. **Boot order**: a source test walks the static import graph from `src/boot.ts` and fails if `@anthropic-ai/sdk`, `@neondatabase/serverless` or any module that imports them is reachable without a dynamic `import()`. `boot.ts` imports only `harden.ts`.
3. `readToken({ execFile, home })` calls `execFile` with `/usr/bin/security`, the exact argument list (with `<home>/Library/Keychains/login.keychain-db`), `env: {}`, a timeout and a small `maxBuffer`; a failure gives "Keychain item finos-ui not readable", no output text.
4. The token shape check accepts `dp.st.ui.<alnum>` and refuses `dp.st.prd.`, `dp.st.ui_dev.`, `dp.pt.`, `dp.ct.`, an empty value and trailing whitespace inside, without the value in the message.
5. No code path passes the token as an argument to a child process (source scan of `ui/server/src` for `add-generic-password` and `-w` with a value).

**E1b.4 Doppler download (tests first, `test/doppler.test.ts`, injected fake `fetch`)**
1. `GET https://api.doppler.com/v3/configs/config/secrets/download?format=json` with `Authorization: Bearer`, `redirect: "error"` and a 15 s timeout; no other request carries that header.
2. `DOPPLER_PROJECT` ≠ `finos`, `DOPPLER_ENVIRONMENT` ≠ `ui` or `DOPPLER_CONFIG` ≠ `ui` stops with "config ui must be the root config of environment ui"; no value appears.
3. A missing `ANTHROPIC_KEY` or `NEON_READONLY_URL` is named. An extra non-`DOPPLER_*` name (for example `PW_SBI`, `GDRIVE_SA_JSON`) stops the start and is named without a value.
4. 401/403 gives "The Doppler token in the Keychain item finos-ui is refused or expired"; the body is never echoed. A 3xx is not followed.
5. After `loadSecrets()`, `process.env` holds neither value, and `JSON.stringify` / `util.inspect` of the returned object shows no value.

**E1b.5 Neon client and database checks (tests first, `test/db.test.ts`, `test/record.test.ts`)**
1. `test/emulator.ts` (port of `NeonEmulator`, about 60 lines): an injected `fetchFunction` parses `{query, params}` and `{queries}`, runs them through `pg` with `rowMode: "array"` and text output as `set role finos_ui_access`, batches inside `begin`/`commit`, and returns the Neon answer or HTTP 400 `{message, code}`. It records the headers it received.
2. `test/global-setup.ts`: a throwaway Postgres 16 as `conftest.py` does (`initdb`/`pg_ctl` from `/usr/lib/postgresql/16/bin`, `runuser -u postgres` as root, socket directory, `listen_addresses=''`, `fsync=off`), or `FINOS_TEST_DATABASE_URL`. When both are missing (the macOS laptop), the database tests skip with a reason. It applies `src/finos/migrations/*.sql` in order with `pg` simple-query and then `tests/ui_golden/seed.sql`.
3. The grants seen through the emulator equal `tests/ui_grants.snapshot.json`.
4. `checkConnectionString` refuses `neondb_owner`, another user, another host (`-pooler` accepted), no or two `sslmode=require`, and `http`/other schemes; no message holds the password.
5. Reads send `Neon-Batch-Read-Only: true`; the driver gets `redirect: "error"`; `date` values arrive as `YYYY-MM-DD` strings and `numeric` as strings.
6. The start check refuses when `select 1 from transactions` succeeds (emulator run as owner) and passes on a permission error. The schema gate compares `max(version)` with the largest migration file name without `.sql`, and stops on an older database with the cloud hint.
7. Every `record.ts` method equals `tests/ui_golden/expected.json` for the seed months. Unlinked transfer rows come from `sum(own_rows)` of `v_monthly_summary`.
8. A category in the `categories` table that is not in `categories.json` appears as "Other (unlisted)" in every result.
9. Every output cleaner maps an unexpected value (`kind`, `status`, `what`, `purpose`, `model`, `source`, `row_id`, `direction`) to its fallback; seed rows with a planted `purpose`/`model` are made as owner with the constraint dropped in a throwaway schema copy.
10. **Guard test**: serialise every `record.ts` result; no seed narration, counterparty, reason, handle, note or problem text (the `ZQX` strings) appears; goal names only in `goals()` for the browser.

**E1b.6 Server, middleware and dashboard endpoints (tests first, `test/app.test.ts`, `app.request()`, fake clock, fake `Db`)**
1. Host `evil.example:8765`, `localhost:8765`, `[::1]:8765` or `127.0.0.1:9999` → 421 before routing, on `/auth`, `/`, `/assets/*`, `/api/*` and `/agent`. One test over a real socket sends a request with no Host header → 421 (`app.request()` cannot send one).
2. `/auth`: a wrong token or a token of another length → 403 (no throw); the right one → 303 to `/#s=…`, cookie `finos_ui_8765` with `HttpOnly; SameSite=Strict; Path=/` and no `Max-Age` or `Expires`; a first use after 60 s → 403 "expired". **A second use of the used token → the session is revoked (the old cookie and session value now get 401/403) and the server's stop function is called**, with the "used twice" text. No second session can exist.
3. The cookie value is not equal to the `#s=` value. A request whose `X-Finos-Session` equals the cookie value → 403.
4. `/api/*` without the cookie, or with a cookie of another port's name → 401; without `X-Finos-Session` or with a wrong one → 403; `Sec-Fetch-Site: same-site` or `cross-site` → 403 (absent header accepted).
5. `POST /agent` without `Origin`, with `http://localhost:8765`, `http://127.0.0.1:9999`, `http://127.0.0.1:8765.evil.example` or `null` → 403; without `Content-Type: application/json` → 415; a 65 KiB body → 413 and the handler is not called (spy); a lying `Content-Length` with a longer streamed body → 413.
6. No response has an `Access-Control-Allow-*` header; every response has the CSP of S3, `nosniff` and `no-referrer`; `script-src` holds neither `'unsafe-eval'` nor `'unsafe-inline'`; `base-uri`, `form-action` and `object-src` are `'none'`; `/`, `/api` and `/agent` have `no-store`.
7. Static: `GET /` serves `ui/web/dist/index.html` unchanged; `/assets/../package.json`, `/assets/%2e%2e/x`, an encoded slash and a file added after start → 404. No response body holds the launch token or the session value.
8. Each `/api` endpoint returns the `record.ts` figures as JSON (decimals as strings, dates ISO); `/api/meta` holds the `FINOS_AI_BUDGET_USD` in use; a bad month → 400 with a plain message.
9. An exception inside a handler → 500 `{error: "…"}` with no stack, header or SQL.
10. **Logging**: with `ANTHROPIC_LOG=debug` set before boot and spies on `console`, `process.stdout` and `process.stderr`, a full session (auth, every `/api` call) writes no launch token, session value, cookie, Doppler token, API key, connection string or seed figure. Injected errors whose `message`, `cause` and `headers` hold a fake key, a fake connection string and a fake Doppler token, thrown in a handler, as an unhandled rejection and as an uncaught exception (handlers called directly), write only the fixed line. This test proves that the app code does not log; it does not load the SDK. The SDK's debug logging is covered by the boot-order test (`boot.test.ts`: `hardenEnv` runs before any SDK import) and by E2.1.6, which sets `ANTHROPIC_LOG` before boot against the real client.

**E1b.7 Launch, `ui-check` and guard hook (tests first; moved forward from E5 because the Keychain reader lands here)**
1. `start(flags, deps)` in `main.ts` (fakes for Keychain, Doppler, Neon, `execFile` of `/usr/bin/open`): order is token → Doppler → connection check → role check → schema gate → listen on `127.0.0.1` → open `http://127.0.0.1:<port>/auth?t=…` after the server is ready. `server.address().address === "127.0.0.1"`. A used port gives a plain message. The token is never on stdout or stderr; the server prints only "Started on port N".
2. A missing `ui/web/dist/index.html` stops with "Run `npm --prefix ui run build`".
3. `start({ check: true })` (`npm --prefix ui run ui-check`) runs the same checks and prints names and states only (Keychain item found, token shape, config identity, secret names present, role, schema version, `FINOS_AI_BUDGET_USD` in use and spent, `transactions` refused), then exits without listening; exit 1 when the role can read `transactions`. It is the only live check of the `finos_ui` login role.
4. SIGINT stops cleanly; no file is written (the test checks a temp home is unchanged).
5. **Guard hook** (`tests/test_guard_hook.py`) blocks: `security find-generic-password … finos-ui`, `security dump-keychain`, `security export …`, `security add-generic-password … -w <value>`; `node -e`/`node -p`/`tsx`/`npx tsx`/`ts-node`/`bun`/`deno` with `ui/server/src/(keychain|doppler|db|anthropic)`, `ui/server/dist/…`, `NEON_READONLY_URL`, `ANTHROPIC_KEY`, `find-generic-password` or `@neondatabase/serverless`; `npm … run ui`, `npm … run ui-check`; `node …/dist/boot.js` or `…/dist/main.js`; `curl`/`wget` to `127.0.0.1:8765/(auth|api|agent)` or `localhost:8765/…`; `ps`/`pgrep -a` output searched for `auth?t=`. It still allows `npm --prefix ui run check`, `check:server`, `fake`, `e2e` and `build`. Remove the Python-only patterns of the earlier plan (`finos.keychain`, `keyring`, `ANTHROPIC_UI_KEY`, `NEON_UI_CONNECTION_STRING`, `finos ui-login`) and the `--print-url` rule (the flag no longer exists).
6. **`CLAUDE.md`** (user decision 5). Change the two bullets this breaks: "Only `finos` code reads secrets or queries the database" becomes "Only `finos` (Python, cloud) and `ui/server` (TypeScript, laptop, role `finos_ui`) read secrets or query the database"; "Never put a secret in … a file" names the macOS Keychain item `finos-ui` as the only exception. Add: the laptop holds one read-only Doppler token for root config `ui`, only in the Keychain; `ANTHROPIC_KEY` and `NEON_READONLY_URL` only in the Node process's memory. **On the laptop, only the user runs `ui` and `ui-check`**; Claude may run `npm --prefix ui run check:server` and `fake`, never the web Vitest suite, never `npm install`, only `npm ci --ignore-scripts`. Claude never sends requests to `127.0.0.1:<port>` of the real server (curl, WebFetch, browser tools), never reads process arguments for `auth?t=`, never runs the Keychain store step or a Keychain reader, and never runs a Node one-liner or REPL that imports the server's secret or database modules. **In a cloud session Claude never runs the server's `boot`/`main`, `ui` or `ui-check`.** The guard hook does not stop a script file that imports them. Tell the user to choose "Allow", not "Always Allow", and only right after starting the server.
7. `docs/research/cloud-session-secrets.md` section 4: replace "In the environment: no secrets at all" with the cloud rule plus the laptop rule (one Keychain item, the Node reader, the `ui` config, Claude's limits on the laptop).
8. `tests/live/test_ui_grants.py` (optional cloud check): finos code runs `set local role finos_ui_access` in one `NeonHttpDb.batch`, selects each granted view, and expects a permission error on `transactions`.

### E2 — AG-UI chat endpoint with tools, budget and cost

**Second review (2026-10-26).** A parallel E2 build of another session (kept as the local branch `claude/bi-ui-e2-alt`, not pushed) had its own security and TypeScript reviews (no CRITICAL or HIGH). Six of its fixes are ported onto this E2:
- A cost row that cannot be written is kept in server memory and written before the next model call. While one is still missing, the chat makes no call (`RUN_ERROR` code `record`). A server restart loses it.
- Only `end_turn` and `stop_sequence` end an answer. Any other stop reason without a tool call (`pause_turn`, a context limit, `tool_use` with no tool call) gives `RUN_ERROR` code `stop`, and the turn is not kept.
- At most 8 tool calls run in one round; the others get an `is_error` result.
- One tool result is at most 32,000 characters, else an `is_error` result. `get_health` gives the coverage of the last 12 months, so it stays under that size as the record grows.
- Each Neon request (read batch and cost insert) has its own 15-second `AbortSignal.timeout`, so a hung request cannot hold the busy flag.
- The allow-list snapshot (`tests/ui_grants.snapshot.json`) also holds the type of each column of each granted view, so a figure that turns into text fails `tests/test_ui_views.py`.

**E2.1 Cost, budget and the Anthropic client (tests first, `test/cost.test.ts`, `test/anthropic.test.ts`)**
1. **Price drift test**: the test parses the `PRICES` block of `src/finos/ai.py` and fails if the model set or any of the four prices differs from `cost.ts`.
2. `costUsd` equals every entry of `tests/ui_golden/cost_vectors.json` (the same file Python checks), with half-even rounding, a dated model and an unknown model (costed as `claude-opus-5`, one warning).
3. `checkBudget` refuses at `spent >= FINOS_AI_BUDGET_USD` with the same text as `ai.check_budget`; a database error in `checkBudget` refuses too (fail closed); a bad or non-positive `FINOS_AI_BUDGET_USD` is a start error; the default is 100.
4. **Usage accumulator**: for each field, the latest event that carries it wins; a test where `message_start` and `message_delta` both carry `input_tokens` records the `message_delta` value, not the sum. A call that ends without `message_stop` records `output_tokens = max(seen, max_tokens)`.
5. `insertUsage` sends one parameterised insert with purpose `chat`, the cleaned served model, the four token counts and the cost, with no `RETURNING`; on the emulator it works as `finos_ui_access`.
6. The client, with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG` and `ANTHROPIC_CUSTOM_HEADERS` set before boot, sends only `x-api-key` from Doppler to `https://api.anthropic.com` (injected fake `fetch`), with no `Authorization` and no custom header; a request to another host is refused; a 3xx is not followed.
7. Error mapping: 401 names `ANTHROPIC_KEY` in Doppler config `ui`; 429, 529 and network errors give plain texts; no message holds the key or the response body.
8. No request body has a `cache_control` with `ttl` (only the 5-minute default).

**E2.2 Tools (tests first, `test/tools.test.ts`, on the emulator + golden seed)**
1. Each of the six `zod/v4` schemas converts with `z.toJSONSchema` to valid JSON Schema and refuses unknown fields, bad months, unknown categories, unknown sources, `limit` > 50, and arrays or strings over their `.max()`.
2. Each tool's result equals the `record.ts` figures (the same numbers as `/api`).
3. `show_table source=goals` and every render result label goals "Goal <id>"; no goal name appears.
4. Bad input gives `{error}` and `is_error`, not an exception.
5. **Guard test**: every tool over the seed, with several argument sets; no `ZQX` text in any result; the instruction-like unlisted category appears only as "Other (unlisted)"; every row ID has 8 characters; every `kind`, `status`, `what`, `purpose` and `model` is in its fixed set or pattern.
6. `tools.ts` holds no SQL built from strings: every query is a constant with `$n` parameters (source scan for template literals and `+` next to `select`).

**E2.3 AG-UI endpoint (tests first, `test/agent.test.ts`, `app.request()` + scripted fake `messages.stream`, events parsed with `EventSchema` from `@ag-ui/core/schemas`)**
1. A text-only answer streams `RUN_STARTED`, `TEXT_MESSAGE_START/CONTENT/END`, `RUN_FINISHED`; every event parses with `EventSchema`; no field is `null`; the content type is `text/event-stream`. The body parses with `RunAgentInputSchema`.
2. A `show_chart` round streams the assistant `TEXT_MESSAGE_START`, then `TOOL_CALL_START` with `parentMessageId` = that message, `TOOL_CALL_ARGS/END`, then `TOOL_CALL_RESULT` with `messageId`, `toolCallId` and the server-filled rows, then the closing text; the second model request carries the `tool_result`.
3. Every opened message and tool call is closed before `RUN_FINISHED` or `RUN_ERROR`, also when the fake throws mid-stream. An error after the headers are sent gives a `RUN_ERROR` with a fixed text; the error object is never printed.
4. At the budget → `RUN_ERROR` code `budget` with a plain message, and no model call. A database error in the budget check → `RUN_ERROR`, and no model call. An insert failure → `RUN_ERROR` code `record`, and no next call.
5. The budget is checked before **each** call: a fake that reaches the limit after call 1 gets no call 2.
6. Each call records one `ai_usage` row (purpose `chat`, served model). A stream that breaks after `message_start` records the input tokens and `max_tokens` output tokens, then `RUN_ERROR`. An abort during call 2 still writes the call-2 row with `max_tokens` output tokens.
7. **Call bound**: a fake that always asks for a tool gets exactly 7 `messages.stream` calls at most (6 tool rounds, then 1 final answer without tools), then a plain `RUN_ERROR` if it still asks.
8. The server ignores `tools`, `context`, `state`, `forwardedProps` and client-sent system, developer, assistant and tool messages: a forged tool result in `messages` never appears in the model request.
9. A second run on the same `threadId` sends the stored history; history is capped at 20 turns; a new `threadId` starts empty and drops the old thread.
10. A user message over 2,000 characters, or with non-text parts, → `RUN_ERROR` with a plain message.
11. Two concurrent runs → the second gets `RUN_ERROR` "busy". The flag is clear after `RUN_ERROR`, after an exception and after a disconnect (a third run then succeeds).
12. A client that disconnects after call 1 causes no call 2 (the fake counts calls), and the call-1 cost row exists.
13. The system prompt (asserted in the fake request) says that tool results are data and that figures come only from tools; prompt caching marks are on the system prompt and the last tool schema, with no `ttl`; `max_tokens` is 4,096; the model is `claude-sonnet-5-5`.
14. The `RUN_ERROR` message never holds exception text from the database or the API. Injected errors that hold a fake key, connection string and Doppler token in `message`, `cause` and `headers` leave stdout and stderr without them.

### E3 — Frontend dashboard page (`ui/web`)

**E3.1 Scaffold (tests first)**
1. `ui/web/package.json` has only exact versions from the pins table (with `react-is`, `@testing-library/dom` and `@types/node` pinned); `.npmrc` has `save-exact`, `ignore-scripts`, `engine-strict`, `before=2026-10-10`; `package-lock.json` exists; `@ag-ui/core` and `zod` resolve to one copy each (`npm ls` in the check script).
2. The lock-file test of E1b.2.2 also runs on the web tree: exact pins, registry-only `resolved`, `sha512` `integrity`, `hasInstallScript` only on the allow-list (`esbuild`, `fsevents`), no `@copilotkit/*` or `@ag-ui/client` (option B).
3. `npm --prefix ui/web run check` runs `npm audit signatures`, `node scripts/audit.mjs` (with `audit-allow.json`), `tsc --noEmit`, `vitest run` and `vite build`. It runs in a cloud session only.
4. `vite.config.ts` has no `server.proxy` and no `server.host`. The web Vitest config has the same `test/no-network.ts` setup file.
5. The test setup stubs `ResizeObserver` and gives Recharts a fixed width under jsdom (`ResponsiveContainer` draws nothing at width 0).
6. The CSP decision for `style-src` is checked here: if Recharts output needs inline styles, `style-src 'self' 'unsafe-inline'` is set and the reason is written in `app.ts`; otherwise `style-src 'self'`.

**E3.2 API client and types (tests first, Vitest)**
1. At start, `session.ts` reads `#s=` once, stores it in `sessionStorage` under `finos.session`, and replaces the URL with `#/dashboard` (`history.replaceState`).
2. `api.ts` sends the cookie (same origin) and `X-Finos-Session`; parses decimal strings to numbers for charts only, and formats with Indian grouping (`₹1,23,456.00`).
3. A non-2xx answer shows the plain `{error}` text; no raw body. A 401/403 shows "Session ended. Stop the UI server and start it again."
4. The response types come from one shared file that the server tests also import, so the API shape cannot drift.

**E3.3 Components (tests first, Vitest + Testing Library, synthetic props)**
1. `KpiTiles`: four tiles with value and change (up/down, %), "partial month" badge.
2. `TrendChart`: 12 months of income, expenses and savings; partial months marked; an empty record shows an empty state.
3. `CategoryTable`: categories ordered by position with previous, change and %; negative net (refund) shown as such.
4. `GoalsPanel` (name, budget, spent, remaining, bar) and `SpreadsPanel` (row ID, date, amount, months, start, problems warning); cash vs spread side by side.
5. `HealthPanel`: coverage grid (account × month, days covered / days in month), complete/partial list, review rows and amount, uncategorised, unlinked transfer rows, flagged statements, AI spend by purpose against the `FINOS_AI_BUDGET_USD` in use.
6. A label holding `<img src=x onerror=…>` renders as text (no element made).
7. Each component works in light and dark (`prefers-color-scheme`) and at 360 px width.

**E3.4 Dashboard page**: month picker (default: latest month), cash/spread toggle, the panels; a test with a mocked `fetch` renders every panel from the golden payloads.

### E4 — Chat page with generative UI components (option B; starts after the user answers the open question)

**E4.1 Chat transport (tests first, Vitest)**
1. `agentClient.ts` sends `POST /agent` with `X-Finos-Session`, `Content-Type: application/json`, `Accept: text/event-stream` and a `RunAgentInput` (`threadId`, `runId`, the last user message); it reads the SSE stream in a 50–80 line reader (`data:` lines, blank-line framing, partial chunks).
2. Every event is parsed with `EventSchema` from `@ag-ui/core/schemas` before use; an event that does not parse ends the run with "The chat answer could not be read", not a crash.
3. The assistant text renders as React text nodes only. A reply holding `[x](https://evil.example)`, `![](https://evil.example/a.png)` and `$x$` shows plain text: no `<a>`, `<img>` or KaTeX element.
4. **Storage**: after a scripted chat run (mocked `fetch` stream), `localStorage` is empty, `sessionStorage` holds only `finos.session`, and no `indexedDB.open` call was made (spy). Playwright repeats this check (E5.3).
5. A stop button aborts the `fetch` (`AbortController`).

**E4.2 Tool renderers (tests first, Vitest)**
1. A renderer map by `toolCallName` for `show_kpis`, `show_chart`, `show_table`, `show_category_breakdown` reuses the E3 components and draws from `TOOL_CALL_RESULT.content` only, never from the tool-call arguments' figures.
2. `content` is a string: the renderer runs `JSON.parse`, then the zod check. Invalid JSON or a shape that does not match shows "Could not show this result", not a crash.
3. Between `TOOL_CALL_START` and `TOOL_CALL_RESULT` a skeleton shows the title as text; an `{error}` result shows the plain error.
4. `get_health`, `get_rows` and any unknown tool name show one small "read: <tool>" line (the name passes `^[a-z_]{1,40}$`, else "read: tool").

**E4.3 Chat page**: suggestions ("How did last month compare?", "Show spending by category for <month>"), the AI spend line from `/api/meta` (spent this month of the `FINOS_AI_BUDGET_USD` in use, all purposes, with "The chat shares this limit with finos sync"), and a `RUN_ERROR` shown as a plain message (budget, busy, record, rounds).

### E5 — `npm run ui`, fake backend, smoke test, docs

**E5.1 Root scripts (tests first)**
1. `ui/package.json`: `build` (web `npm ci --ignore-scripts` + `vite build`, then server `npm ci --ignore-scripts` + `tsc`), `ui` (`env -u NODE_OPTIONS -u NODE_PATH node server/dist/boot.js`), `ui-check` (the same with `--check`), `check`, `check:server`, `fake`, `e2e`. A test checks that `ui` and `ui-check` run the compiled `dist/boot.js` through `env -u NODE_OPTIONS -u NODE_PATH`, with no `--require`, `--import` or `--inspect`, and that `build` builds the web app before the server.
2. The README states the laptop flow: `npm --prefix ui run build` once, then `npm --prefix ui run ui`.

**E5.2 Fake backend (`ui/server/src/fake.ts`, `test/fake.test.ts`)**
1. The real `createApp` with an in-memory record from `tests/ui_golden/expected.json` and a scripted fake Claude (one `show_kpis` round, then text). It uses a fixed test token and prints nothing secret. It installs the S8 guard itself: `globalThis.fetch`, `neonConfig.fetchFunction` and `execFile` throw on any call, so it never reaches the Keychain, Doppler, Neon or Anthropic.
2. `test/fake.test.ts` (cloud gate): open `/auth`, call every `/api` route, run one chat, and check the events and figures.

**E5.3 Playwright smoke (`ui/e2e/smoke.mjs`, Chromium) — cloud session**
Uses the preinstalled Playwright 1.63.0; it is not a dependency, and the plan never runs `playwright install`. `smoke.mjs` is an ES module, and ES-module `import` does not read `NODE_PATH`, so it loads Playwright with `createRequire(import.meta.url)("playwright")` (which follows `NODE_PATH=/usr/local/lib/node_modules_global` to `/opt/node-tools/node_modules/playwright`). It depends on `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, which the container sets. On the laptop it is not run.
1. The script starts the fake backend on a free port and opens `/auth?t=<test token>`.
2. The dashboard shows the four KPI tiles, the trend chart, the category table, goals, spreads and health with the golden figures.
3. The chat sends a question; KPI tiles render from the tool result; the closing text appears.
4. A request to `/api/summary` from a page on another port is refused (403), and a request with a wrong Host gets 421.
5. After the chat, `localStorage` is empty, `sessionStorage` holds only `finos.session`, and IndexedDB has no database.
6. No console error (also no CSP violation); no request leaves `127.0.0.1` (route listener).

**E5.4 Docs**: `docs/setup-guide.md` "Part 10. Laptop UI" (Parts 8 and 9 already exist) (ASD-STE100, steps from "User steps"); README commands; handoff.

## Validation
```bash
# Cloud session (the slice gates)
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80
npm --prefix ui/server ci --ignore-scripts && npm --prefix ui/web ci --ignore-scripts
npm --prefix ui run check        # audit signatures, audit (allow-list), tsc, vitest (server + web), vite build
npm --prefix ui run e2e          # Playwright against the fake backend (preinstalled 1.63.0)

# Laptop only (the user runs ui and ui-check)
npm --prefix ui run build        # npm ci --ignore-scripts + builds; never npm install
npm --prefix ui run check:server # optional; server tests only, never the web Vitest suite
npm --prefix ui run ui-check     # the live check of finos_ui
npm --prefix ui run ui
```
- No live call during the build. The Vitest network guard refuses any real request.
- No cloud test can connect as `finos_ui`: the cloud proxy adds the owner's `Neon-Connection-String`, and the cloud Doppler token reads `finos/prd`. `ui-check` on the laptop is the only live check of the login role.
- Optional cloud check of the grants: `FINOS_LIVE=1 uv run pytest tests/live/test_ui_grants.py`. It costs nothing and changes nothing.

## User steps after E1b and E5 (not run by Claude)
> WARNING: Do not type a secret in the chat or on a command line. Enter it only in Doppler, at the `psql \password` prompt or at the hidden prompt of `security add-generic-password`.

> WARNING: Do not make `ui` as a branch config of `prd`. A branch config gets all statement passwords, the Google key and the cloud Anthropic key.

1. On the laptop, run `node --version`. The version must be 22.12 or later 22.x, 24.x, or 26 or later. Node 23 and 25 do not work.
2. Merge the E1 pull request. Run `uv run finos check` in a cloud session, so that migration 0008 runs.
3. On the laptop, connect with `psql` as the owner. Create `finos_ui` with the statements in "Migration" (`connection limit 10`). Set its password with `\password finos_ui`. Run the owner checks (`rolsuper`, `pg_has_role(… 'neon_superuser' …)`, `has_table_privilege(… 'transactions' …)`): all false.
4. In Doppler project `finos`, create a new environment named `ui`. Its root config is `ui`.
5. In config `ui`, add `NEON_READONLY_URL` (role `finos_ui`, `sslmode=require`).
   > CAUTION: `ANTHROPIC_KEY` in config `ui` is the same key as the pipeline's `ANTHROPIC_KEY`. If you revoke or rotate it, `finos sync` also stops. Then update both configs.
6. In the Doppler dashboard, copy the value of `ANTHROPIC_KEY` from config `prd`. Add it to config `ui` as `ANTHROPIC_KEY`. Add no other secret.
7. In config `ui`, make a **read-only** service token with an expiry (for example 90 days). Its value starts with `dp.st.ui.`.
8. In Terminal, run `security delete-generic-password -s finos-ui -a doppler`. Ignore a "could not be found" message.
9. In Terminal, run `security add-generic-password -s finos-ui -a doppler -T "" -w`. Do not add `-U`. Run it yourself, not through Claude. Paste the token at the hidden prompt.
10. In the shell profile, set `FINOS_NEON_HOST` (host only). Set `FINOS_AI_BUDGET_USD` to the same value as the cloud environment (default 100).
11. After E5, run `npm --prefix ui run build`. It runs `npm ci --ignore-scripts` for both trees. Do not run `npm install`.
12. Run `npm --prefix ui run ui-check`. Make sure that it shows the budget value of step 10.
13. Run `npm --prefix ui run ui`.
14. The first start must show a Keychain prompt. If no prompt shows, stop the server. Do steps 8 and 9 again.
15. Choose "Allow" only right after you started the server yourself. Do not choose "Always Allow". Any process that runs `/usr/bin/security` shows the same prompt.
16. If the browser shows "This launch link was used twice", another program used the link. Start the server again and tell Claude in a cloud session.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Role created in the Neon Console joins `neon_superuser`; grants mean nothing | Medium | Setup says `psql` only; `ui-check` and every start refuse when `transactions` is readable. |
| `ui` made as a branch of `prd` and inherits pipeline secrets | Medium | User step 4 and its WARNING; the token prefix check refuses `dp.st.ui_*` and `dp.st.prd.`; the `DOPPLER_*` identity check; extra secret names stop the start. |
| A service token's string does not show that it is read-only (Doppler now allows write tokens) | Medium | User step 7 says read-only; the server never writes to Doppler. Not checkable in code. |
| The `dp.st.<config>.` prefix is not documented by Doppler | Medium | The `DOPPLER_*` identity check of the download is the authoritative check; the prefix is a first filter. |
| A Node test or the fake backend in a cloud session reaches `api.doppler.com` or Neon `/sql`, and the proxy attaches prd credentials | Medium without the guard | S8 network guard in every Vitest run and in `fake.ts`; a test proves it; injected fakes only; CLAUDE.md and the guard hook stop `boot`/`main`/`ui`/`ui-check` in the cloud. |
| `create role` in 0008 fails on Neon (no CREATEROLE) | Low | `DO … if not exists`; tested twice per cluster; `neondb_owner` has CREATEROLE (checked by the first migrate). |
| An `ai_usage` check constraint fails on Neon because an old row breaks it | Low | The migration stops in its transaction and names the constraint; the patterns allow every value Python writes; fix the row in a cloud session, then migrate again. |
| Same-user process reads the Keychain item ("Always Allow", or a script that runs `security`) | Low | Item made fresh with `-T ""` (no `-U`), so every read prompts; login keychain named explicitly; user steps 14–15; token scope root config `ui`, read-only, with expiry; role grants; guard hook; CLAUDE.md: only the user runs `ui`/`ui-check` on the laptop. |
| Code injected into the Node process that holds the secrets (`NODE_OPTIONS`, a loader, the inspector, a TLS override) | Low | Scripts clear `NODE_OPTIONS` and `NODE_PATH`; `hardenEnv` refuses the flags and variables; `boot.ts` loads the SDKs only after hardening; `ignore-scripts=true`; small pinned server tree, separate from the frontend tree, re-installed from the lock file at every build. |
| A compromised npm package in the server tree reads the secrets | Low | 12 runtime packages, exact pins at least two weeks old, lock file with registry-only URLs and `sha512` integrity, `npm audit signatures`, `npm audit`, no install scripts. |
| A compromised web package runs as the user on the laptop | Low | Option B tree of 44 packages; only `ci --ignore-scripts` and `vite build` run on the laptop, never the web Vitest suite. |
| zod 3.25.76 has a high advisory (GHSA-mrhx-c7xc-m3w5) | Certain until 2026-10-26 | Recorded exception with an end date: 64 KiB body limit before `JSON.parse`, `.max()` on every array and string; move to zod 4.6.7 after 2026-10-26. |
| A cross-origin redirect re-sends `Neon-Connection-String` or the Doppler token | Low | `redirect: "error"` on Neon, Doppler and Anthropic (E1b.4.4, E1b.5.5, E2.1.6). |
| The Anthropic SDK reads `ANTHROPIC_*` variables of the laptop's Claude Code | Medium | Variables deleted in `boot.ts` before the SDK module loads; explicit options; host-checking `fetch` (E1b.3.2, E2.1.6). |
| An SDK or driver error object printed by Node's default handler | Medium without handlers | Process-wide handlers with one fixed line; SSE errors with a fixed text; E1b.6.10 and E2.3.14 inject secrets into errors. |
| `ANTHROPIC_KEY` is the pipeline key: no separate revocation and no separate Console spend limit | Certain (user decision 3) | If the laptop is compromised, revoke the shared key; this also stops `finos sync` (user step 5 CAUTION). |
| The chat uses the whole $100 and blocks `/import` for the month | Low, accepted (user decision 4) | No chat-specific limit by the user's choice. The shared check before every call caps the total; the chat page shows the shared spend. |
| The laptop and cloud `FINOS_AI_BUDGET_USD` differ | Medium | `ui-check` and `/api/meta` show the value in use; user steps 10 and 12. |
| A local process reads the launch URL from the process list (`open` arguments) and uses it first | Low | 60 s expiry, one use, one session per process; the user's own later use revokes that session and stops the server (user step 16); the browser opens after the server is ready. |
| The session cookie leaks to another local port (cookies are not port-scoped) | Medium | The cookie alone opens only static files; `/api` and `/agent` also need `X-Finos-Session`, a separate random value that no page body holds and that lives in port-scoped `sessionStorage`. |
| `localhost` resolves to `::1`, which another process holds | Low | Host and Origin allow-lists hold `127.0.0.1:<port>` only; the launch URL uses `127.0.0.1`. |
| Path traversal in the hand-built static handler | Low | Only the files listed at start-up are served; tests with `..`, encoded dots and slashes (E1b.6.7). |
| Budget overshoot by concurrent runs (a cloud sync at the same time) | Low | Check before every call; one run per server; at most 7 calls per question. |
| A broken stream or a disconnect under-records cost | Low | Insert in a `finally` around each call; a call without `message_stop` records `max_tokens` output tokens (E2.1.4, E2.3.6). |
| The TS price table or rounding drifts from `ai.py` | Low | Drift test parses `ai.py`; shared cost vectors checked in both languages (E1b.1.3, E2.1.1–2). |
| Dashboard figures drift from `finos month` | Low | Golden `expected.json` checked by Python and by TS (E1b.1.2, E1b.5.7); tool results equal `/api` figures (E2.2.2). |
| The own SSE reader misreads a stream | Medium | Every event parsed with `EventSchema`; tests for partial chunks and framing (E4.1.1–2); Playwright runs the real browser against the real server code. |
| React 19.3.0 has a security fix in 19.3.1 | Unknown | Re-run the audit at the start of E3 and in every check. |
| The laptop's Node is older than 22.12, or 23/25 | Unknown | User step 1; `engines` with `engine-strict` in each tree. |
| Unlinked transfer rows differ from `finos status` "unpaired" | Certain (different rule) | The panel says "transfer rows not linked"; `finos transfers` remains the detailed check in a cloud session. |
| A launch token in browser history | Certain, low impact | One use, 60 s, per process; a second use stops the server. |

## Decisions from the user (2026-10-24)
1. Backend: **TypeScript on Node**, not Python. Everything lives in `ui/`: the Node server (AG-UI endpoint, dashboard JSON API, static files) and the React/Vite frontend. Migrations stay in Python (`finos migrate` in the cloud).
2. Secret names: config `ui` holds exactly **`ANTHROPIC_KEY`** and **`NEON_READONLY_URL`**. The root-config check is by the token and the config identity, not by the secret names.
3. Anthropic key: **reuse the existing key.** The user copies the value of `ANTHROPIC_KEY` from `prd` into config `ui`. No new key. The key lives only in the Node server's memory and never reaches the browser.
4. Limits: **no chat-specific limit.** No `FINOS_CHAT_BUDGET_USD` and no per-question cap. The shared `FINOS_AI_BUDGET_USD` ($100) check runs before every model call; chat spend is recorded as `purpose = 'chat'` with the `ai.py` prices; at most 6 tool rounds.
5. CLAUDE.md laptop exception: **approved**, now for the Node reader: one read-only Doppler service token for root config `ui` of the new environment `ui`, only in the macOS Keychain. The third revision narrows Claude's part: on the laptop only the user runs `ui` and `ui-check` (E1b.7.6). The same exception goes into `docs/research/cloud-session-secrets.md` section 4 (E1b.7.7).
6. Laptop OS: **macOS.** No Windows or Linux steps. The server binds `127.0.0.1`.
7. Goals: **IDs only** to the model ("Goal <id>").
8. Node is on the laptop: **build `ui/` locally.** `ui/web/dist/` and `ui/server/dist/` stay git-ignored.
9. Chat model: **`claude-sonnet-5-5`.**
10. **Decided (2026-10-24):** own chat component (option B). The user approved the plan.

## Review points

### Third revision (2026-10-24): security and feasibility reviews
Applied, security:
- S1 network guard: Vitest `setupFiles` stubs for `fetch` and `neonConfig.fetchFunction`, a proof test, the guard in `fake.ts`, and the cloud rule in CLAUDE.md (S8, E1b.2.4, E5.2.1, E1b.7.6).
- S2 two separate random values for the cookie and `X-Finos-Session`, with two tests (S3, E1b.6.3).
- S3 one session per process; a second use of the token revokes it and stops the server; `localhost` dropped from Host and Origin (S3, E1b.6.1–2, E1b.6.5, user step 16).
- S4 `boot.ts` with a dynamic import after `hardenEnv()`; an import-graph test; scripts clear `NODE_OPTIONS`/`NODE_PATH`; TLS and proxy flags refused (S4, E1b.3.1–2, E5.1.1).
- S5 process-wide error handlers, fixed SSE error text, secret-in-error tests (S4, E1b.6.10, E2.3.3, E2.3.14).
- S6 latest-event usage, `max_tokens` on an unfinished call, fail-closed budget, exact 7-call bound, no `ttl: "1h"` (S5, E2.1.3–4, E2.1.8, E2.3.4–7).
- S7 cleaners for `purpose`, `model`, `kind`, `status`, `what`; `ai_usage_text` constraint in `0009` (S2, "Output cleaners", E1b.0.4, E1b.5.9), with one change (see "Rejected review points").
- S8 Keychain: delete then add without `-U`; login keychain path; first-start prompt check; "Allow only after you started it" (S4, user steps 8–9, 14–15).
- S9 `npm ci --ignore-scripts` everywhere; no `npm install` on the laptop; lock-file URL, integrity and install-script tests; `npm audit signatures`; `engine-strict`; no web Vitest on the laptop; build order web then server (S9, E1b.2, E3.1, E5.1, Validation).
- S10 CLAUDE.md: only the user runs `ui`/`ui-check` on the laptop; no requests to the real port; no `auth?t=` from process lists; no server start in the cloud; both broken bullets rewritten; research doc §4; hook patterns and tests (E1b.7.5–7). `check:server` added, because S9 forbids the web Vitest suite on the laptop.
- S11 CSP with `base-uri`, `form-action`, `object-src`, `script-src 'self'`, a no-unsafe test, and a recorded `style-src` decision (S3, E1b.6.6, E3.1.6).
- S12 budget value shown in `ui-check` and `/api/meta`; user step to match the cloud value.

Applied, feasibility:
- F1 the audit line removed; a recorded zod exception with an end date and an allow-list file; move to zod 4.6.7 after 2026-10-26.
- F2 option B (own chat component) is now the default, **pending the user's answer** (Requirement 3 named CopilotKit). E4 rewritten; E4.1.4 storage test kept.
- F3 schemas from `@ag-ui/core/schemas`.
- F4 tool schemas with `zod/v4` and `z.toJSONSchema`.
- F5 `serve({ … hostname: "127.0.0.1" })` and an address test.
- F6 Playwright through `createRequire`; never `playwright install`.
- F7 `react-is`, `@testing-library/dom` and `@types/node` pinned.
- F8 `hardenEnv({ env, execArgv })` with injected inputs.
- F9 fallback beta closed (not used); `--print-url` and `--no-browser` removed with their hook rule; `ui-check` is `start({ check: true })`.
- F10 "parts" removed from Requirement 2.4.
- F11 unlinked transfer rows from `sum(own_rows)`; schema gate compares names without `.sql`; `engines.node` as vitest.
- F12 `ResizeObserver` stub and fixed chart width; Postgres `globalSetup` skips on the laptop; one real-socket test for no Host header.

### Rejected review points
- **Security 7, the `purpose` pattern `^[a-z_]{1,20}$`: changed, not taken as written.** Python writes `eval-extract` and `eval-categorise` (`src/finos/evaluate.py`), which have `-`. That pattern would fail the migration on Neon if eval rows exist, and would fail the next paid `finos eval`. The constraint uses `^[a-z_-]{1,20}$`; the UI cleaner still maps to the fixed set of five purposes.
- **Feasibility 1, `before=2026-10-12` for zod 4.6.7: changed to `before=2026-10-13`.** npm's `before` keeps versions published before that instant, so `2026-10-12` (midnight) excludes 4.6.7, which was published on 2026-10-12. The exact pin in the lock file still stops anything else.
- **Feasibility 10, computing spread parts in `record.ts`: not taken.** The review offered two options; the plan takes the other one (remove "parts" from 2.4), because the spread figures are already in `v_monthly_summary_spread` and a second port of `spread.parts` adds code and a drift risk for one panel.
- No other point is rejected. Feasibility 2 is applied as the default but is not final until the user answers.

### Revision of 2026-10-24 (TypeScript backend)
- Server: Starlette/uvicorn → Hono + `@hono/node-server`; `ag-ui-protocol` (pydantic) → `@ag-ui/core` schemas and hand-written SSE; pydantic tool inputs → zod.
- Keychain: `keyring` → `/usr/bin/security` with `execFile` and an item made with `-T ""`; the insecure-backend check is gone; `finos ui-login` is replaced by the user's own `security add-generic-password` step.
- Secrets: `ANTHROPIC_UI_KEY` / `NEON_UI_CONNECTION_STRING` → `ANTHROPIC_KEY` / `NEON_READONLY_URL`; the exact-name-set proof → token prefix plus `DOPPLER_*` identity, with extra names still refused as a second check.
- New for Node: `NODE_OPTIONS`/`execArgv` refusal, `ANTHROPIC_*` removal at boot, `redirect: "error"` on every secret-bearing request, a static allow-list map, `timingSafeEqual` with a length check, a separate server dependency tree.
- Budget: `check_chat_budget`, `FINOS_CHAT_BUDGET_USD` and `FINOS_CHAT_TURN_MAX_USD` removed (user decision 4).
- Run control: `threading.Lock` and the thread wrapper → a synchronous in-flight flag and an `AbortController`.
- Cost: a TS port with integer half-even arithmetic, a drift test against `ai.py`, and shared cost vectors.
- Tests: Python `TestClient` tests → Vitest with `app.request()`, a TS Neon emulator over `pg` and a Postgres `globalSetup`; one golden seed and `expected.json` for both languages.
- Playwright: the preinstalled 1.63.0 in the cloud container now runs the smoke test in the cloud gate.
- Guard hook, CLAUDE.md and research doc: moved from E5 to E1b.7, because the Keychain reader lands in E1b.
- Resolved open question: no sequence grant is needed for the `ai_usage` insert.

### Earlier revision (still applied)
- Security 1–13 and Feasibility 1–13 of the first revision stay applied where they do not name Python: the root config `ui`, the `ai_usage_not_negative` check, the record failure stop, launch token limits, `Sec-Fetch-Site`/`Origin`/`Content-Type` checks, the allow-list snapshot, `v_ui_goal_progress`, the Host check everywhere, the 64 KiB limit, packaged category names, browser storage checks, the zod major, the six tools, no dev server and proxy, one thread in memory, and the React 19.3.0 audit.
- Feasibility 12.2 stays partly rejected: the per-run `X-Finos-Session` value stays, because the cookie reaches every local port.
- Security 8 `--dev` flag stays not built.
