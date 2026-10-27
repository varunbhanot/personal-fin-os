// E3.4: the dashboard page. Month picker (default: the latest month of the record), cash/spread
// toggle, every panel, drawn from the golden payloads through a mocked fetch.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SESSION_ENDED, createApi } from "../src/api";
import { DashboardPage } from "../src/pages/DashboardPage";
import { SESSION, goldenFetch } from "./fixtures";

const setup = (overrides: Record<string, () => Response> = {}) => {
  const fake = goldenFetch(overrides);
  const api = createApi({ fetch: fake.fetch, session: SESSION });
  render(<DashboardPage api={api} />);
  return fake;
};
const tile = (name: string) => within(screen.getByRole("group", { name }));

describe("DashboardPage", () => {
  it("draws every panel of the latest month from the golden payloads", async () => {
    setup();

    expect(await screen.findByRole("heading", { name: "Sep 2026" })).toBeTruthy();
    expect(tile("Expenses").getByText("₹75,155.75")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Income, expenses and savings by month" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Spending by category" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "ZQX Goal Hill Trip" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Spreads" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Cash and spread side by side" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Days covered by account and month" })).toBeTruthy();
    expect(screen.getByText("$2.35 of $100.00 this month")).toBeTruthy();
    expect(screen.getByText("Partial month")).toBeTruthy();
  });

  it("defaults to the latest month of the record, and lists the spread-only months too", async () => {
    setup();

    const picker = (await screen.findByLabelText("Month")) as HTMLSelectElement;

    expect(picker.value).toBe("2026-09");
    expect([...picker.options].map((o) => o.value)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
  });

  it("sends the session value with every request", async () => {
    const { calls } = setup();
    await screen.findByRole("heading", { name: "Sep 2026" });

    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const call of calls) expect(call.headers["x-finos-session"]).toBe(SESSION);
    expect(calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        "/api/meta", "/api/summary?spread=0&months=12", "/api/summary?spread=1&months=12",
        "/api/month/2026-09?spread=0", "/api/month/2026-09?spread=1", "/api/goals", "/api/spreads",
        "/api/health",
      ]),
    );
  });

  it("switches the tiles, categories and trend between cash and spread", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sep 2026" });
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveProperty("checked", true);

    await userEvent.click(screen.getByRole("radio", { name: "Spread" }));

    await waitFor(() => expect(tile("Expenses").getByText("₹48,489.08")).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Spread" })).toHaveProperty("checked", true);
    const trend = screen.getByRole("table", { name: "Income, expenses and savings by month" });
    expect(within(trend).getByText("Nov 2026")).toBeTruthy();
  });

  it("loads another month from the picker", async () => {
    const { calls } = setup();
    await screen.findByRole("heading", { name: "Sep 2026" });

    await userEvent.selectOptions(screen.getByLabelText("Month"), "2026-08");

    expect(await screen.findByRole("heading", { name: "Aug 2026" })).toBeTruthy();
    expect(tile("Expenses").getByText("₹500.00")).toBeTruthy();
    expect(tile("Expenses").getByText("No earlier month")).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain("/api/month/2026-08?spread=0");
  });

  it("shows a month that only a spread reaches, and says the cash side has nothing", async () => {
    setup();
    await screen.findByRole("heading", { name: "Sep 2026" });

    await userEvent.click(screen.getByRole("radio", { name: "Spread" }));
    await userEvent.selectOptions(screen.getByLabelText("Month"), "2026-10");

    expect(await screen.findByRole("heading", { name: "Oct 2026" })).toBeTruthy();
    await waitFor(() => expect(tile("Expenses").getByText("₹13,333.33")).toBeTruthy());
    expect(screen.getByText("No cash figures for this month.")).toBeTruthy();
  });

  it("says so when the month cannot be loaded, instead of loading for ever", async () => {
    const broken = () => new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
    setup({ "/api/month/2026-09?spread=0": broken, "/api/month/2026-09?spread=1": broken });

    const panel = await screen.findByRole("region", { name: "Selected month" });

    await waitFor(() => expect(panel.textContent).toContain("Could not load this month."));
    expect(panel.textContent).not.toContain("Loading");
  });

  it("shows a plain error, never the body", async () => {
    setup({
      "/api/health": () =>
        new Response("<html>Error: SELECT secret</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
    });

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("The server could not answer (status 500).");
    expect(alert.textContent).not.toContain("secret");
  });

  it("tells the user to restart when the session ended", async () => {
    setup({ "/api/meta": () => new Response('{"error":"x"}', { status: 403 }) });

    expect((await screen.findByRole("alert")).textContent).toContain(SESSION_ENDED);
    expect(screen.queryByRole("group", { name: "Income" })).toBeNull();
  });

  it("shows an empty record without a crash", async () => {
    const empty = (body: unknown) => () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    setup({
      "/api/meta": empty({ schema_version: "0009_x", months: [], spent_this_month: "0", budget_usd: "100" }),
      "/api/summary?spread=0&months=12": empty([]),
      "/api/summary?spread=1&months=12": empty([]),
    });

    expect(await screen.findByText("No statements are in the record yet.")).toBeTruthy();
    expect(screen.queryByLabelText("Month")).toBeTruthy();
  });
});
