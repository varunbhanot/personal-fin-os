// E2.2: the seven tools over the golden seed, on the Postgres emulator as the UI role. The tools
// are typed functions over record.ts; the model never writes SQL, and no text from a statement,
// a categorisation or the household reaches a result (S1, S2).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { UNLISTED, createRecord } from "../src/record.js";
import { Secret } from "../src/secret.js";
import { add, divide } from "../src/decimal.js";
import { TOOL_NAMES, createTools } from "../src/tools.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8"),
);
const SOURCE = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");
const PLANTED = /ZQX|zqx/i;
const KINDS = ["income", "expense", "investment", "transfer"];

describe("the tool list", () => {
  it("has the ten tools, each with a JSON Schema that is an object", () => {
    const tools = createTools({} as never);
    expect(TOOL_NAMES).toEqual([
      "show_kpis", "show_chart", "show_table", "show_category_breakdown", "get_health", "get_rows",
      "get_stats", "get_top", "compare_periods", "find_suspects",
    ]);
    expect(tools.definitions.map((d) => d.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools.definitions) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.input_schema.type, tool.name).toBe("object");
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
      expect(tool.input_schema, tool.name).not.toHaveProperty("$schema");
      expect(JSON.parse(JSON.stringify(tool.input_schema))).toEqual(tool.input_schema);
    }
    const kpis = tools.definitions[0]!.input_schema;
    expect(kpis.required).toEqual(expect.arrayContaining(["month", "metrics"]));
    expect(Object.keys(kpis.properties as object)).toEqual(
      expect.arrayContaining(["month", "spread", "metrics", "title"]),
    );
  });

  it("offers the packaged categories, and no other, to the chart", () => {
    const chart = createTools({} as never).definitions[1]!.input_schema as any;
    expect(chart.properties.category.enum).toContain("Groceries");
    expect(chart.properties.category.enum).not.toContain(UNLISTED);
  });
});

describe.skipIf(!pgAdmin)(`the tools (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());
  const record = () => createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction }));
  const tools = () => createTools(record());
  const call = async (name: string, input: unknown) => {
    const out = await tools().run(name, input);
    return { ...out, data: JSON.parse(out.content) };
  };

  describe("input", () => {
    const refused: [string, string, unknown][] = [
      ["an unknown field", "show_kpis", { month: "2026-09", metrics: ["income"], extra: 1 }],
      ["a month without a dash", "show_kpis", { month: "202609", metrics: ["income"] }],
      ["a month of 100 characters", "show_kpis", { month: "2026-09".padEnd(100, "9"), metrics: ["income"] }],
      ["an unknown metric", "show_kpis", { month: "2026-09", metrics: ["profit"] }],
      ["no metric", "show_kpis", { month: "2026-09", metrics: [] }],
      ["five metrics", "show_kpis", { month: "2026-09", metrics: ["income", "expenses", "savings", "investments", "income"] }],
      ["a title of 81 characters", "show_kpis", { month: "2026-09", metrics: ["income"], title: "t".repeat(81) }],
      ["a title with a control character", "show_kpis", { month: "2026-09", metrics: ["income"], title: "a\u0000b" }],
      ["an unknown chart kind", "show_chart", { kind: "pie", series: ["income"], from_month: "2026-08", to_month: "2026-09" }],
      ["an unknown category", "show_chart", { kind: "bar", category: "Nonsense", from_month: "2026-08", to_month: "2026-09" }],
      ["the unlisted category", "show_chart", { kind: "bar", category: UNLISTED, from_month: "2026-08", to_month: "2026-09" }],
      ["series and category together", "show_chart", { kind: "bar", series: ["income"], category: "Groceries", from_month: "2026-08", to_month: "2026-09" }],
      ["neither series nor category", "show_chart", { kind: "bar", from_month: "2026-08", to_month: "2026-09" }],
      ["an unknown table source", "show_table", { source: "transactions" }],
      ["a table limit of 51", "show_table", { source: "rows", limit: 51 }],
      ["an argument of another table source", "show_table", { source: "months", month: "2026-09" }],
      ["a profile of 41 characters", "show_table", { source: "rows", profile: "a".repeat(41) }],
      ["an unknown category in a table", "show_table", { source: "rows", category: "Nonsense" }],
      ["compare that is not a boolean", "show_category_breakdown", { month: "2026-09", compare: "yes" }],
      ["an argument for get_health", "get_health", { month: "2026-09" }],
      ["a get_rows limit of 51", "get_rows", { limit: 51 }],
      ["a get_rows limit of 0", "get_rows", { limit: 0 }],
      ["a get_rows source with a space", "get_rows", { source: "Bad Profile", limit: 5 }],
      ["a get_rows amount that is text", "get_rows", { min_amount: "lots", limit: 5 }],
      ["an unknown get_rows category", "get_rows", { category: "Nonsense", limit: 5 }],
      ["a string, not an object", "get_rows", "limit 5"],
      ["null", "get_rows", null],
    ];
    it.each(refused)("refuses %s with is_error and a plain text, not an exception", async (_, name, input) => {
      const out = await call(name, input);
      expect(out.is_error).toBe(true);
      expect(Object.keys(out.data)).toEqual(["error"]);
      expect(typeof out.data.error).toBe("string");
      expect(out.data.error.length).toBeLessThanOrEqual(300);
    });

    it("refuses a month the calendar does not have (parseMonth), and a month the record lacks", async () => {
      const bad = await call("show_kpis", { month: "2026-13", metrics: ["income"] });
      expect(bad.is_error).toBe(true);
      expect(bad.data.error).toContain("YYYY-MM");
      const missing = await call("show_kpis", { month: "2020-01", metrics: ["income"] });
      expect(missing.is_error).toBe(true);
      expect(missing.data.error).toBe("No statement covers that month.");
    });

    it("refuses a chart whose range is backwards or longer than 24 months", async () => {
      const backwards = await call("show_chart", { kind: "bar", series: ["income"], from_month: "2026-09", to_month: "2026-08" });
      expect(backwards.is_error).toBe(true);
      const long = await call("show_chart", { kind: "bar", series: ["income"], from_month: "2020-01", to_month: "2026-09" });
      expect(long.is_error).toBe(true);
    });

    it("refuses an unknown tool name", async () => {
      const out = await call("drop_tables", {});
      expect(out.is_error).toBe(true);
      expect(out.data.error).toBe("There is no tool with that name.");
    });

    it("gives a fixed text, not the database's, when the record cannot be read", async () => {
      const failing = createTools({
        month: async () => {
          throw new Error("connection string postgresql://finos_ui:SECRET@host");
        },
      } as never);
      const out = await failing.run("show_kpis", { month: "2026-09", metrics: ["income"] });
      expect(out.is_error).toBe(true);
      expect(out.content).toBe('{"error":"The record could not be read. Try again."}');
    });
  });

  describe("results equal the figures of record.ts (the same numbers as /api)", () => {
    it("get_stats agrees with the months table over the golden record", async () => {
      const months = (await call("show_table", { source: "months", last: 24 })).data;
      const rows = (months.rows as [string, boolean, string, string, string, string][])
        .filter(([m]) => m >= "2026-08" && m <= "2026-09");
      expect(rows.length).toBeGreaterThan(0);
      const stats = (await call("get_stats", { metric: "expenses", from_month: "2026-08", to_month: "2026-09", complete_only: false })).data;
      expect(stats.months_used).toEqual(rows.map(([m]) => m));
      expect(stats.total).toBe(divide(rows.reduce((t, r) => add(t, r[3]), "0"), 1));
      expect(stats.average).toBe(divide(stats.total, rows.length));
      const strict = (await call("get_stats", { metric: "expenses", from_month: "2026-08", to_month: "2026-09" })).data;
      expect(strict.months_used).toEqual(rows.filter((r) => r[1]).map(([m]) => m));
      expect(strict.months_skipped).toEqual(rows.filter((r) => !r[1]).map(([m]) => m));
    });

    it("show_kpis: the tiles, the change from the month before, complete or partial", async () => {
      const out = await call("show_kpis", { month: "2026-09", spread: false, metrics: ["income", "savings"], title: "September" });
      const wanted = EXPECTED.month.cash["2026-09"];
      expect(out.is_error).toBe(false);
      expect(out.data).toEqual({
        component: "kpis", title: "September", month: "2026-09", spread: false,
        complete: wanted.complete, previous_month: "2026-08",
        tiles: [
          { metric: "income", ...wanted.kpis.income },
          { metric: "savings", ...wanted.kpis.savings },
        ],
      });
    });

    it("show_kpis in spread mode reads the spread view", async () => {
      const out = await call("show_kpis", { month: "2026-09", spread: true, metrics: ["expenses"] });
      expect(out.data.tiles[0]).toEqual({ metric: "expenses", ...EXPECTED.month.spread["2026-09"].kpis.expenses });
      expect(out.data.spread).toBe(true);
      expect(out.data.title).toEqual(expect.any(String));
    });

    it("show_chart with metrics: x, y points oldest first, with the partial marks", async () => {
      const out = await call("show_chart", {
        kind: "line", series: ["income", "expenses"], from_month: "2026-08", to_month: "2026-09", spread: false,
      });
      const months = EXPECTED.months.cash;
      expect(out.data).toMatchObject({ component: "chart", chart: "line", spread: false });
      expect(out.data.series).toEqual([
        { name: "income", points: months.map((m: any) => ({ x: m.month.slice(0, 7), y: m.income, complete: m.complete })) },
        { name: "expenses", points: months.map((m: any) => ({ x: m.month.slice(0, 7), y: m.expenses, complete: m.complete })) },
      ]);
    });

    it("show_chart with metrics keeps only the months of the range", async () => {
      const out = await call("show_chart", { kind: "bar", series: ["income"], from_month: "2026-09", to_month: "2026-09" });
      expect(out.data.series[0].points.map((p: any) => p.x)).toEqual(["2026-09"]);
    });

    it("show_chart with a category: the net of that category for each month, 0 when it has none", async () => {
      const out = await call("show_chart", { kind: "bar", category: "Groceries", from_month: "2026-08", to_month: "2026-09" });
      const groceries = EXPECTED.month.cash["2026-09"].categories.find((c: any) => c.category === "Groceries");
      expect(out.data.series).toEqual([
        { name: "Groceries", points: [
          { x: "2026-08", y: "0", complete: false },
          { x: "2026-09", y: groceries.net, complete: false },
        ] },
      ]);
    });

    it("show_table months", async () => {
      const out = await call("show_table", { source: "months", last: 2 });
      expect(out.data.component).toBe("table");
      expect(out.data.columns).toEqual(["month", "complete", "income", "expenses", "savings", "investments"]);
      expect(out.data.rows).toEqual(
        EXPECTED.months.cash.map((m: any) => [m.month.slice(0, 7), m.complete, m.income, m.expenses, m.savings, m.investments]),
      );
      expect(out.data.total).toBe(2);
    });

    it("show_table month_categories", async () => {
      const out = await call("show_table", { source: "month_categories", month: "2026-09" });
      const lines = EXPECTED.month.cash["2026-09"].categories;
      expect(out.data.columns).toEqual(["kind", "category", "rows", "net", "previous", "change", "pct"]);
      expect(out.data.rows).toEqual(lines.map((l: any) => [l.kind, l.category, l.rows, l.net, l.previous, l.change, l.pct]));
    });

    it("show_table rows, with the count of all that match", async () => {
      const out = await call("show_table", { source: "rows", month: "2026-09", limit: 3 });
      const r = await record().rows({ month: "2026-09", limit: 3 });
      expect(out.data.columns).toEqual(["row_id", "date", "source", "account", "amount", "direction", "category", "kind"]);
      expect(out.data.rows).toEqual(
        r.rows.map((x) => [x.row_id, x.txn_date, x.source, x.account_last4, x.amount, x.direction, x.category, x.kind]),
      );
      expect(out.data.rows).toHaveLength(3);
      expect(out.data.total).toBe(r.total);
      expect(r.total).toBeGreaterThan(3);
    });

    it("show_table rows filtered by profile and minimum amount", async () => {
      const out = await call("show_table", { source: "rows", profile: "axis-bank", min_amount: "100000", limit: 10 });
      const r = await record().rows({ source: "axis-bank", min_amount: "100000", limit: 10 });
      expect(out.data.total).toBe(r.total);
      expect(out.data.rows.length).toBe(r.rows.length);
      expect(out.data.rows.length).toBeGreaterThan(0);
    });

    it("show_table spreads and coverage", async () => {
      const spreads = await call("show_table", { source: "spreads" });
      expect(spreads.data.columns).toEqual(["spread_id", "row_id", "date", "source", "account", "direction", "amount", "start_month", "months"]);
      expect(spreads.data.rows).toEqual(
        EXPECTED.spreads.spreads.map((s: any) => [s.spread_id, s.row_id, s.txn_date, s.source, s.account_last4, s.direction, s.amount, s.start_month, s.months]),
      );
      const cover = await call("show_table", { source: "coverage", month: "2026-09" });
      expect(cover.data.columns).toEqual(["month", "source", "account", "days_covered", "days_in_month"]);
      expect(cover.data.rows).toEqual(
        EXPECTED.health.coverage.filter((c: any) => c.month === "2026-09-01").map((c: any) => [c.month.slice(0, 7), c.source, c.account_last4, c.days_covered, c.days_in_month]),
      );
      const all = await call("show_table", { source: "coverage" });
      expect(all.data.rows).toHaveLength(EXPECTED.health.coverage.length);
    });

    it("show_table goals reads the safe view and labels each goal 'Goal <id>'", async () => {
      const out = await call("show_table", { source: "goals" });
      const goal = EXPECTED.goals[0];
      expect(out.data.columns).toEqual(["goal", "budget", "spent", "spent_to_date", "remaining"]);
      expect(out.data.rows).toEqual([[`Goal ${goal.goal_id}`, goal.budget, goal.spent, goal.spent_to_date, goal.remaining]]);
      expect(out.content).not.toContain("Hill Trip");
    });

    it("show_category_breakdown with and without the comparison", async () => {
      const lines = EXPECTED.month.cash["2026-09"].categories;
      const compared = await call("show_category_breakdown", { month: "2026-09", spread: false, compare: true });
      expect(compared.data).toMatchObject({
        component: "category_breakdown", month: "2026-09", previous_month: "2026-08", compare: true,
        spread: false, complete: false,
      });
      expect(compared.data.categories).toEqual(
        lines.map((l: any) => ({ kind: l.kind, category: l.category, net: l.net, previous: l.previous, change: l.change, pct: l.pct })),
      );
      const plain = await call("show_category_breakdown", { month: "2026-09", spread: false, compare: false });
      expect(plain.data.categories).toEqual(
        lines.map((l: any) => ({ kind: l.kind, category: l.category, net: l.net, previous: null, change: null, pct: null })),
      );
    });

    it("get_health is the /api/health figures", async () => {
      const out = await call("get_health", {});
      expect(out.data).toEqual({ component: "read", ...EXPECTED.health });
    });

    it("get_rows is v_ui_rows with the total", async () => {
      const out = await call("get_rows", { month: "2026-09", category: "Groceries", limit: 5 });
      const r = await record().rows({ month: "2026-09", category: "Groceries", limit: 5 });
      expect(out.data).toEqual({ component: "read", total: r.total, rows: r.rows });
      expect(r.total).toBeGreaterThan(0);
    });
  });

  describe("guard: nothing from a statement, a reason, a handle, a note or a goal reaches a result", () => {
    const argSets: [string, unknown][] = [
      ["show_kpis", { month: "2026-09", metrics: ["income", "expenses", "savings", "investments"] }],
      ["show_kpis", { month: "2026-08", spread: true, metrics: ["expenses"], title: "A title" }],
      ["show_chart", { kind: "bar", series: ["income", "expenses", "savings", "investments"], from_month: "2026-08", to_month: "2026-09" }],
      ["show_chart", { kind: "line", category: "Rent", from_month: "2026-08", to_month: "2026-09", spread: true }],
      ["show_table", { source: "months" }], ["show_table", { source: "month_categories", month: "2026-09" }],
      ["show_table", { source: "month_categories", month: "2026-09", spread: true }],
      ["show_table", { source: "rows", limit: 50 }], ["show_table", { source: "rows", category: UNLISTED, limit: 50 }],
      ["show_table", { source: "goals" }], ["show_table", { source: "spreads" }], ["show_table", { source: "coverage" }],
      ["show_category_breakdown", { month: "2026-09", compare: true }],
      ["show_category_breakdown", { month: "2026-09", spread: true, compare: false }],
      ["get_health", {}], ["get_rows", { limit: 50 }], ["get_rows", { category: UNLISTED, limit: 50 }],
      ["get_rows", { source: "sbi-bank", limit: 50 }],
      ["get_rows", { from_month: "2026-08", to_month: "2026-09", sort: "amount", limit: 50 }],
      ["show_table", { source: "rows", from_month: "2026-08", to_month: "2026-09", sort: "amount", limit: 50 }],
      ["get_top", { by: "categories", from_month: "2026-08", to_month: "2026-09", limit: 20 }],
      ["get_top", { by: "categories", kind: "income", spread: true, from_month: "2026-08", to_month: "2026-09" }],
      ["get_top", { by: "rows", from_month: "2026-08", to_month: "2026-09", limit: 20 }],
      ["compare_periods", { metric: "expenses", a_from: "2026-08", a_to: "2026-08", b_from: "2026-09", b_to: "2026-09", complete_only: false }],
      ["compare_periods", { category: "Rent", a_from: "2026-08", a_to: "2026-08", b_from: "2026-09", b_to: "2026-09", spread: true }],
      ["find_suspects", {}], ["find_suspects", { min_amount: "0", limit: 50 }],
    ];

    function walk(value: unknown, visit: (key: string, value: unknown) => void) {
      if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          visit(k, v);
          walk(v, visit);
        }
      }
    }

    it("holds for every tool over the seed, with several argument sets", async () => {
      let sawUnlisted = false;
      for (const [name, input] of argSets) {
        const out = await call(name, input);
        expect(out.is_error, `${name} ${JSON.stringify(input)}`).toBe(false);
        expect(out.content, name).not.toMatch(PLANTED);
        if (out.content.includes(UNLISTED)) sawUnlisted = true;
        walk(out.data, (key, value) => {
          if (key === "row_id") expect(value).toMatch(/^[0-9a-f]{8}$/);
          if (key === "kind" && value !== null) expect(KINDS).toContain(value);
          if (key === "what") expect(["spread", "goal"]).toContain(value);
          if (key === "status") expect(["ok", "flagged"]).toContain(value);
          if (key === "purpose") expect(["extract", "categorise", "eval-extract", "eval-categorise", "chat", "other"]).toContain(value);
          if (key === "model") expect(String(value)).toMatch(/^claude-[a-z0-9-]{1,60}$|^unknown$/);
          if (key === "source") expect(String(value)).toMatch(/^[a-z0-9-]{1,40}$/);
          if (key === "category" && value !== null && typeof value === "string") {
            expect(value === UNLISTED || /^[A-Za-z&, ]+$/.test(value), value).toBe(true);
          }
        });
      }
      // The instruction-like category of the seed shows only under its fixed name.
      expect(sawUnlisted).toBe(true);
    });

    it("never carries the planted goal name, though the browser's /api/goals does", async () => {
      expect(JSON.stringify(await record().goals())).toContain("ZQX Goal Hill Trip");
      for (const [name, input] of argSets) {
        expect((await call(name, input)).content).not.toContain("ZQX Goal Hill Trip");
      }
    });
  });
});

describe("the size of a result", () => {
  const months = (n: number) =>
    Array.from({ length: n }, (_, i) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`);
  const grid = (list: string[], accounts = 5) =>
    list.flatMap((month) => Array.from({ length: accounts }, (_, a) => ({
      month, source: `bank-${a}`, account_last4: "1111", days_covered: 30, days_in_month: 30,
    })));

  it("gives get_health the coverage of the last 12 months only", async () => {
    const list = months(30);
    const record = { health: async () => ({ ...EXPECTED.health, coverage: grid(list) }) };

    const out = await createTools(record as never).run("get_health", {});

    expect(out.is_error).toBe(false);
    const shown = JSON.parse(out.content).coverage.map((c: { month: string }) => c.month);
    expect([...new Set(shown)]).toEqual(list.slice(-12));
  });

  it("refuses a result over 32,000 characters with a plain reason", async () => {
    // 12 months of 120 accounts: far more than any household has.
    const record = { health: async () => ({ ...EXPECTED.health, coverage: grid(months(12), 120) }) };

    const out = await createTools(record as never).run("get_health", {});

    expect(out).toEqual({
      is_error: true,
      content: JSON.stringify({ error: "The result is too large for the chat. Ask for fewer months or rows." }),
    });
  });
});

describe("tools.ts source", () => {
  it("never names v_goal_progress or the goal's name column", () => {
    expect(SOURCE).not.toContain("v_goal_progress");
    expect(SOURCE).not.toContain("g.name");
  });

  it("holds no SQL: no database import and no select next to a template literal or a +", () => {
    expect(SOURCE).not.toMatch(/from "\.\/db\.js"/);
    expect(SOURCE).not.toMatch(/`[^`]*\bselect\b/i);
    expect(SOURCE).not.toMatch(/\bselect\b[^\n]*\+|\+[^\n]*\bselect\b/i);
    expect(SOURCE).not.toMatch(/\bfrom\s+v_/i);
  });
});
