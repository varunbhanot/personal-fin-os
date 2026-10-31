// The insight tools (get_top, compare_periods, find_suspects) return the table shape of
// show_table; the chat draws them with ResultTable under their own fixed labels.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolItem } from "../src/chatState";
import { ToolCall } from "../src/components/ToolCall";
import { isRenderTool, parseResult } from "../src/results";

const item = (name: string, result: unknown | null): ToolItem => ({
  kind: "tool", id: "t1", name, title: null, args: "", done: result !== null, stopped: false,
  result: result === null ? null : typeof result === "string" ? result : JSON.stringify(result),
});

const top = {
  component: "table", title: "Top expense categories, 2026-08 to 2026-09", total: 2,
  columns: ["category", "rows", "total", "share_pct"],
  rows: [["Rent", 2, "35000.00", "46.3"], ["All", 9, "75655.75", "100.0"]],
};
const comparison = {
  component: "table", title: "Expenses: 2026-08 to 2026-08 against 2026-09 to 2026-09", total: 3,
  columns: ["period", "from", "to", "months_used", "months_skipped", "total", "average", "pct_change"],
  rows: [
    ["A", "2026-08", "2026-08", 1, 0, "500.00", "500.00", null],
    ["B", "2026-09", "2026-09", 1, 0, "75155.75", "75155.75", null],
    ["B minus A", null, null, null, null, "74655.75", "74655.75", "14931.2"],
  ],
};
const suspects = {
  component: "table", title: "Rows to check, 2026-08 to 2026-09", total: 1,
  columns: ["row_id", "date", "source", "account", "amount", "direction", "category", "kind", "reason"],
  rows: [["a1000000", "2026-09-20", "axis-bank", "", "1000000.00", "debit", "Other", "expense", "other_or_unknown"]],
};

describe("the insight tools are render tools with the table shape", () => {
  it.each([["get_top", top], ["compare_periods", comparison], ["find_suspects", suspects]])("%s", (name, result) => {
    expect(isRenderTool(name)).toBe(true);
    const parsed = parseResult(name as "get_top", JSON.stringify(result));
    expect(parsed.ok).toBe(true);
    expect(parseResult(name as "get_top", JSON.stringify({ ...result, component: "chart" })).ok).toBe(false);
    expect(parseResult(name as "get_top", JSON.stringify({ error: "A range covers at most 24 months." })))
      .toEqual({ ok: false, error: "A range covers at most 24 months." });
  });
});

describe("ToolCall: the insight tools", () => {
  it("get_top: totals in rupees and the share as a plain percentage", () => {
    render(<ToolCall item={item("get_top", top)} />);
    expect(screen.getByText("Top list")).toBeTruthy();
    const table = screen.getByRole("table", { name: top.title });
    expect(within(table).getByText("₹35,000.00")).toBeTruthy();
    expect(within(table).getByText("46.3%")).toBeTruthy();
    expect(within(table).getByText("₹75,655.75")).toBeTruthy();
  });

  it("get_top: a cut category shows the 'Showing' note (total counts the All row)", () => {
    // The server's shape for 3 categories with limit 2: 2 categories and All, total 4.
    const cut = {
      ...top, total: 4, partial_months: ["2026-09"],
      rows: [["Rent", 2, "35000.00", "46.3"], ["Groceries", 5, "30000.00", "39.7"], ["All", 9, "75655.75", "100.0"]],
    };
    expect(parseResult("get_top", JSON.stringify(cut)).ok).toBe(true);
    render(<ToolCall item={item("get_top", cut)} />);
    expect(screen.getByText("Showing 3 of 4 rows.")).toBeTruthy();
  });

  it("compare_periods: totals and averages in rupees, the change as a signed percentage", () => {
    render(<ToolCall item={item("compare_periods", comparison)} />);
    expect(screen.getByText("Comparison")).toBeTruthy();
    const table = screen.getByRole("table", { name: comparison.title });
    expect(within(table).getAllByText("₹74,655.75")).toHaveLength(2);
    expect(within(table).getByText("+14,931.2%")).toBeTruthy();
  });

  it("find_suspects: the rows with their reason", () => {
    render(<ToolCall item={item("find_suspects", suspects)} />);
    expect(screen.getByText("Rows to check")).toBeTruthy();
    const table = screen.getByRole("table", { name: suspects.title });
    expect(within(table).getByText("₹10,00,000.00")).toBeTruthy();
    expect(within(table).getByText("other_or_unknown")).toBeTruthy();
  });

  it("shows a pending card while the result has not arrived", () => {
    render(<ToolCall item={item("find_suspects", null)} />);
    expect(screen.getByText("Looking for rows to check…")).toBeTruthy();
  });
});
