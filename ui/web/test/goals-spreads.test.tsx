// E3.3.4: GoalsPanel (name, budget, spent, remaining, bar), SpreadsPanel (row ID, date, amount,
// months, start, problems warning), and cash against spread side by side.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CashSpreadPanel } from "../src/components/CashSpreadPanel";
import { GoalsPanel } from "../src/components/GoalsPanel";
import { SpreadsPanel } from "../src/components/SpreadsPanel";
import { goalsFixture, monthView, spreads } from "./fixtures";

describe("GoalsPanel", () => {
  it("shows the name, budget, spent, remaining and a bar", () => {
    render(<GoalsPanel goals={goalsFixture} />);

    const goal = within(screen.getByRole("group", { name: "ZQX Goal Hill Trip" }));
    expect(goal.getByText("₹50,000.00")).toBeTruthy();
    expect(goal.getByText("₹3,456.75")).toBeTruthy();
    expect(goal.getByText("₹46,543.25")).toBeTruthy();
    const bar = goal.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("7");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });

  it("caps the bar and says so when a goal is over budget", () => {
    const over = { ...goalsFixture[0]!, spent: "60000.00", remaining: "-10000.00" };

    render(<GoalsPanel goals={[over]} />);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Over budget by ₹10,000.00")).toBeTruthy();
  });

  it("does not divide by a budget of 0", () => {
    render(<GoalsPanel goals={[{ ...goalsFixture[0]!, budget: "0", spent: "0", remaining: "0" }]} />);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("lists the month lines", () => {
    render(<GoalsPanel goals={goalsFixture} />);

    expect(screen.getByText("Sep 2026")).toBeTruthy();
  });

  it("shows an empty state", () => {
    render(<GoalsPanel goals={[]} />);

    expect(screen.getByText("No goals yet.")).toBeTruthy();
  });

  it("renders a name that holds markup as text", () => {
    const { container } = render(
      <GoalsPanel goals={[{ ...goalsFixture[0]!, name: "<img src=x onerror=alert(1)>" }]} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});

describe("SpreadsPanel", () => {
  it("shows the row ID, date, amount, months and start", () => {
    render(<SpreadsPanel spreads={spreads} />);

    const cells = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(within(cells).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "d6fbe62a", "2026-09-04", "₹40,000.00", "3", "Sep 2026",
    ]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns about spread and goal rows that add nothing now", () => {
    const problems = [
      { what: "spread" as const, id: 1, row_id: "0a786efb", txn_date: "2026-09-05", source: "axis-bank",
        account_last4: "", direction: "credit" as const, amount: "5000.00", state: "transfer" as const },
      { what: "goal" as const, id: 2, row_id: "d6fbe62a", txn_date: "2026-09-04", source: "axis-bank",
        account_last4: "", direction: "debit" as const, amount: "40000.00", state: "no category" as const },
    ];

    render(<SpreadsPanel spreads={{ ...spreads, problems }} />);

    const warning = screen.getByRole("status");
    expect(within(warning).getByText("2 spread or goal rows add nothing now. Add them again.")).toBeTruthy();
    expect(within(warning).getByText(/0a786efb.*spread.*transfer/)).toBeTruthy();
    expect(within(warning).getByText(/d6fbe62a.*goal.*no category/)).toBeTruthy();
  });

  it("shows an empty state", () => {
    render(<SpreadsPanel spreads={{ spreads: [], problems: [] }} />);

    expect(screen.getByText("No spreads yet.")).toBeTruthy();
  });
});

describe("CashSpreadPanel", () => {
  it("shows cash, spread and the difference side by side", () => {
    render(
      <CashSpreadPanel cash={monthView("cash", "2026-09")} spread={monthView("spread", "2026-09")} />,
    );

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) =>
      within(r).getAllByRole("cell").map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["Income", "₹1,51,200.50", "₹1,51,200.50", "₹0.00"],
      ["Expenses", "₹75,155.75", "₹48,489.08", "-₹26,666.67"],
      ["Savings", "₹76,044.75", "₹1,02,711.42", "+₹26,666.67"],
      ["Investments", "₹20,000.00", "₹20,000.00", "₹0.00"],
    ]);
  });

  it("says when one side has no figures for the month", () => {
    render(<CashSpreadPanel cash={null} spread={monthView("spread", "2026-10")} />);

    expect(screen.getByText("No cash figures for this month.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
