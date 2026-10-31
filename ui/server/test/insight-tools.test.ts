// The insight tools (get_top, compare_periods, find_suspects) and the range and sort of the row
// tools: what the chat needs to answer ordinary questions ("what did I spend most on", "was
// this quarter worse than the last", "why is this month so high") without doing arithmetic.
// Stub-record tests for the logic, then the SQL of record.ts over the golden seed on the
// Postgres emulator, with planted rows for the suspects.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { pct } from "../src/decimal.js";
import { RecordInputError, UNLISTED, createRecord } from "../src/record.js";
import { Secret } from "../src/secret.js";
import { type ToolRecord, createTools } from "../src/tools.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8"),
);
const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");
const PLANTED = /ZQX|zqx/i;
const SUSPECT_COLUMNS = ["row_id", "date", "source", "account", "amount", "direction", "category", "kind", "reason"];

// --- stub record ----------------------------------------------------------------------------

type Month = { month: string; complete: boolean; income: string; expenses: string; savings: string; investments: string };
const m = (month: string, complete: boolean, expenses: string): Month => ({
  month: `${month}-01`, complete, income: "1000.00", expenses, savings: "0.00", investments: "0.00",
});
const MONTHS: Month[] = [
  m("2026-01", true, "300.00"), m("2026-02", true, "100.00"), m("2026-03", true, "200.00"),
  m("2026-04", true, "100.00"), m("2026-05", true, "400.00"), m("2026-06", false, "50.00"),
];
const ROW = {
  row_id: "0123abcd", txn_date: "2026-03-04", month: "2026-03-01", source: "axis-bank", account_last4: "",
  amount: "1000000.00", direction: "debit", category: "Other", linked: false, kind: "expense",
  refund: false, value: "1000000.00", needs_review: false,
};

function stub(): ToolRecord & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async months(args: unknown) {
      calls.push(["months", args]);
      return MONTHS as never;
    },
    async categorySeries(args: { first: string; last: string }) {
      calls.push(["categorySeries", args]);
      return [
        { month: "2026-01-01", complete: true, net: "50.00" },
        { month: "2026-02-01", complete: true, net: "10.00" },
        { month: "2026-03-01", complete: true, net: "70.00" },
      ].filter((p) => p.month >= args.first && p.month <= args.last);
    },
    async topCategories(args: unknown) {
      calls.push(["topCategories", args]);
      return [
        { category: "Other", rows: 1, net: "1000000.00" },
        { category: "Rent", rows: 3, net: "120000.00" },
        { category: "Groceries", rows: 40, net: "30000.50" },
        { category: "Family & gifts", rows: 1, net: "-500.00" },
      ];
    },
    async topRows(args: unknown) {
      calls.push(["topRows", args]);
      return { total: 7, rows: [ROW] };
    },
    async suspects(args: unknown) {
      calls.push(["suspects", args]);
      return { total: 1, rows: [{ ...ROW, reason: "other_or_unknown" }] };
    },
    async rows(args: unknown) {
      calls.push(["rows", args]);
      return { total: 1, rows: [ROW] };
    },
  } as never;
}

async function run(name: string, input: unknown, record = stub()) {
  const out = await createTools(record).run(name, input);
  return { ...out, data: JSON.parse(out.content) };
}

describe("get_top (stub)", () => {
  it("lists the top categories of a kind with their share of the kind's total, and an All row", async () => {
    const record = stub();
    const { is_error, data } = await run("get_top", { by: "categories", from_month: "2026-01", to_month: "2026-03", limit: 2 }, record);
    expect(is_error).toBe(false);
    expect(record.calls).toEqual([
      ["months", { spread: false, last: 60 }],
      ["topCategories", { spread: false, kind: "expense", first: "2026-01-01", last: "2026-03-01" }],
    ]);
    const all = "1149500.50";
    expect(data).toEqual({
      component: "table", title: "Top expense categories, 2026-01 to 2026-03",
      columns: ["category", "rows", "total", "share_pct"],
      rows: [
        ["Other", 1, "1000000.00", pct("1000000.00", all)],
        ["Rent", 3, "120000.00", pct("120000.00", all)],
        ["All", 45, all, "100.0"],
      ],
      // 4 categories and the All row: the web shows "Showing 3 of 5 rows".
      total: 5,
      partial_months: [],
    });
    expect(data.rows[0][3]).toBe("87.0");
  });

  it("counts the All row in total, so one cut category still shows in the total", async () => {
    // 4 categories with limit 3 (lines = limit + 1): 3 categories and All are shown.
    const { data } = await run("get_top", { by: "categories", from_month: "2026-01", to_month: "2026-03", limit: 3 });
    expect(data.rows).toHaveLength(4);
    expect(data.total).toBe(5);
  });

  it("names the partial months it counts, in the result and the default title", async () => {
    const { data } = await run("get_top", { by: "categories", from_month: "2026-04", to_month: "2026-06" });
    expect(data.partial_months).toEqual(["2026-06"]);
    expect(data.title).toBe("Top expense categories, 2026-04 to 2026-06 (1 partial month)");
  });

  it("passes kind and spread on, and takes the model's title", async () => {
    const record = stub();
    const { data } = await run("get_top", {
      by: "categories", kind: "income", spread: true, from_month: "2026-01", to_month: "2026-01", title: "Income",
    }, record);
    expect(record.calls).toEqual([
      ["months", { spread: true, last: 60 }],
      ["topCategories", { spread: true, kind: "income", first: "2026-01-01", last: "2026-01-01" }],
    ]);
    expect(data.title).toBe("Income");
  });

  it("gives no share when the kind's total is 0", async () => {
    const record = { ...stub(), topCategories: async () => [{ category: "Rent", rows: 1, net: "0" }] } as never;
    const { data } = await run("get_top", { by: "categories", from_month: "2026-01", to_month: "2026-01" }, record);
    expect(data.rows).toEqual([["Rent", 1, "0", null], ["All", 1, "0", null]]);
  });

  it("lists the largest rows of a kind", async () => {
    const record = stub();
    const { data } = await run("get_top", { by: "rows", kind: "expense", from_month: "2026-01", to_month: "2026-03", limit: 5 }, record);
    expect(record.calls).toEqual([["topRows", { kind: "expense", first: "2026-01-01", last: "2026-03-01", limit: 5 }]]);
    expect(data).toEqual({
      component: "table", title: "Largest expense rows, 2026-01 to 2026-03",
      columns: ["row_id", "date", "source", "account", "amount", "direction", "category"],
      rows: [["0123abcd", "2026-03-04", "axis-bank", "", "1000000.00", "debit", "Other"]],
      total: 7,
    });
  });

  it.each([
    ["no by", { from_month: "2026-01", to_month: "2026-02" }],
    ["an unknown by", { by: "payees", from_month: "2026-01", to_month: "2026-02" }],
    ["the kind transfer", { by: "rows", kind: "transfer", from_month: "2026-01", to_month: "2026-02" }],
    ["a limit of 21", { by: "rows", limit: 21, from_month: "2026-01", to_month: "2026-02" }],
    ["a limit of 0", { by: "rows", limit: 0, from_month: "2026-01", to_month: "2026-02" }],
    ["no range", { by: "rows" }],
    ["an extra key", { by: "rows", from_month: "2026-01", to_month: "2026-02", month: "2026-01" }],
  ])("refuses %s as bad input", async (_name, input) => {
    const out = await run("get_top", input);
    expect(out.is_error).toBe(true);
    expect(out.data.error).toMatch(/^The input is not valid\./);
  });

  it("refuses a reversed range, more than 24 months, and spread for rows, with fixed texts", async () => {
    expect((await run("get_top", { by: "rows", from_month: "2026-03", to_month: "2026-01" })).data.error)
      .toBe("from_month must not be after to_month.");
    expect((await run("get_top", { by: "categories", from_month: "2024-01", to_month: "2026-01" })).data.error)
      .toBe("A range covers at most 24 months.");
    expect((await run("get_top", { by: "rows", spread: true, from_month: "2026-01", to_month: "2026-02" })).data.error)
      .toBe("spread applies to by categories only; rows count in the month they were paid.");
  });
});

describe("compare_periods (stub)", () => {
  it("compares two periods of a metric: totals, averages and the change of the average", async () => {
    const { is_error, data } = await run("compare_periods", {
      metric: "expenses", a_from: "2026-01", a_to: "2026-02", b_from: "2026-03", b_to: "2026-06",
    });
    expect(is_error).toBe(false);
    // A: 300 + 100 = 400 over 2 months. B: 200 + 100 + 400 over 3 complete months; 2026-06 is partial.
    expect(data).toEqual({
      component: "table", title: "Expenses: 2026-01 to 2026-02 against 2026-03 to 2026-06",
      columns: ["period", "from", "to", "months_used", "months_skipped", "total", "average", "pct_change"],
      rows: [
        ["A", "2026-01", "2026-02", 2, 0, "400.00", "200.00", null],
        ["B", "2026-03", "2026-06", 3, 1, "700.00", "233.33", null],
        ["B minus A", null, null, null, null, "300.00", "33.33", "16.7"],
      ],
      total: 3,
    });
  });

  it("counts partial months when complete_only is false, and works on a category", async () => {
    const all = await run("compare_periods", {
      metric: "expenses", complete_only: false, a_from: "2026-05", a_to: "2026-05", b_from: "2026-06", b_to: "2026-06",
    });
    expect(all.data.rows).toEqual([
      ["A", "2026-05", "2026-05", 1, 0, "400.00", "400.00", null],
      ["B", "2026-06", "2026-06", 1, 0, "50.00", "50.00", null],
      ["B minus A", null, null, null, null, "-350.00", "-350.00", "-87.5"],
    ]);
    const record = stub();
    const groceries = await run("compare_periods", {
      category: "Groceries", spread: true, a_from: "2026-01", a_to: "2026-01", b_from: "2026-02", b_to: "2026-03",
    }, record);
    expect(record.calls).toEqual([
      ["categorySeries", { spread: true, category: "Groceries", first: "2026-01-01", last: "2026-01-01" }],
      ["categorySeries", { spread: true, category: "Groceries", first: "2026-02-01", last: "2026-03-01" }],
    ]);
    expect(groceries.data.title).toBe("Groceries: 2026-01 to 2026-01 against 2026-02 to 2026-03");
    expect(groceries.data.rows[2]).toEqual(["B minus A", null, null, null, null, "30.00", "-10.00", "-20.0"]);
  });

  it("gives null figures for a period without a usable month", async () => {
    const { data } = await run("compare_periods", {
      metric: "expenses", a_from: "2026-06", a_to: "2026-06", b_from: "2026-05", b_to: "2026-05",
    });
    expect(data.rows).toEqual([
      ["A", "2026-06", "2026-06", 0, 1, null, null, null],
      ["B", "2026-05", "2026-05", 1, 0, "400.00", "400.00", null],
      ["B minus A", null, null, null, null, null, null, null],
    ]);
  });

  it.each([
    ["metric and category", { metric: "expenses", category: "Rent", a_from: "2026-01", a_to: "2026-01", b_from: "2026-02", b_to: "2026-02" }],
    ["neither", { a_from: "2026-01", a_to: "2026-01", b_from: "2026-02", b_to: "2026-02" }],
    ["no b_to", { metric: "expenses", a_from: "2026-01", a_to: "2026-01", b_from: "2026-02" }],
    ["the unlisted category", { category: UNLISTED, a_from: "2026-01", a_to: "2026-01", b_from: "2026-02", b_to: "2026-02" }],
  ])("refuses %s as bad input", async (_name, input) => {
    const out = await run("compare_periods", input);
    expect(out.is_error).toBe(true);
    expect(out.data.error).toMatch(/^The input is not valid\./);
  });

  it("refuses a reversed or long period with a fixed text that names it", async () => {
    expect((await run("compare_periods", { metric: "income", a_from: "2026-02", a_to: "2026-01", b_from: "2026-02", b_to: "2026-02" })).data.error)
      .toBe("a_from must not be after a_to.");
    expect((await run("compare_periods", { metric: "income", a_from: "2026-01", a_to: "2026-01", b_from: "2023-01", b_to: "2026-02" })).data.error)
      .toBe("A range covers at most 24 months.");
  });
});

describe("find_suspects (stub)", () => {
  it("reads the last 12 months that exist when no range is given, with the defaults", async () => {
    const record = stub();
    const { is_error, data } = await run("find_suspects", {}, record);
    expect(is_error).toBe(false);
    expect(record.calls).toEqual([
      ["months", { spread: false, last: 12 }],
      ["suspects", { first: "2026-01-01", last: "2026-06-01", min_amount: "25000", limit: 25 }],
    ]);
    expect(data).toEqual({
      component: "table", title: "Rows to check, 2026-01 to 2026-06", columns: SUSPECT_COLUMNS,
      rows: [["0123abcd", "2026-03-04", "axis-bank", "", "1000000.00", "debit", "Other", "expense", "other_or_unknown"]],
      total: 1,
    });
  });

  it("uses the range, the minimum and the limit it is given", async () => {
    const record = stub();
    await run("find_suspects", { from_month: "2026-02", to_month: "2026-03", min_amount: "500", limit: 50 }, record);
    expect(record.calls).toEqual([["suspects", { first: "2026-02-01", last: "2026-03-01", min_amount: "500", limit: 50 }]]);
  });

  it("gives an empty table when the record has no month", async () => {
    const record = { ...stub(), months: async () => [] } as never;
    const { is_error, data } = await run("find_suspects", {}, record);
    expect(is_error).toBe(false);
    expect(data).toMatchObject({ component: "table", rows: [], total: 0, columns: SUSPECT_COLUMNS });
  });

  it.each([
    ["only from_month", { from_month: "2026-01" }],
    ["a limit of 51", { limit: 51 }],
    ["an amount that is text", { min_amount: "lots" }],
    ["an extra key", { category: "Other" }],
  ])("refuses %s as bad input", async (_name, input) => {
    const out = await run("find_suspects", input);
    expect(out.is_error).toBe(true);
    expect(out.data.error).toMatch(/^The input is not valid\./);
  });
});

describe("get_rows and show_table rows: range and sort (stub)", () => {
  it("pass from_month, to_month and sort to record.rows", async () => {
    const record = stub();
    await run("get_rows", { from_month: "2026-01", to_month: "2026-03", sort: "amount", limit: 5 }, record);
    await run("show_table", { source: "rows", from_month: "2026-01", to_month: "2026-03", sort: "date" }, record);
    expect(record.calls).toEqual([
      ["rows", { limit: 5, from_month: "2026-01", to_month: "2026-03", sort: "amount" }],
      ["rows", { limit: 20, from_month: "2026-01", to_month: "2026-03", sort: "date" }],
    ]);
  });

  it("refuses an unknown sort", async () => {
    const out = await run("get_rows", { sort: "payee" });
    expect(out.is_error).toBe(true);
  });
});

// --- the SQL over the golden seed -----------------------------------------------------------

describe.skipIf(!pgAdmin)(`the insight queries (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());
  const record = () => createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction }));
  const call = async (name: string, input: unknown) => {
    const out = await createTools(record()).run(name, input);
    return { ...out, data: JSON.parse(out.content) };
  };

  it("rows: a range of months, and sort by amount, largest first", async () => {
    const r = record();
    const all = await r.rows({ limit: 50 });
    const ranged = await r.rows({ from_month: "2026-09", to_month: "2026-09", limit: 50 });
    expect(ranged.rows).toEqual(all.rows.filter((x) => x.month === "2026-09-01"));
    expect(ranged.total).toBe(ranged.rows.length);
    const august = await r.rows({ from_month: "2026-08", to_month: "2026-08", limit: 50 });
    expect(august.rows.map((x) => x.month)).toEqual(["2026-08-01"]);
    const big = await r.rows({ from_month: "2026-08", to_month: "2026-09", sort: "amount", limit: 3 });
    expect(big.rows.map((x) => x.amount)).toEqual(["150000.00", "40000.00", "30000.00"]);
    expect(big.total).toBe(all.total);
    const dated = await r.rows({ sort: "date", limit: 50 });
    expect(dated).toEqual(all);
  });

  it.each([
    [{ month: "2026-09", from_month: "2026-08", to_month: "2026-09", limit: 5 }],
    [{ from_month: "2026-09", limit: 5 }],
    [{ to_month: "2026-09", limit: 5 }],
    [{ from_month: "2026-09", to_month: "2026-08", limit: 5 }],
    [{ from_month: "2024-01", to_month: "2026-01", limit: 5 }],
    [{ from_month: "2026-13", to_month: "2026-12", limit: 5 }],
    [{ sort: "payee", limit: 5 }],
  ])("rows refuses %j with a plain reason", async (filter) => {
    await expect(record().rows(filter as never)).rejects.toThrow(RecordInputError);
  });

  it("get_rows refuses month together with a range, with a fixed text", async () => {
    const out = await call("get_rows", { month: "2026-09", from_month: "2026-08", to_month: "2026-09" });
    expect(out.is_error).toBe(true);
    expect(out.data.error).toBe("Give month or from_month and to_month, not both.");
  });

  it("topCategories: the net of each category of a kind over the range, largest first", async () => {
    const cats = await record().topCategories({ spread: false, kind: "expense", first: "2026-08-01", last: "2026-09-01" });
    expect(cats).toEqual([
      { category: "Rent", rows: 2, net: "35000.00" },
      { category: "Loan EMI", rows: 2, net: "20000.00" },
      { category: "Shopping", rows: 1, net: "15000.00" },
      { category: "Groceries", rows: 1, net: "3456.75" },
      { category: "Food & dining", rows: 2, net: "2000.00" },
      { category: UNLISTED, rows: 1, net: "999.00" },
      { category: "Family & gifts", rows: 1, net: "-800.00" },
    ]);
    const income = await record().topCategories({ spread: false, kind: "income", first: "2026-09-01", last: "2026-09-01" });
    expect(income.map((c) => c.category)).toEqual(["Salary", "Interest & dividends"]);
    // The spread view moves two thirds of the rent out of September.
    const spread = await record().topCategories({ spread: true, kind: "expense", first: "2026-09-01", last: "2026-09-01" });
    expect(spread.find((c) => c.category === "Rent")!.net).not.toBe("35000.00");
  });

  it("get_top categories: the All row equals the expenses of the months", async () => {
    const out = await call("get_top", { by: "categories", from_month: "2026-08", to_month: "2026-09" });
    expect(out.is_error).toBe(false);
    const all = out.data.rows.at(-1);
    expect(all[0]).toBe("All");
    expect(all[2]).toBe("75655.75"); // 500.00 in August + 75155.75 in September
    expect(EXPECTED.months.cash.map((x: { expenses: string }) => x.expenses)).toEqual(["500.00", "75155.75"]);
    expect(out.data.rows[0]).toEqual(["Rent", 2, "35000.00", pct("35000.00", "75655.75")]);
    expect(out.content).not.toMatch(PLANTED);
  });

  it("topRows: the largest rows of a kind that add to it (value above 0), with the count", async () => {
    const top = await record().topRows({ kind: "expense", first: "2026-08-01", last: "2026-09-01", limit: 3 });
    expect(top.rows.map((x) => [x.amount, x.category])).toEqual([
      ["40000.00", "Rent"], ["30000.00", "Loan EMI"], ["15000.00", "Shopping"],
    ]);
    // Seven expense rows add: the refunds (Rent 5,000, Loan EMI 10,000, the gift 800) do not.
    expect(top.total).toBe(7);
    const inv = await record().topRows({ kind: "investment", first: "2026-09-01", last: "2026-09-01", limit: 5 });
    expect(inv.rows.map((x) => x.amount)).toEqual(["25000.00"]);
  });

  it("get_top rows renders a table of the rows", async () => {
    const out = await call("get_top", { by: "rows", kind: "income", from_month: "2026-09", to_month: "2026-09" });
    expect(out.data.columns).toEqual(["row_id", "date", "source", "account", "amount", "direction", "category"]);
    expect(out.data.rows.map((r: unknown[]) => r[4])).toEqual(["150000.00", "1200.50"]);
    expect(out.data.total).toBe(2);
  });

  it("compare_periods agrees with get_stats over the seed", async () => {
    const out = await call("compare_periods", {
      metric: "expenses", complete_only: false, a_from: "2026-08", a_to: "2026-08", b_from: "2026-09", b_to: "2026-09",
    });
    expect(out.data.rows).toEqual([
      ["A", "2026-08", "2026-08", 1, 0, "500.00", "500.00", null],
      ["B", "2026-09", "2026-09", 1, 0, "75155.75", "75155.75", null],
      ["B minus A", null, null, null, null, "74655.75", "74655.75", "14931.2"],
    ]);
  });

  describe("suspects, with planted rows", () => {
    const AXIS = "axis-bank2026-09-01000000000000000000000000000000000000000000000";
    const planted: [string, string, string, string, string][] = [
      // id prefix, date, amount, direction, category
      ["a1", "2026-09-20", "1000000.00", "debit", "Other"],
      ["a2", "2026-09-21", "50000.00", "debit", "Shopping"],
      ["a3", "2026-09-22", "100.00", "debit", "Groceries"],
      ["a4", "2026-09-23", "200.00", "debit", "Groceries"],
      ["a5", "2026-09-24", "30000.50", "debit", "Groceries"],
      ["a6", "2026-09-25", "26000.00", "debit", "Investments"],
    ];
    beforeAll(async () => {
      for (const [id, date, amount, direction, category] of planted) {
        const txn = id.padEnd(64, "0");
        await database.owner.query(
          "insert into transactions (txn_id, statement_id, seq, txn_date, amount, direction, narration, balance) " +
            "values ($1, $2, $3, $4, $5, $6, 'ZQX planted', null)",
          [txn, AXIS, 100 + planted.findIndex((p) => p[0] === id), date, amount, direction],
        );
        await database.owner.query(
          "insert into categorisations (txn_id, counterparty, category, confidence, reason, origin, needs_review) " +
            "values ($1, 'ZQX Payee', $2, 'high', 'ZQX reason', 'ai', false)",
          [txn, category],
        );
      }
    });

    it("finds Other and unlisted rows, unlinked round rows and outliers, largest first", async () => {
      const found = await record().suspects({ first: "2026-08-01", last: "2026-09-01", min_amount: "25000", limit: 50 });
      expect(found.rows.map((x) => [x.amount, x.category, x.kind, x.reason])).toEqual([
        ["1000000.00", "Other", "expense", "other_or_unknown"],
        ["150000.00", "Salary", "income", "unlinked_round"],
        ["50000.00", "Shopping", "expense", "unlinked_round"],
        ["40000.00", "Rent", "expense", "unlinked_round"],
        // Groceries: 100, 200, 3,456.75, 30,000.50; the median is 1,828.375, and 30,000.50 is more than 5 times it.
        ["30000.50", "Groceries", "expense", "outlier"],
        ["30000.00", "Loan EMI", "expense", "unlinked_round"],
      ]);
      // The linked 20,000 card payment, the investments and rows under the minimum are not suspects.
      expect(found.total).toBe(6);
      expect(found.rows[0]).toMatchObject({ row_id: "a1000000", direction: "debit", source: "axis-bank" });
    });

    it("keeps to the minimum, the range and the limit", async () => {
      const r = record();
      const low = await r.suspects({ first: "2026-09-01", last: "2026-09-01", min_amount: "500", limit: 50 });
      expect(low.rows.map((x) => [x.amount, x.reason])).toContainEqual(["999.00", "other_or_unknown"]);
      expect(low.rows.find((x) => x.amount === "999.00")!.category).toBe(UNLISTED);
      expect(low.rows.map((x) => x.amount)).toContain("5000.00"); // the round rent refund from the old landlord
      const august = await r.suspects({ first: "2026-08-01", last: "2026-08-01", min_amount: "0", limit: 50 });
      expect(august.rows).toEqual([]);
      const one = await r.suspects({ first: "2026-08-01", last: "2026-09-01", min_amount: "25000", limit: 1 });
      expect(one.rows).toHaveLength(1);
      expect(one.total).toBe(6);
    });

    it("find_suspects renders the table with no planted text, over the record's months by default", async () => {
      const out = await call("find_suspects", {});
      expect(out.is_error).toBe(false);
      expect(out.data.title).toBe("Rows to check, 2026-08 to 2026-09");
      expect(out.data.columns).toEqual(SUSPECT_COLUMNS);
      expect(out.data.rows[0]).toEqual(["a1000000", "2026-09-20", "axis-bank", "", "1000000.00", "debit", "Other", "expense", "other_or_unknown"]);
      expect(out.content).not.toMatch(PLANTED);
      const unlisted = await call("find_suspects", { from_month: "2026-09", to_month: "2026-09", min_amount: "500", limit: 50 });
      expect(unlisted.content).toContain(UNLISTED);
      expect(unlisted.content).not.toMatch(PLANTED);
    });

    it.each([
      [{ first: "2026-09", last: "2026-09-01", min_amount: "0", limit: 5 }],
      [{ first: "2026-09-01", last: "2026-09-01", min_amount: "1e3", limit: 5 }],
      [{ first: "2026-09-01", last: "2026-09-01", min_amount: "0", limit: 51 }],
    ])("suspects refuses %j with a plain reason", async (args) => {
      await expect(record().suspects(args as never)).rejects.toThrow(RecordInputError);
    });
  });
});
