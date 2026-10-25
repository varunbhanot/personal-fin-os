// E3.4: the dashboard. A month picker (default: the latest month of the record), a cash or
// spread toggle, and the panels. Each panel loads on its own, so one failed request does not
// blank the others; the messages of the failures show once, as plain text.
import { useEffect, useState } from "react";
import type { Goal, Health, Meta, MonthView, Spreads, Summary } from "../../../server/src/api-types";
import { ApiError, type Api } from "../api";
import { CashSpreadPanel } from "../components/CashSpreadPanel";
import { CategoryTable } from "../components/CategoryTable";
import { GoalsPanel } from "../components/GoalsPanel";
import { HealthPanel } from "../components/HealthPanel";
import { KpiTiles } from "../components/KpiTiles";
import { SpreadsPanel } from "../components/SpreadsPanel";
import { TrendChart } from "../components/TrendChart";
import { monthLabel, monthOf } from "../format";

const TREND_MONTHS = 12;

type Loaded = {
  meta: Meta | null; cash: Summary[] | null; spread: Summary[] | null;
  goals: Goal[] | null; spreads: Spreads | null; health: Health | null;
};
type MonthData = { month: string; cash: MonthView | null; spread: MonthView | null };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const message = (e: unknown) => (e instanceof ApiError ? e.message : "The page could not load this part.");

export function DashboardPage({ api }: { api: Api }) {
  const [loaded, setLoaded] = useState<Loaded>({
    meta: null, cash: null, spread: null, goals: null, spreads: null, health: null,
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [spread, setSpread] = useState(false);
  const [monthData, setMonthData] = useState<MonthData | null>(null);
  const [monthFailed, setMonthFailed] = useState<string | null>(null);

  const fail = (e: unknown) => {
    if (!isAbort(e)) setErrors((old) => (old.includes(message(e)) ? old : [...old, message(e)]));
  };

  useEffect(() => {
    const abort = new AbortController();
    const part = <K extends keyof Loaded>(key: K, load: Promise<NonNullable<Loaded[K]>>) =>
      load.then((value) => setLoaded((old) => ({ ...old, [key]: value })), fail);
    void part("meta", api.meta(abort.signal));
    void part("cash", api.summary({ spread: false, months: TREND_MONTHS }, abort.signal));
    void part("spread", api.summary({ spread: true, months: TREND_MONTHS }, abort.signal));
    void part("goals", api.goals(abort.signal));
    void part("spreads", api.spreads(abort.signal));
    void part("health", api.health(abort.signal));
    return () => abort.abort();
  }, [api]);

  // The default month is the latest one that has statements (cash), not a spread-only month.
  const months = loaded.meta?.months ?? null;
  const month = picked ?? (months && months.length > 0 ? monthOf(months[months.length - 1]!) : null);

  useEffect(() => {
    if (month === null) return;
    setMonthFailed(null);
    const abort = new AbortController();
    // A month that only one side reaches answers 404: that side is null.
    const side = (basis: boolean) =>
      api.month(month, { spread: basis }, abort.signal).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
    Promise.all([side(false), side(true)]).then(([cash, spreadView]) => {
      setMonthData({ month, cash, spread: spreadView });
    }, (e: unknown) => {
      fail(e);
      if (!isAbort(e)) setMonthFailed(month);
    });
    return () => abort.abort();
  }, [api, month]);

  const options = [
    ...new Set([...(months ?? []), ...(loaded.spread ?? []).map((m) => m.month)].map(monthOf)),
  ].sort();
  const view = monthData && monthData.month === month ? (spread ? monthData.spread : monthData.cash) : undefined;
  const trend = (spread ? loaded.spread : loaded.cash) ?? [];

  return (
    <div>
      {errors.length > 0 && (
        <div className="panel error" role="alert">
          {errors.map((text) => <p key={text}>{text}</p>)}
        </div>
      )}
      {loaded.meta === null ? (
        errors.length === 0 && <p className="muted">Loading…</p>
      ) : (
        <div className="controls">
          <label htmlFor="month">Month</label>
          <select id="month" value={month ?? ""} disabled={options.length === 0} onChange={(e) => setPicked(e.target.value)}>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <div className="toggle" role="radiogroup" aria-label="Basis">
            {([["Cash", false], ["Spread", true]] as const).map(([label, value]) => (
              <label key={label}>
                <input type="radio" name="basis" checked={spread === value} onChange={() => setSpread(value)} />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      {loaded.meta !== null && loaded.meta.months.length === 0 && (
        <p className="empty">No statements are in the record yet.</p>
      )}

      <div className="grid">
        {month !== null && (
          <section className="panel wide" aria-label="Selected month">
            {monthData && monthData.month === month ? (
              <>
                <h2>{monthLabel(`${month}-01`)}</h2>
                {view ? (
                  <KpiTiles month={view} />
                ) : (
                  <p className="empty">
                    No {spread ? "spread" : "cash"} figures for this month. Switch the basis to see the other.
                  </p>
                )}
              </>
            ) : monthFailed === month ? (
              <p className="empty">Could not load this month.</p>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </section>
        )}
        {loaded.cash !== null && loaded.spread !== null && (
          <section className="panel wide">
            <h2>Trend</h2>
            <TrendChart months={trend} />
          </section>
        )}
        {view && (
          <section className="panel wide">
            <h2>Categories</h2>
            <CategoryTable month={view} />
          </section>
        )}
        {monthData && monthData.month === month && (
          <section className="panel">
            <h2>Cash and spread</h2>
            <CashSpreadPanel cash={monthData.cash} spread={monthData.spread} />
          </section>
        )}
        {loaded.goals !== null && (
          <section className="panel">
            <h2>Goals</h2>
            <GoalsPanel goals={loaded.goals} />
          </section>
        )}
        {loaded.spreads !== null && (
          <section className="panel">
            <h2>Spreads</h2>
            <SpreadsPanel spreads={loaded.spreads} />
          </section>
        )}
        {loaded.health !== null && loaded.meta !== null && (
          <section className="panel wide">
            <h2>Data health</h2>
            <HealthPanel health={loaded.health} budgetUsd={loaded.meta.budget_usd} />
          </section>
        )}
      </div>
    </div>
  );
}
