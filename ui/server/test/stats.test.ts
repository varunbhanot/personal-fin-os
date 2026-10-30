// get_stats: totals, averages, the median and the highest and lowest month, worked out on the
// server in exact decimals so the model never does arithmetic. A stub record, no database.
import { describe, expect, it } from "vitest";
import { type ToolRecord, createTools } from "../src/tools.js";

type Month = { month: string; complete: boolean; income: string; expenses: string; savings: string; investments: string };
const m = (month: string, complete: boolean, expenses: string): Month => ({
  month: `${month}-01`, complete, income: "1000.00", expenses, savings: "0.00", investments: "0.00",
});
const MONTHS: Month[] = [
  m("2026-01", true, "300.00"), m("2026-02", true, "100.00"), m("2026-03", true, "200.00"),
  m("2026-04", true, "100.00"), m("2026-05", false, "-17922.00"),
];

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
        { month: "2026-02-01", complete: true, net: "0" },
        { month: "2026-03-01", complete: false, net: "70.00" },
      ];
    },
  } as never;
}

async function call(input: unknown, record = stub()) {
  const out = await createTools(record).run("get_stats", input);
  return { ...out, data: JSON.parse(out.content) };
}

describe("get_stats", () => {
  it("averages the complete months of a metric and names the partial months it left out", async () => {
    const { is_error, data } = await call({ metric: "expenses", from_month: "2026-01", to_month: "2026-05" });
    expect(is_error).toBe(false);
    expect(data).toEqual({
      component: "read", metric: "expenses", category: null, from_month: "2026-01", to_month: "2026-05",
      spread: false, complete_only: true,
      months_used: ["2026-01", "2026-02", "2026-03", "2026-04"], months_skipped: ["2026-05"],
      count: 4, total: "700.00", average: "175.00", median: "150.00",
      highest: { month: "2026-01", value: "300.00" }, lowest: { month: "2026-02", value: "100.00" },
    });
  });

  it("counts partial months too when complete_only is false", async () => {
    const { data } = await call({ metric: "expenses", from_month: "2026-01", to_month: "2026-05", complete_only: false });
    expect(data.months_skipped).toEqual([]);
    expect(data.count).toBe(5);
    expect(data.total).toBe("-17222.00");
    expect(data.average).toBe("-3444.40");
    expect(data.median).toBe("100.00");
    expect(data.lowest).toEqual({ month: "2026-05", value: "-17922.00" });
  });

  it("keeps to the range and takes the earliest month on a tie", async () => {
    const { data } = await call({ metric: "expenses", from_month: "2026-02", to_month: "2026-04" });
    expect(data.months_used).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(data.average).toBe("133.33");
    expect(data.median).toBe("100.00");
    expect(data.lowest).toEqual({ month: "2026-02", value: "100.00" });
  });

  it("works on one category through its monthly net", async () => {
    const record = stub();
    const { data } = await call({ category: "Groceries", from_month: "2026-01", to_month: "2026-03", spread: true }, record);
    expect(record.calls).toEqual([["categorySeries", { spread: true, category: "Groceries", first: "2026-01-01", last: "2026-03-01" }]]);
    expect(data).toMatchObject({
      metric: null, category: "Groceries", spread: true, months_used: ["2026-01", "2026-02"],
      months_skipped: ["2026-03"], count: 2, total: "50.00", average: "25.00", median: "25.00",
    });
  });

  it("gives null figures when no month in the range qualifies", async () => {
    const { is_error, data } = await call({ metric: "income", from_month: "2026-05", to_month: "2026-05" });
    expect(is_error).toBe(false);
    expect(data).toMatchObject({
      months_used: [], months_skipped: ["2026-05"], count: 0,
      total: null, average: null, median: null, highest: null, lowest: null,
    });
  });

  it.each([
    ["metric and category together", { metric: "expenses", category: "Groceries", from_month: "2026-01", to_month: "2026-02" }],
    ["neither metric nor category", { from_month: "2026-01", to_month: "2026-02" }],
    ["an unknown category", { category: "Holidays on Mars", from_month: "2026-01", to_month: "2026-02" }],
    ["an extra key", { metric: "expenses", from_month: "2026-01", to_month: "2026-02", round: 0 }],
  ])("refuses %s as bad input", async (_name, input) => {
    const out = await createTools(stub()).run("get_stats", input);
    expect(out.is_error).toBe(true);
    expect(JSON.parse(out.content).error).toMatch(/^The input is not valid\./);
  });

  it("refuses a reversed range and more than 24 months", async () => {
    const reversed = await call({ metric: "expenses", from_month: "2026-05", to_month: "2026-01" });
    expect(reversed.data.error).toBe("from_month must not be after to_month.");
    const long = await call({ metric: "expenses", from_month: "2024-01", to_month: "2026-01" });
    expect(long.data.error).toBe("Statistics cover at most 24 months.");
  });
});
