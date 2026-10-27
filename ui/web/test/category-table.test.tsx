// E3.3.3: categories in the order the server gives (list position), with previous, change and %;
// a negative net (a refund) is shown as such.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CategoryTable } from "../src/components/CategoryTable";
import { monthView } from "./fixtures";

const rowsOf = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) =>
    within(r).getAllByRole("cell").map((c) => c.textContent),
  );

describe("CategoryTable", () => {
  it("lists the categories in server order with previous, change and percent", () => {
    render(<CategoryTable month={monthView("cash", "2026-09")} />);

    const rows = rowsOf();
    expect(rows.map((r) => r[0])).toEqual([
      "Groceries", "Food & dining", "Rent", "Shopping", "Loan EMI", "Family & gifts", "Salary",
      "Interest & dividends", "Investments", "Other (unlisted)",
    ]);
    expect(rows[1]).toEqual(["Food & dining", "Expense", "₹1,500.00", "₹500.00", "+₹1,000.00", "+200.0%"]);
    // Groceries had nothing in August: previous is 0, so there is no percent.
    expect(rows[0]).toEqual(["Groceries", "Expense", "₹3,456.75", "₹0.00", "+₹3,456.75", "–"]);
  });

  it("shows a negative net as a refund", () => {
    render(<CategoryTable month={monthView("cash", "2026-09")} />);

    const family = screen.getByRole("row", { name: /Family & gifts/ });
    // The net and the change are both -₹800.00 (nothing in August).
    expect(within(family).getAllByText("-₹800.00")).toHaveLength(2);
    expect(within(family).getByText("Net refund")).toBeTruthy();
    // Income and investments never get the refund note.
    expect(screen.getAllByText("Net refund")).toHaveLength(1);
  });

  it("shows dashes without an earlier month", () => {
    render(<CategoryTable month={monthView("cash", "2026-08")} />);

    expect(rowsOf()).toEqual([["Food & dining", "Expense", "₹500.00", "–", "–", "–"]]);
  });

  it("shows an empty state", () => {
    render(<CategoryTable month={{ ...monthView("cash", "2026-08"), categories: [] }} />);

    expect(screen.getByText("No categories this month.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a label that holds markup as text", () => {
    const month = structuredClone(monthView("cash", "2026-08"));
    month.categories[0]!.category = "<img src=x onerror=alert(1)>";

    const { container } = render(<CategoryTable month={month} />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
