// E3.3.1: four tiles with value and change (up or down, %), and a "Partial month" badge.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KpiTiles } from "../src/components/KpiTiles";
import { monthView } from "./fixtures";

const tile = (name: string) => within(screen.getByRole("group", { name }));

describe("KpiTiles", () => {
  it("shows the four tiles with value, change and percent", () => {
    render(<KpiTiles month={monthView("cash", "2026-09")} />);

    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "Income", "Expenses", "Savings", "Investments",
    ]);
    expect(tile("Expenses").getByText("₹75,155.75")).toBeTruthy();
    expect(tile("Expenses").getByText("+₹74,655.75")).toBeTruthy();
    expect(tile("Expenses").getByText("+14,931.2%")).toBeTruthy();
    expect(tile("Expenses").getByText("Up from Aug 2026")).toBeTruthy();
    expect(tile("Savings").getByText("₹76,044.75")).toBeTruthy();
  });

  it("says why there is no percent when the month before was 0", () => {
    render(<KpiTiles month={monthView("cash", "2026-09")} />);

    expect(tile("Income").getByText("+₹1,51,200.50")).toBeTruthy();
    expect(tile("Income").getByText("no % (Aug 2026 was ₹0.00)")).toBeTruthy();
  });

  it("says there is no earlier month", () => {
    render(<KpiTiles month={monthView("cash", "2026-08")} />);

    expect(tile("Expenses").getByText("₹500.00")).toBeTruthy();
    expect(tile("Expenses").getByText("No earlier month")).toBeTruthy();
    expect(screen.queryByText(/Up from|Down from/)).toBeNull();
  });

  it("shows a fall as down, with the sign", () => {
    render(<KpiTiles month={monthView("spread", "2026-10")} />);

    expect(tile("Expenses").getByText("-₹35,155.75")).toBeTruthy();
    expect(tile("Expenses").getByText("-72.5%")).toBeTruthy();
    expect(tile("Expenses").getByText("Down from Sep 2026")).toBeTruthy();
  });

  it("shows no change as level", () => {
    const month = structuredClone(monthView("cash", "2026-09"));
    month.kpis.investments = { value: "5.00", previous: "5.00", change: "0.00", pct: "0.0" };

    render(<KpiTiles month={month} />);

    expect(tile("Investments").getByText("Level with Aug 2026")).toBeTruthy();
  });

  it("shows a change below one paisa as level, without a plus sign", () => {
    const month = structuredClone(monthView("cash", "2026-09"));
    month.kpis.investments = { value: "5.001", previous: "5.00", change: "0.001", pct: "0.0" };

    render(<KpiTiles month={month} />);

    expect(tile("Investments").getByText("Level with Aug 2026")).toBeTruthy();
    expect(tile("Investments").getByText("₹0.00")).toBeTruthy();
  });

  it("badges a partial month, and only a partial month", () => {
    const { rerender } = render(<KpiTiles month={monthView("cash", "2026-09")} />);
    expect(screen.getByText("Partial month")).toBeTruthy();

    rerender(<KpiTiles month={{ ...monthView("cash", "2026-09"), complete: true }} />);
    expect(screen.queryByText("Partial month")).toBeNull();
  });

  it("draws text from the data as text, never as markup", () => {
    const month = structuredClone(monthView("cash", "2026-09"));
    month.kpis.income.value = "<img src=x onerror=alert(1)>";

    const { container } = render(<KpiTiles month={month} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("onerror");
  });
});
