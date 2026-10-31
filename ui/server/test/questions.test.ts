// The question bank: ordinary questions a household asks the chat ("what are my average monthly
// expenses", "which rows look wrong"), each with the tool calls a good analyst makes. Each runs
// through createAgent with the REAL tools over the golden seed on the Postgres emulator, with a
// scripted model in place of Claude. A question passes when every tool result is good data (no
// is_error), every component parses with the web app's own result schema, the run ends with
// RUN_FINISHED, and each tool it needs has a description that names the question's key words, so
// that the real model can find it. The golden record has 2026-08 and 2026-09, both partial: a
// question about another month gets an empty answer, which is still a good result.
import { EventSchema } from "@ag-ui/core/schemas";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT, createAgent } from "../src/agent.js";
import { createDb } from "../src/db.js";
import { add } from "../src/decimal.js";
import { createRecord } from "../src/record.js";
import { Secret } from "../src/secret.js";
import { TOOL_NAMES, createTools } from "../src/tools.js";
import { isRenderTool, parseResult } from "../../web/src/results.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");
const PLANTED = /ZQX|zqx/i;

type Json = Record<string, any>;
type Call = { name: string; input: Json };
type Question = {
  ask: string;
  rounds: Call[][]; // the tool calls of each round; one text answer follows the last round
  keys: Record<string, RegExp>; // each tool called, and the words its description must have
  check?: (results: Map<string, Json[]>) => void; // results by tool name, in call order
};

// --- the questions --------------------------------------------------------------------------

const Q: Question[] = [
  {
    ask: "What are my average monthly expenses?",
    rounds: [
      [{ name: "get_health", input: {} }],
      [{ name: "get_stats", input: { metric: "expenses", from_month: "2026-08", to_month: "2026-09", complete_only: false } }],
    ],
    keys: { get_health: /complete or partial/, get_stats: /average/ },
    check: (r) => expect(r.get("get_stats")![0]!.average).toMatch(/^[0-9]+\.[0-9]{2}$/),
  },
  {
    ask: "Why was September so high?",
    rounds: [[
      { name: "show_kpis", input: { month: "2026-09", metrics: ["expenses", "income", "savings"] } },
      { name: "show_category_breakdown", input: { month: "2026-09" } },
      { name: "find_suspects", input: { from_month: "2026-09", to_month: "2026-09", min_amount: "5000" } },
    ]],
    keys: { show_kpis: /one month/, show_category_breakdown: /by category/, find_suspects: /high/ },
  },
  {
    ask: "What do I spend most on this year?",
    rounds: [[{ name: "get_top", input: { by: "categories", from_month: "2026-01", to_month: "2026-10" } }]],
    keys: { get_top: /spend most/ },
    check: (r) => {
      const top = r.get("get_top")![0]!;
      expect(top.rows.length).toBeGreaterThan(1);
      expect(top.rows.at(-1)[0]).toBe("All");
    },
  },
  {
    ask: "Compare Q1 and Q2 spending",
    rounds: [[{ name: "compare_periods", input: { metric: "expenses", a_from: "2026-01", a_to: "2026-03", b_from: "2026-04", b_to: "2026-06" } }]],
    keys: { compare_periods: /compares[\s\S]*quarter/ },
    check: (r) => expect(r.get("compare_periods")![0]!.rows.map((row: unknown[]) => row[0])).toEqual(["A", "B", "B minus A"]),
  },
  {
    ask: "What were the biggest payments in September?",
    rounds: [[{ name: "show_table", input: { source: "rows", from_month: "2026-09", to_month: "2026-09", sort: "amount", limit: 10 } }]],
    keys: { show_table: /rows \(single transactions[\s\S]*largest first/ },
    check: (r) => {
      const amounts = r.get("show_table")![0]!.rows.map((row: unknown[]) => Number(row[4]));
      expect(amounts.length).toBeGreaterThan(1);
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    },
  },
  {
    ask: "Which rows look wrong?",
    rounds: [[{ name: "find_suspects", input: {} }]],
    keys: { find_suspects: /look wrong/ },
    check: (r) => {
      const found = r.get("find_suspects")![0]!;
      expect(found.columns.at(-1)).toBe("reason");
      expect(found.rows.length).toBeGreaterThan(0);
      for (const row of found.rows) expect(["other_or_unknown", "unlinked_round", "outlier"]).toContain(row.at(-1));
    },
  },
  {
    ask: "How much did I invest in 2026?",
    rounds: [[{ name: "get_stats", input: { metric: "investments", from_month: "2026-01", to_month: "2026-12", complete_only: false } }]],
    keys: { get_stats: /total/ },
  },
  {
    ask: "Show my savings trend",
    rounds: [[{ name: "show_chart", input: { kind: "line", series: ["savings", "income"], from_month: "2026-01", to_month: "2026-10" } }]],
    keys: { show_chart: /trend/ },
  },
  {
    ask: "How is Goal 1 doing?",
    rounds: [[{ name: "show_table", input: { source: "goals" } }]],
    keys: { show_table: /goals \(budget, spent/ },
    check: (r) => expect(r.get("show_table")![0]!.rows[0][0]).toBe("Goal 1"),
  },
  {
    ask: "Is my groceries average higher than last quarter?",
    rounds: [[{
      name: "compare_periods",
      input: { category: "Groceries", a_from: "2026-04", a_to: "2026-06", b_from: "2026-07", b_to: "2026-09", complete_only: false },
    }]],
    keys: { compare_periods: /monthly average[\s\S]*the last/ },
  },
  {
    ask: "Is October complete?",
    rounds: [[{ name: "get_health", input: {} }]],
    keys: { get_health: /complete or partial/ },
    check: (r) => expect(r.get("get_health")![0]).toHaveProperty("partial_months"),
  },
  {
    ask: "What were my five biggest expenses in the last two months?",
    rounds: [[{ name: "get_top", input: { by: "rows", from_month: "2026-08", to_month: "2026-09", limit: 5 } }]],
    keys: { get_top: /biggest expenses/ },
    check: (r) => expect(r.get("get_top")![0]!.rows.length).toBeLessThanOrEqual(5),
  },
  {
    ask: "How much income did I get in September?",
    rounds: [[{ name: "show_kpis", input: { month: "2026-09", metrics: ["income"] } }]],
    keys: { show_kpis: /income/ },
  },
  {
    ask: "Show spending by category for September against August",
    rounds: [[{ name: "show_category_breakdown", input: { month: "2026-09", compare: true } }]],
    keys: { show_category_breakdown: /spending[\s\S]*by category[\s\S]*month before/ },
  },
  {
    ask: "Which month had my highest expenses?",
    rounds: [[{ name: "get_stats", input: { metric: "expenses", from_month: "2026-01", to_month: "2026-10", complete_only: false } }]],
    keys: { get_stats: /highest/ },
    check: (r) => expect(r.get("get_stats")![0]!.highest.month).toMatch(/^2026-0[89]$/),
  },
  {
    ask: "Are there transfers between my own accounts that are not linked?",
    rounds: [[
      { name: "get_health", input: {} },
      { name: "find_suspects", input: { min_amount: "1000" } },
    ]],
    keys: { get_health: /unlinked transfers/, find_suspects: /own accounts/ },
  },
  {
    ask: "List my grocery transactions in September",
    rounds: [
      [{ name: "get_rows", input: { category: "Groceries", month: "2026-09" } }],
      [{ name: "show_table", input: { source: "rows", category: "Groceries", month: "2026-09" } }],
    ],
    keys: { get_rows: /transactions/, show_table: /single transactions/ },
  },
  {
    ask: "What is my median monthly spend on food?",
    rounds: [[{ name: "get_stats", input: { category: "Food & dining", from_month: "2026-01", to_month: "2026-10", complete_only: false } }]],
    keys: { get_stats: /median/ },
  },
  {
    ask: "How much did I earn and spend this year?",
    rounds: [[
      { name: "show_table", input: { source: "months", last: 12 } },
      { name: "get_stats", input: { metric: "income", from_month: "2026-01", to_month: "2026-10", complete_only: false } },
      { name: "get_stats", input: { metric: "expenses", from_month: "2026-01", to_month: "2026-10", complete_only: false } },
    ]],
    keys: { show_table: /monthly summary/, get_stats: /total/ },
  },
  {
    ask: "What do my spread costs look like?",
    rounds: [[{ name: "show_table", input: { source: "spreads" } }]],
    keys: { show_table: /spreads/ },
  },
  {
    ask: "How many rows need review, and is any statement flagged?",
    rounds: [[{ name: "get_health", input: {} }]],
    keys: { get_health: /waiting for review[\s\S]*flagged/ },
  },
  {
    ask: "Where does my income come from this year?",
    rounds: [[{ name: "get_top", input: { by: "categories", kind: "income", from_month: "2026-01", to_month: "2026-10" } }]],
    keys: { get_top: /income/ },
  },
  {
    ask: "Is a large Other debit distorting my expenses?",
    rounds: [[
      { name: "find_suspects", input: { from_month: "2026-08", to_month: "2026-09", min_amount: "1000" } },
      { name: "get_rows", input: { category: "Other", from_month: "2026-08", to_month: "2026-09", sort: "amount" } },
    ]],
    keys: { find_suspects: /distort/, get_rows: /sort amount/ },
  },
];

// --- the scripted model ---------------------------------------------------------------------

/** One streamed model message: text, or one or more tool calls. */
function reply(opts: { text?: string; tools?: (Call & { id: string })[] }) {
  return async function* () {
    yield {
      type: "message_start",
      message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    };
    let index = 0;
    if (opts.text !== undefined) {
      yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index, delta: { type: "text_delta", text: opts.text } };
      yield { type: "content_block_stop", index: index++ };
    }
    for (const tool of opts.tools ?? []) {
      yield { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } };
      yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } };
      yield { type: "content_block_stop", index: index++ };
    }
    const stop_reason = opts.tools?.length ? "tool_use" : "end_turn";
    yield { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    yield { type: "message_stop" };
  };
}

function scripted(question: Question) {
  let n = 0;
  const steps = [
    ...question.rounds.map((round) => reply({ tools: round.map((c) => ({ ...c, id: `toolu_${++n}` })) })),
    reply({ text: "The answer, with the figure first." }),
  ];
  const requests: Json[] = [];
  let next = 0;
  const stream = vi.fn((params: Json) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const step = steps[next++];
    if (!step) throw new Error("the script has no step for this call");
    return step();
  });
  return { client: { messages: { stream } } as never, requests, calls: () => next, steps: steps.length };
}

function fakeDb() {
  let spent = "0";
  return {
    read: vi.fn(async () => [[{ spent }]]),
    insertUsage: vi.fn(async (row: { cost_usd: string }) => void (spent = add(spent, row.cost_usd))),
  } as never;
}

function parseEvents(text: string): Json[] {
  return text.split("\n\n").filter(Boolean).map((block) => {
    expect(block.startsWith("data: ")).toBe(true);
    return EventSchema.parse(JSON.parse(block.slice("data: ".length))) as Json;
  });
}

// --- the checks that need no database -------------------------------------------------------

const DEFINITIONS = createTools({} as never).definitions;
const describeTool = (name: string) => DEFINITIONS.find((d) => d.name === name)?.description;

describe("the question bank needs only defined tools that say what they are for", () => {
  it.each(Q.map((q) => [q.ask, q] as const))("%s", (_, question) => {
    const called = new Set(question.rounds.flat().map((c) => c.name));
    expect([...called].sort()).toEqual(Object.keys(question.keys).sort());
    for (const [name, words] of Object.entries(question.keys)) {
      expect(TOOL_NAMES, name).toContain(name);
      expect(describeTool(name), name).toMatch(words);
    }
  });

  it("covers every tool", () => {
    const used = new Set(Q.flatMap((q) => q.rounds.flat().map((c) => c.name)));
    expect([...used].sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe("the system prompt routes only to tools that exist", () => {
  it("names every tool, and every tool name it uses is in TOOL_NAMES", () => {
    for (const name of TOOL_NAMES) expect(SYSTEM_PROMPT, name).toContain(name);
    const named = SYSTEM_PROMPT.match(/\b(?:show|get|compare|find)_[a-z_]+\b/g) ?? [];
    for (const name of named) expect(TOOL_NAMES as readonly string[], name).toContain(name);
    // The "Which tool:" lines each start with a tool (or "x or y") that exists.
    const routing = SYSTEM_PROMPT.split("Which tool:")[1]!.split("\n\n")[0]!;
    const heads = routing.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split(/[: ]/)[0]!);
    expect(heads.length).toBeGreaterThanOrEqual(6);
    for (const head of heads) expect(TOOL_NAMES as readonly string[], head).toContain(head);
  });
});

// --- the questions over the golden seed -----------------------------------------------------

describe.skipIf(!pgAdmin)(`the question bank over the golden seed (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());

  async function ask(question: Question) {
    const model = scripted(question);
    let id = 0;
    const agent = createAgent({
      record: createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction })),
      db: fakeDb(), client: model.client, budgetUsd: "100", newId: () => `id-${++id}`, warn: () => {},
    });
    const app = new Hono().post("/agent", async (c) => agent(await c.req.json(), c));
    const res = await app.request("/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-q", runId: "run-q", state: {}, tools: [], context: [], forwardedProps: {},
        messages: [{ id: "u-1", role: "user", content: question.ask }],
      }),
    });
    expect(res.status).toBe(200);
    return { events: parseEvents(await res.text()), model };
  }

  it.each(Q.map((q) => [q.ask, q] as const))("%s", async (_, question) => {
    const { events, model } = await ask(question);
    expect(events.at(-1)!.type, JSON.stringify(events.at(-1))).toBe("RUN_FINISHED");
    expect(model.calls()).toBe(model.steps);

    // Every tool result is good data: no is_error in what went back to the model.
    for (const request of model.requests) {
      for (const message of request.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type === "tool_result") expect(block.is_error, block.content).toBeUndefined();
        }
      }
    }

    const names = new Map(events.filter((e) => e.type === "TOOL_CALL_START").map((e) => [e.toolCallId, e.toolCallName]));
    const results = events.filter((e) => e.type === "TOOL_CALL_RESULT");
    expect(results).toHaveLength(question.rounds.flat().length);
    const byTool = new Map<string, Json[]>();
    for (const result of results) {
      const name = names.get(result.toolCallId)!;
      expect(result.content).not.toMatch(PLANTED);
      const data = JSON.parse(result.content);
      expect(data, `${name}: ${result.content.slice(0, 200)}`).not.toHaveProperty("error");
      if (isRenderTool(name)) {
        // The browser's own check: what it draws, not "Could not show this result".
        expect(parseResult(name, result.content), `${name}: ${result.content.slice(0, 300)}`).toMatchObject({ ok: true });
      } else {
        expect(data.component, name).toBe("read");
      }
      byTool.set(name, [...(byTool.get(name) ?? []), data]);
    }
    question.check?.(byTool);
  });
});
