// The fake backend (npm --prefix ui run fake, and the Playwright smoke test). The real createApp
// and the real chat agent, over the synthetic golden record (tests/ui_golden/expected.json) and a
// scripted fake Claude: one show_kpis round, then a closing text. It needs no Keychain, no
// Doppler, no Neon and no Anthropic key, and it cannot reach them: installGuard (S8) makes
// fetch, the Neon driver's fetch and child_process refuse every call before anything else runs.
// It imports none of keychain.ts, doppler.ts or db.ts.
//
// The launch token is a fixed test value, not a secret. The one line it prints is the launch link.
// The clock is frozen, so the link never expires; the app still serves one session and stops when
// the link is used twice.
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { neonConfig } from "@neondatabase/serverless";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import { createAgent } from "./agent.js";
import type { Chat } from "./anthropic.js";
import { type WebFile, createApp, listWeb } from "./app.js";
import { add, compare } from "./decimal.js";
import { StartError } from "./errors.js";
import type { Db } from "./db.js";
import type { Record_ } from "./record.js";

export const FAKE_TOKEN = "FAKE-LAUNCH-TOKEN-NOT-A-SECRET-0123456789ab";
const DEFAULT_PORT = 8766; // not 8765, the port of the real server
const BUDGET_USD = "100";
const REFUSED = "real network or process call in the fake backend";

type Json = Record<string, any>;
type Writer = { write(text: string): unknown };

// --- the S8 guard ---------------------------------------------------------------------------

const PROCESS_CALLS = ["execFile", "execFileSync", "exec", "execSync", "spawn", "spawnSync", "fork"] as const;

/** fetch, neonConfig.fetchFunction and every child_process starter refuse each call. Returns a
 * function that puts the originals back (the tests use it; the entry point never does). */
export function installGuard(): () => void {
  const original = {
    fetch: globalThis.fetch,
    neon: neonConfig.fetchFunction,
    calls: PROCESS_CALLS.map((name) => [name, childProcess[name]] as const),
  };
  const refuse = () => {
    throw new Error(REFUSED);
  };
  globalThis.fetch = (() => Promise.reject(new Error(REFUSED))) as unknown as typeof fetch;
  neonConfig.fetchFunction = () => Promise.reject(new Error(REFUSED));
  for (const name of PROCESS_CALLS) (childProcess as Json)[name] = refuse;
  syncBuiltinESMExports(); // a named import of node:child_process sees the stubs too
  return () => {
    globalThis.fetch = original.fetch;
    neonConfig.fetchFunction = original.neon;
    for (const [name, call] of original.calls) (childProcess as Json)[name] = call;
    syncBuiltinESMExports();
  };
}

// --- the record -----------------------------------------------------------------------------

export type FakeRecord = Pick<
  Record_,
  "meta" | "months" | "month" | "goals" | "goalProgress" | "spreads" | "health" | "rows" | "categorySeries"
>;

function loadExpected(): Json {
  const path = new URL("../../../tests/ui_golden/expected.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The read API over the golden figures. `spent` is this month's AI spend, as the fake database
 * holds it, so the chat page's spend line moves after a question. */
export function fakeRecord(expected: Json, spent: () => string): FakeRecord {
  const basis = (spread: boolean): "spread" | "cash" => (spread ? "spread" : "cash");
  const monthView = (month: string, spread: boolean): Json | null =>
    expected.month[basis(spread)][month.slice(0, 7)] ?? null;
  return {
    async meta() {
      return {
        schema_version: expected.health.schema_version,
        months: expected.months.cash.map((m: Json) => m.month),
        spent_this_month: spent(),
      };
    },
    async months({ spread, last = 12 }) {
      return expected.months[basis(spread)].slice(-last);
    },
    async month(month, { spread }) {
      return monthView(month, spread) as never;
    },
    async goals() {
      return expected.goals;
    },
    async goalProgress() {
      return expected.goals.map(({ name: _name, ...goal }: Json) => goal);
    },
    async spreads() {
      return expected.spreads;
    },
    async health() {
      return expected.health;
    },
    async rows(filter) {
      const month = filter.month?.slice(0, 7);
      const matching = expected.rows.all.rows.filter(
        (r: Json) =>
          (month === undefined || r.month.slice(0, 7) === month) &&
          (filter.category === undefined || r.category === filter.category) &&
          (filter.source === undefined || r.source === filter.source) &&
          (filter.min_amount === undefined || compare(r.amount, filter.min_amount) >= 0),
      );
      return { total: matching.length, rows: matching.slice(0, filter.limit) };
    },
    async categorySeries({ spread, category, first, last }) {
      return expected.months[basis(spread)]
        .filter((m: Json) => m.month >= first && m.month <= last)
        .map((m: Json) => ({
          month: m.month as string,
          complete: m.complete as boolean,
          net: (monthView(m.month, spread)?.categories as Json[] | undefined)
            ?.find((c) => c.category === category)?.net ?? "0",
        }));
    },
  };
}

// --- the scripted model and the in-memory database ------------------------------------------

/** One streamed call as the SDK gives it: message_start, blocks, message_delta, message_stop. */
async function* streamOf(opts: {
  text?: string; tool?: { id: string; name: string; input: unknown }; input: number; output: number;
}): AsyncGenerator<RawMessageStreamEvent> {
  const usage = {
    input_tokens: opts.input, output_tokens: opts.output,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  };
  const event = (e: Json) => e as RawMessageStreamEvent;
  yield event({
    type: "message_start",
    message: { id: "msg_fake", model: "claude-sonnet-5-5", usage: { ...usage, output_tokens: 1 } },
  });
  if (opts.text !== undefined) {
    yield event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    yield event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.text } });
    yield event({ type: "content_block_stop", index: 0 });
  }
  if (opts.tool) {
    const { id, name, input } = opts.tool;
    yield event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } });
    yield event({
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    yield event({ type: "content_block_stop", index: 0 });
  }
  yield event({
    type: "message_delta", delta: { stop_reason: opts.tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage,
  });
  yield event({ type: "message_stop" });
}

/** A Claude that asks for show_kpis for `month`, then, once the tool result is back, answers. */
export function scriptedClaude(month: string): Chat {
  let calls = 0;
  return {
    messages: {
      stream(body) {
        const last = body.messages[body.messages.length - 1];
        const answered =
          last?.role === "user" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
        if (answered) {
          return streamOf({
            text: `These are the key figures for ${month} from the sample record.`, input: 1900, output: 60,
          });
        }
        return streamOf({
          tool: {
            id: `toolu_fake${++calls}`, name: "show_kpis",
            input: { month, metrics: ["income", "expenses", "savings", "investments"], title: `Key figures for ${month}` },
          },
          input: 1500, output: 120,
        });
      },
    },
  };
}

/** The two things the agent asks of the database: this month's spend, and one cost row. */
function memoryDb() {
  const state = { spent: "0" };
  const db: Pick<Db, "read" | "insertUsage"> = {
    async read() {
      return [[{ spent: state.spent }]];
    },
    async insertUsage(row) {
      state.spent = add(state.spent, row.cost_usd);
    },
  };
  return { db, spent: () => state.spent };
}

// --- the app --------------------------------------------------------------------------------

export function createFake(opts: { port: number; web: Map<string, WebFile>; stop: (reason: string) => void }) {
  const expected = loadExpected();
  const memory = memoryDb();
  const record = fakeRecord(expected, memory.spent);
  const months: Json[] = expected.months.cash;
  const latest = String(months[months.length - 1]!.month).slice(0, 7);
  const agent = createAgent({
    record, db: memory.db, client: scriptedClaude(latest), budgetUsd: BUDGET_USD,
    warn: () => {}, // the scripted model is priced; nothing to warn about
  });
  const frozen = Date.now();
  const app = createApp({
    port: opts.port, record, budgetUsd: BUDGET_USD, launchToken: FAKE_TOKEN,
    issuedAt: frozen, now: () => frozen, web: opts.web, agent, stop: opts.stop,
  });
  return { app, record };
}

function listen(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  return new Promise<ServerType>((resolve, reject) => {
    // Without hostname, @hono/node-server listens on every interface.
    const server = serve({ fetch, port, hostname: "127.0.0.1" });
    server.once("listening", () => resolve(server));
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(new StartError(
        error.code === "EADDRINUSE" ? `Port ${port} is in use. Start with --port N.` : "The fake backend could not listen.",
      )));
  });
}

export async function startFake(opts: { port: number; webDist: string; out: Writer }) {
  const web = listWeb(opts.webDist);
  let server: ServerType | null = null;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (finish = resolve));
  const stop = (code = 0) => {
    server?.close();
    finish(code);
  };
  const { app } = createFake({ port: opts.port, web, stop: () => stop(1) });
  server = await listen(app.fetch, opts.port);
  opts.out.write(`Fake backend: http://127.0.0.1:${opts.port}/auth?t=${FAKE_TOKEN}\n`);
  return { server, done, stop };
}

function parsePort(argv: string[]): number {
  if (argv.length === 0) return DEFAULT_PORT;
  const port = Number(argv[1]);
  if (argv.length !== 2 || argv[0] !== "--port" || !/^[0-9]{4,5}$/.test(argv[1]!) || port < 1024 || port > 65535) {
    throw new StartError("The fake backend takes --port N only (1024 to 65535).");
  }
  return port;
}

/** The entry point: the guard first, then the server. Returns the exit code. */
export async function runFake(argv: string[]): Promise<number> {
  installGuard();
  try {
    const started = await startFake({
      port: parsePort(argv),
      webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
      out: process.stdout,
    });
    process.once("SIGINT", () => started.stop(0));
    process.once("SIGTERM", () => started.stop(0));
    return await started.done;
  } catch (error) {
    process.stderr.write(`${error instanceof StartError ? error.message : "The fake backend could not start."}\n`);
    return 1;
  }
}

// Run only as the entry point (node server/dist/fake.js), never when a test imports the module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runFake(process.argv.slice(2));
}
