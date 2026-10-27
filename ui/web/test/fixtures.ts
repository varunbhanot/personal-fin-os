// Synthetic props and payloads for the web tests: the golden record of tests/ui_golden (the
// synthetic seed of tests/test_ui_views.py), never real figures.
import type {
  Goal, Health, Meta, MonthView, Spreads, Summary,
} from "../../server/src/api-types";
import golden from "../../../tests/ui_golden/expected.json";

export const SESSION = "s".repeat(43);

export const cashMonths = golden.months.cash as unknown as Summary[];
export const spreadMonths = golden.months.spread as unknown as Summary[];
export const monthView = (name: "cash" | "spread", month: string): MonthView =>
  (golden.month[name] as unknown as Record<string, MonthView>)[month]!;
export const goalsFixture = golden.goals as unknown as Goal[];
export const spreads = golden.spreads as unknown as Spreads;
export const health = golden.health as unknown as Health;
export const meta: Meta = {
  schema_version: golden.health.schema_version,
  months: cashMonths.map((m) => m.month),
  spent_this_month: golden.health.ai_spent_this_month,
  budget_usd: "100",
};

export type Call = { url: string; headers: Record<string, string>; init: RequestInit };

/** A fetch that answers the /api routes from the golden payloads, and records each call. */
export function goldenFetch(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), init });
    const override = overrides[url];
    if (override) return override();
    const { pathname, searchParams } = new URL(url, "http://127.0.0.1:8765");
    const name = searchParams.get("spread") === "1" ? "spread" : "cash";
    if (pathname === "/api/meta") return json(meta);
    if (pathname === "/api/summary") return json(name === "spread" ? spreadMonths : cashMonths);
    if (pathname.startsWith("/api/month/")) {
      const found = (golden.month[name] as unknown as Record<string, MonthView>)[pathname.slice(11)];
      return found ? json(found) : json({ error: "No statement covers that month." }, 404);
    }
    if (pathname === "/api/goals") return json(goalsFixture);
    if (pathname === "/api/spreads") return json(spreads);
    if (pathname === "/api/health") return json(health);
    return json({ error: "Not found." }, 404);
  }) as typeof fetch;
  return { fetch: fake, calls };
}
