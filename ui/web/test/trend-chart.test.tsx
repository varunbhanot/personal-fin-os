// E3.3.2: 12 months of income, expenses and savings, partial months marked, an empty state.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendChart } from "../src/components/TrendChart";
import { cashMonths, spreadMonths } from "./fixtures";

describe("TrendChart", () => {
  it("draws the bars and names the three series in the legend", () => {
    const { container } = render(<TrendChart months={cashMonths} />);

    expect(screen.getByRole("img", { name: /Income, expenses and savings by month/ })).toBeTruthy();
    expect(container.querySelector("svg.recharts-surface")).not.toBeNull();
    // Six values, but August's income is 0 and a zero bar draws no rectangle.
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(5);
    const legend = screen.getByRole("list", { name: "Series" });
    expect(within(legend).getAllByRole("listitem").map((i) => i.textContent)).toEqual([
      "Income", "Expenses", "Savings",
    ]);
  });

  it("keeps the figures in a table, for a screen reader and for the test", () => {
    render(<TrendChart months={spreadMonths} />);

    const table = screen.getByRole("table", { name: "Income, expenses and savings by month" });
    const rows = within(table).getAllByRole("row").map((r) => within(r).queryAllByRole("cell").map((c) => c.textContent));
    expect(rows.slice(1)).toEqual([
      ["Aug 2026", "₹0.00", "₹500.00", "-₹500.00", "Partial"],
      ["Sep 2026", "₹1,51,200.50", "₹48,489.08", "₹1,02,711.42", "Partial"],
      ["Oct 2026", "₹0.00", "₹13,333.33", "-₹13,333.33", "Partial"],
      ["Nov 2026", "₹0.00", "₹13,333.34", "-₹13,333.34", "Partial"],
    ]);
  });

  it("marks a partial month, with a note, and a complete month without", () => {
    const months = [{ ...cashMonths[0]!, complete: true }, cashMonths[1]!];

    render(<TrendChart months={months} />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Complete")).toBeTruthy();
    expect(within(table).getByText("Partial")).toBeTruthy();
    expect(screen.getByText("Lighter bars are partial months.")).toBeTruthy();
  });

  it("writes no partial note when every month is complete", () => {
    render(<TrendChart months={cashMonths.map((m) => ({ ...m, complete: true }))} />);

    expect(screen.queryByText("Lighter bars are partial months.")).toBeNull();
  });

  it("shows an empty state for an empty record, with no chart", () => {
    const { container } = render(<TrendChart months={[]} />);

    expect(screen.getByText("No months in the record yet.")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});
