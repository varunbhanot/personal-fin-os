// E3.3.5: coverage grid, complete and partial months, review, uncategorised, unlinked transfer
// rows, flagged statements, and the AI spend against the budget in use.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthPanel } from "../src/components/HealthPanel";
import { health } from "./fixtures";

describe("HealthPanel", () => {
  it("shows the coverage of each account in each month", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    const grid = screen.getByRole("table", { name: "Days covered by account and month" });
    const rows = within(grid).getAllByRole("row").map((r) =>
      within(r).queryAllByRole("columnheader").concat(within(r).queryAllByRole("cell")).map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["Account", "Aug 2026", "Sep 2026"],
      ["axis-bank", "0/31", "30/30"],
      ["sbi-bank ••1111", "0/31", "0/30"],
      ["sbi-card ••04", "10/31", "21/30"],
    ]);
  });

  it("names the complete and the partial months", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    expect(screen.getByText("Complete months: none")).toBeTruthy();
    expect(screen.getByText("Partial months: Aug 2026, Sep 2026")).toBeTruthy();
  });

  it("shows the review queue, uncategorised and unlinked transfer rows", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    expect(screen.getByText("1 row waits for review, ₹15,000.00")).toBeTruthy();
    expect(screen.getByText("0 rows have no category")).toBeTruthy();
    expect(screen.getByText("2 transfer rows are not linked (out ₹7,000.00, in ₹2,000.00)")).toBeTruthy();
    expect(screen.getByText("Run finos transfers in a cloud session for the detail.")).toBeTruthy();
  });

  it("lists the flagged statements", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    expect(screen.getByText("sbi-bank ••1111, 2026-09-01 to 2026-09-30, 1 row")).toBeTruthy();
  });

  it("says when no statement is flagged", () => {
    render(<HealthPanel health={{ ...health, flagged_statements: [] }} budgetUsd="100" />);

    expect(screen.getByText("No statement is flagged.")).toBeTruthy();
  });

  it("shows the AI spend by purpose against the budget in use", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    expect(screen.getByText("$2.35 of $100.00 this month")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "AI spend against the monthly limit" });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    const purposes = within(screen.getByRole("list", { name: "AI spend by purpose" }))
      .getAllByRole("listitem").map((i) => i.textContent);
    expect(purposes).toEqual([
      "categorise: $0.2500 (1 call)", "chat: $0.1000 (1 call)", "extract: $2.0000 (2 calls)",
    ]);
  });

  it("caps the bar at the limit and says so", () => {
    render(<HealthPanel health={{ ...health, ai_spent_this_month: "120.0000" }} budgetUsd="100" />);

    expect(screen.getByRole("progressbar", { name: /AI spend/ }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("The monthly AI limit is reached.")).toBeTruthy();
  });

  it("shows the schema version", () => {
    render(<HealthPanel health={health} budgetUsd="100" />);

    expect(screen.getByText("Schema version 0009_ai_usage_text")).toBeTruthy();
  });

  it("renders any label that holds markup as text", () => {
    const bad = "<img src=x onerror=alert(1)>";
    const hostile = {
      ...health,
      flagged_statements: [{ ...health.flagged_statements[0]!, source: bad }],
      ai_spend: [{ purpose: bad, calls: 1, cost_usd: "1.0000" }],
      schema_version: bad,
    };

    const { container } = render(<HealthPanel health={hostile} budgetUsd="100" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(bad);
  });
});
