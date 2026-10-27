// E4.2: the renderers by tool name. They reuse the E3 components and draw from the result
// content only, never from the tool-call arguments.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolItem } from "../src/chatState";
import { ToolCall } from "../src/components/ToolCall";
import { breakdownResult, chartResult, kpisResult, tableResult } from "./chat-fixtures";

const item = (name: string, result: unknown | null, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool", id: "t1", name, title: null, args: "", done: result !== null, stopped: false,
  result: result === null ? null : typeof result === "string" ? result : JSON.stringify(result),
  ...extra,
});

describe("ToolCall: show_kpis", () => {
  it("draws only the chosen tiles from the result, with the E3 KpiTiles", () => {
    render(<ToolCall item={item("show_kpis", kpisResult)} />);

    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Income", "Expenses"]);
    expect(within(screen.getByRole("group", { name: "Expenses" })).getByText("₹75,155.75")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Expenses" })).getByText("Up from Aug 2026")).toBeTruthy();
    expect(screen.getByText("Partial month")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Key figures for 2026-09" })).toBeTruthy();
  });

  it("ignores figures in the tool-call arguments", () => {
    const args = JSON.stringify({ month: "2026-09", metrics: ["income"], value: "999999.99" });
    render(<ToolCall item={item("show_kpis", kpisResult, { args })} />);

    expect(screen.queryByText(/9,99,999/)).toBeNull();
    expect(screen.getByText("₹1,51,200.50")).toBeTruthy();
  });
});

describe("ToolCall: show_chart", () => {
  it("draws a chart with a data table of the figures", () => {
    const { container } = render(<ToolCall item={item("show_chart", chartResult)} />);

    expect(screen.getByRole("heading", { name: "Income and expenses" })).toBeTruthy();
    expect(container.querySelector(".recharts-responsive-container")).not.toBeNull();
    const table = screen.getByRole("table", { name: "Income and expenses" });
    expect(within(table).getByText("₹1,51,200.50")).toBeTruthy();
    expect(within(table).getByText("₹75,155.75")).toBeTruthy();
    expect(screen.getByText("Lighter bars are partial months: Sep 2026.")).toBeTruthy();
  });

  it("draws a line chart too", () => {
    const { container } = render(<ToolCall item={item("show_chart", { ...chartResult, chart: "line" })} />);

    expect(container.querySelector(".recharts-line")).not.toBeNull();
    expect(container.querySelector(".recharts-bar")).toBeNull();
    expect(screen.getByText("Lighter points are partial months: Sep 2026.")).toBeTruthy();
  });

  it("shows an empty state for a chart without points", () => {
    render(<ToolCall item={item("show_chart", { ...chartResult, series: [] })} />);
    expect(screen.getByText("No figures to chart.")).toBeTruthy();
  });
});

describe("ToolCall: show_table", () => {
  it("formats money columns, yes/no and the total", () => {
    render(<ToolCall item={item("show_table", tableResult)} />);

    const table = screen.getByRole("table", { name: "Months" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["month", "complete", "income", "expenses"]);
    expect(within(table).getByText("₹1,51,200.50")).toBeTruthy();
    expect(within(table).getByText("Complete")).toBeTruthy();
    expect(within(table).getByText("Partial")).toBeTruthy();
    expect(within(table).getAllByText("2026-09").length).toBe(1);
  });

  it("says how many rows are not shown", () => {
    render(<ToolCall item={item("show_table", { ...tableResult, total: 120 })} />);
    expect(screen.getByText("Showing 2 of 120 rows.")).toBeTruthy();
  });

  it("shows a null cell as a dash and text as text", () => {
    const result = { ...tableResult, columns: ["category", "net", "previous"], rows: [["<img src=x onerror=alert(1)>", "10", null]] };
    const { container } = render(<ToolCall item={item("show_table", result)} />);

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("–")).toBeTruthy();
  });
});

describe("ToolCall: show_category_breakdown", () => {
  it("reuses the category table", () => {
    render(<ToolCall item={item("show_category_breakdown", breakdownResult)} />);

    const table = screen.getByRole("table", { name: "Spending by category" });
    expect(within(table).getByText("Groceries")).toBeTruthy();
    expect(within(table).getByText("₹3,456.75")).toBeTruthy();
  });
});

describe("ToolCall: states and failures", () => {
  it("shows a skeleton with the title as text between the start and the result", () => {
    const { container } = render(<ToolCall item={item("show_kpis", null, { title: "<b>Big</b> title" })} />);

    expect(screen.getByText("<b>Big</b> title")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows a stopped call as plain text, not as a busy skeleton", () => {
    const { container } = render(<ToolCall item={item("show_chart", null, { stopped: true })} />);

    expect(screen.getByText("Stopped before the result arrived")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("shows a skeleton without a title", () => {
    render(<ToolCall item={item("show_chart", null)} />);
    expect(screen.getByText("Preparing a chart…")).toBeTruthy();
  });

  it("shows an {error} result as plain text", () => {
    render(<ToolCall item={item("show_kpis", { error: "No statement covers that month." })} />);
    expect(screen.getByRole("alert").textContent).toBe("No statement covers that month.");
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a result of the wrong shape", { component: "kpis", tiles: "many" }],
    ["a result for another component", chartResult],
    ["a number as a figure", { ...kpisResult, tiles: [{ metric: "income", value: 5, previous: null, change: null, pct: null }] }],
    ["an unknown metric", { ...kpisResult, tiles: [{ ...kpisResult.tiles[0], metric: "x" }] }],
    ["a JSON null", "null"],
  ])("shows 'Could not show this result' for %s", (_name, result) => {
    render(<ToolCall item={item("show_kpis", result)} />);
    expect(screen.getByText("Could not show this result")).toBeTruthy();
  });

  it("refuses a result that is too long to parse", () => {
    render(<ToolCall item={item("show_table", "x".repeat(300_000))} />);
    expect(screen.getByText("Could not show this result")).toBeTruthy();
  });

  it("shows a small 'read:' line for the read tools and draws nothing else", () => {
    const { container } = render(
      <>
        <ToolCall item={item("get_health", { component: "read", review_rows: 3 })} />
        <ToolCall item={item("get_rows", { component: "read", rows: [] }, { id: "t2" })} />
      </>,
    );
    expect(screen.getByText("read: get_health")).toBeTruthy();
    expect(screen.getByText("read: get_rows")).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
  });

  it.each([["unknown_tool", "read: unknown_tool"], ["Bad Name<script>", "read: tool"], ["x".repeat(41), "read: tool"], ["", "read: tool"]])(
    "names an unknown tool %j as %j",
    (name, line) => {
      render(<ToolCall item={item(name, { anything: 1 })} />);
      expect(screen.getByText(line)).toBeTruthy();
    },
  );
});
