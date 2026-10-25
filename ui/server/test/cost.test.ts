// E2.1: the price table, costUsd, the budget check, the usage accumulator and the usage insert.
// The Python side checks the same cost vectors (tests/test_ui_golden.py).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BudgetCheckError, BudgetExceeded, PRICES, UsageAccumulator, checkBudget, costUsd, parseBudget,
  servedModel,
} from "../src/cost.js";
import { createDb, type Db } from "../src/db.js";
import { DbError, StartError } from "../src/errors.js";
import { Secret } from "../src/secret.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const ROOT = new URL("../../../", import.meta.url);
const VECTORS = JSON.parse(readFileSync(new URL("tests/ui_golden/cost_vectors.json", ROOT), "utf8"));
const AI_PY = readFileSync(new URL("src/finos/ai.py", ROOT), "utf8");
const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");

/** The PRICES block of ai.py: model -> [input, output, cache write, cache read]. */
function pythonPrices(): Record<string, number[]> {
  const block = /^PRICES[^\n]*\{\n([\s\S]*?)^\}/m.exec(AI_PY)?.[1] ?? "";
  const prices: Record<string, number[]> = {};
  for (const line of block.split("\n").filter((l) => l.trim())) {
    const found = /^\s*"([^"]+)": \((.*)\),$/.exec(line);
    if (!found) throw new Error(`unreadable PRICES line: ${line}`);
    prices[found[1]!] = [...found[2]!.matchAll(/Decimal\("([0-9.]+)"\)/g)].map((m) => Number(m[1]));
  }
  return prices;
}

describe("the price table", () => {
  it("equals the PRICES block of src/finos/ai.py: same models, same four prices", () => {
    const python = pythonPrices();
    expect(Object.keys(python).length).toBeGreaterThan(0);
    const here = Object.fromEntries(
      Object.entries(PRICES).map(([model, prices]) => [model, prices.map(Number)]),
    );
    expect(here).toEqual(python);
  });
});

describe("costUsd", () => {
  it.each(VECTORS as Record<string, any>[])("equals the shared vector: $name", (vector) => {
    expect(costUsd(vector.model, vector.usage)).toBe(vector.cost_usd);
  });

  it("warns once for an unknown model and costs it as the most expensive known price", () => {
    const warn = vi.fn();
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    expect(costUsd("claude-mystery-9", usage, warn)).toBe(costUsd("claude-opus-5", usage));
    expect(warn).toHaveBeenCalledTimes(1);
    costUsd("claude-sonnet-5-5", usage, warn);
    costUsd("claude-sonnet-5-5-20261001", usage, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("counts a missing or null field as 0", () => {
    expect(costUsd("claude-opus-5-5", {})).toBe("0.0000");
    expect(costUsd("claude-opus-5-5", { input_tokens: null, cache_read_input_tokens: null })).toBe(
      "0.0000",
    );
  });

  it("makes no float error on a large count", () => {
    expect(costUsd("claude-opus-5", { output_tokens: 999_999_999 })).toBe("25000.0000");
  });
});

describe("servedModel", () => {
  it.each([
    ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"],
    [undefined, "claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["GPT 9; drop table", "claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["bad", "also bad", "claude-unknown"],
    ["claude-sonnet-5-5-20261001", "claude-sonnet-5-5", "claude-sonnet-5-5-20261001"],
  ])("served %j requested %j is recorded as %j", (served, requested, wanted) => {
    expect(servedModel(served, requested)).toBe(wanted);
  });
});

describe("parseBudget (FINOS_AI_BUDGET_USD)", () => {
  it("defaults to 100 and keeps the text of a good value", () => {
    expect(parseBudget(undefined)).toBe("100");
    expect(parseBudget(" 250.50 ")).toBe("250.50");
  });

  it.each(["0", "0.00", "-5", "abc", "1e3", "", "1,000", "100 USD", "1234567"])(
    "refuses %j as a start error",
    (value) => {
      expect(() => parseBudget(value)).toThrow(StartError);
      expect(() => parseBudget(value)).toThrow("FINOS_AI_BUDGET_USD");
    },
  );
});

describe("checkBudget", () => {
  const spent = (value: string): Db => ({
    read: vi.fn(async () => [[{ spent: value }]]),
    insertUsage: vi.fn(),
  });

  it("returns what has been spent while it is below the limit", async () => {
    expect(await checkBudget(spent("99.9999"), "100")).toBe("99.9999");
    expect(await checkBudget(spent("0"), "100")).toBe("0");
  });

  it("reads v_ai_spend for this month, as ai.spent_this_month does", async () => {
    const db = spent("1");
    await checkBudget(db, "100");
    const text = (db.read as ReturnType<typeof vi.fn>).mock.calls[0]![0][0].text as string;
    expect(text).toBe(
      "select coalesce(sum(cost_usd), 0) as spent from v_ai_spend " +
        "where month = date_trunc('month', now())::date",
    );
  });

  it.each([["100.0000", "100"], ["100.0001", "100"], ["250.50", "250.5"]])(
    "refuses at spent %s of limit %s, with the text of ai.check_budget",
    async (value, limit) => {
      const error = await checkBudget(spent(value), limit).catch((e) => e);
      expect(error).toBeInstanceOf(BudgetExceeded);
      expect(error.message).toBe(
        `AI spend this month is $${value}, at the FINOS_AI_BUDGET_USD limit of $${limit}. ` +
          "Raise the limit or wait for next month.",
      );
    },
  );

  it("fails closed: a database error refuses too, without the database's text", async () => {
    const db: Db = {
      read: async () => {
        throw new DbError("57014");
      },
      insertUsage: vi.fn(),
    };
    const error = await checkBudget(db, "100").catch((e) => e);
    expect(error).toBeInstanceOf(BudgetCheckError);
    expect(error.message).not.toContain("57014");
  });

  it("fails closed on an answer that is not a number", async () => {
    await expect(checkBudget(spent("lots"), "100")).rejects.toBeInstanceOf(BudgetCheckError);
  });
});

describe("UsageAccumulator", () => {
  const start = (usage: object, model = "claude-sonnet-5-5") =>
    ({ type: "message_start", message: { model, usage } }) as never;
  const delta = (usage: object) => ({ type: "message_delta", delta: {}, usage }) as never;
  const stop = { type: "message_stop" } as never;

  it("takes the latest value of each field: message_delta replaces message_start", () => {
    const acc = new UsageAccumulator(4096);
    acc.see(start({ input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }));
    acc.see(delta({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null }));
    acc.see(stop);
    expect(acc.complete).toBe(true);
    expect(acc.usage()).toEqual({
      input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
    });
  });

  it("never adds the two events of one field", () => {
    const acc = new UsageAccumulator(4096);
    acc.see(start({ input_tokens: 700, output_tokens: 2 }));
    acc.see(delta({ input_tokens: 700, output_tokens: 300 }));
    acc.see(stop);
    expect(acc.usage().input_tokens).toBe(700);
    expect(acc.usage().output_tokens).toBe(300);
  });

  it("records max_tokens as the output of a call that ends without message_stop", () => {
    const acc = new UsageAccumulator(4096);
    acc.see(start({ input_tokens: 700, output_tokens: 2 }));
    expect(acc.started).toBe(true);
    expect(acc.complete).toBe(false);
    expect(acc.usage()).toMatchObject({ input_tokens: 700, output_tokens: 4096 });
  });

  it("keeps a larger count seen than max_tokens, and reports the served model", () => {
    const acc = new UsageAccumulator(100);
    acc.see(start({ input_tokens: 1, output_tokens: 150 }, "claude-sonnet-5-5-20261001"));
    expect(acc.usage().output_tokens).toBe(150);
    expect(acc.model).toBe("claude-sonnet-5-5-20261001");
  });

  it("has not started before message_start, and ignores a malformed event", () => {
    const acc = new UsageAccumulator(4096);
    acc.see({ type: "content_block_stop", index: 0 } as never);
    acc.see(delta({ output_tokens: "many" }));
    expect(acc.started).toBe(false);
  });
});

describe.skipIf(!pgAdmin)(`insertUsage (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());

  it("sends one parameterised insert, without RETURNING, that works as finos_ui_access", async () => {
    const db = createDb({ url: URL_, fetchFunction: neon.fetchFunction });
    const before = await database.owner.query("select count(*)::int as n from ai_usage");
    await db.insertUsage({
      model: "claude-sonnet-5-5",
      input_tokens: 1000, output_tokens: 200, cache_read_tokens: 30, cache_write_tokens: 40,
      cost_usd: "0.0040",
    });
    const sent = neon.requests.at(-1)!;
    const body = sent.body as { query: string; params: unknown[] };
    expect(sent.headers.get("neon-batch-read-only")).toBeNull();
    expect(body.query.toLowerCase()).toContain("insert into ai_usage");
    expect(body.query.toLowerCase()).not.toContain("returning");
    expect(body.query).not.toContain("claude-sonnet-5-5");
    expect(body.params.map(String)).toEqual(["chat", "claude-sonnet-5-5", "1000", "200", "30", "40", "0.0040"]);
    const after = await database.owner.query(
      "select purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd::text " +
        "from ai_usage order by id desc limit 1",
    );
    expect(after.rows[0]).toEqual({
      purpose: "chat", model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 200,
      cache_read_tokens: 30, cache_write_tokens: 40, cost_usd: "0.0040",
    });
    expect((await database.owner.query("select count(*)::int as n from ai_usage")).rows[0].n).toBe(
      before.rows[0].n + 1,
    );
  });

  it("refuses a model that is not a plain model ID (the 0009 check), as a DbError", async () => {
    const db = createDb({ url: URL_, fetchFunction: neon.fetchFunction });
    await expect(
      db.insertUsage({
        model: "gpt; drop", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
        cache_write_tokens: 0, cost_usd: "0.0001",
      }),
    ).rejects.toBeInstanceOf(DbError);
  });
});
