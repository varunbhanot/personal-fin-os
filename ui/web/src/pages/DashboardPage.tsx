// E3.4: the dashboard. A month picker (default: the latest month of the record), a cash or
// spread toggle, and the panels. Each panel loads on its own, so one failed request does not
// blank the others; the messages of the failures show once, as plain text.
import { useEffect, useState, type CSSProperties } from "react";
import type { Goal, Health, Meta, MonthView, Spreads, Summary } from "../../../server/src/api-types";
import { ApiError, type Api } from "../api";
import { CashSpreadPanel } from "../components/CashSpreadPanel";
import { CategoryTable } from "../components/CategoryTable";
import { GoalsPanel } from "../components/GoalsPanel";
import { HealthPanel } from "../components/HealthPanel";
import {
  AlertTriangle, BarChart, Calendar, ChevronDown, Clock, Inbox, Info, LayoutDashboard, Layers, ShieldCheck, Table, Target,
} from "../components/Icons";
import { KpiTiles } from "../components/KpiTiles";
import { SpreadsPanel } from "../components/SpreadsPanel";
import { TrendChart } from "../components/TrendChart";
import { monthLabel, monthOf } from "../format";
import "../styles/dashboard.css";

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

  const basis = spread ? "Spread" : "Cash";
  const waiting = errors.length === 0;
  const monthReady = monthData !== null && monthData.month === month;
  // The month panels shimmer while the month loads, but not for an empty record or a failure.
  const monthPending = waiting && !monthReady && monthFailed !== month && (month !== null || loaded.meta === null);

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="dash-heading">
          <span className="icon-chip dash-heading-icon"><LayoutDashboard size={18} /></span>
          <div className="dash-heading-text">
            <p className="eyebrow">Household record</p>
            <h2 className="page-title">Overview</h2>
            <p className="muted dash-subtitle">
              {month !== null ? (
                <><Calendar size={14} /> <span className="mono">{monthLabel(`${month}-01`)}</span> · {basis} basis</>
              ) : loaded.meta === null && waiting ? "Reading the record" : "Income, spending, goals and data health"}
            </p>
          </div>
        </div>

        {loaded.meta === null ? (
          waiting && (
            <div className="dash-toolbar is-loading" aria-hidden="true">
              <span className="skeleton-line dash-sk-field" />
              <span className="skeleton-line dash-sk-toggle" />
            </div>
          )
        ) : (
          <div className="controls dash-toolbar">
            <div className="field dash-field">
              <label htmlFor="month">Month</label>
              <div className="select-wrap">
                <select id="month" value={month ?? ""} disabled={options.length === 0} onChange={(e) => setPicked(e.target.value)}>
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <ChevronDown size={16} className="select-caret" />
              </div>
            </div>
            <div className="field dash-field">
              <span className="field-label" aria-hidden="true">Basis</span>
              <div className="toggle" role="radiogroup" aria-label="Basis">
                {([["Cash", false], ["Spread", true]] as const).map(([label, value]) => (
                  <label key={label}>
                    <input type="radio" name="basis" checked={spread === value} onChange={() => setSpread(value)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </header>

      {errors.length > 0 && (
        <div className="panel error dash-alert" role="alert">
          <span className="dash-alert-icon"><AlertTriangle size={18} /></span>
          <div className="dash-alert-body">
            {errors.map((text) => <p key={text}>{text}</p>)}
          </div>
        </div>
      )}

      {loaded.meta === null && waiting && <span className="sr-only" role="status">Loading…</span>}

      {loaded.meta !== null && loaded.meta.months.length === 0 && (
        <section className="panel empty-state dash-empty" aria-label="Empty record">
          <span className="empty-state-icon"><Inbox size={26} /></span>
          <p className="empty">No statements are in the record yet.</p>
          <p className="muted">Run an import in a cloud session, then reload this page.</p>
        </section>
      )}

      <div className="grid-12 dash-grid">
        {month !== null ? (
          <section className="panel span-12 rise dash-month" style={rise(0)} aria-label="Selected month">
            {monthReady ? (
              <>
                <h2 className="panel-title">
                  <span className="icon-chip"><Calendar size={16} /></span>
                  {monthLabel(`${month}-01`)}
                </h2>
                {view ? (
                  <KpiTiles month={view} />
                ) : (
                  <div className="empty-state dash-inline-empty">
                    <span className="empty-state-icon"><Info size={22} /></span>
                    <p className="empty">
                      No {spread ? "spread" : "cash"} figures for this month. Switch the basis to see the other.
                    </p>
                  </div>
                )}
              </>
            ) : monthFailed === month ? (
              <div className="empty-state is-error dash-inline-empty">
                <span className="empty-state-icon"><AlertTriangle size={22} /></span>
                <p className="empty">Could not load this month.</p>
              </div>
            ) : (
              <TilesSkeleton />
            )}
          </section>
        ) : (
          loaded.meta === null && waiting && (
            <section className="panel span-12 dash-month" aria-hidden="true"><TilesSkeleton /></section>
          )
        )}

        {loaded.cash !== null && loaded.spread !== null ? (
          <section className="panel span-6 rise" style={rise(1)}>
            <h2 className="panel-title"><span className="icon-chip"><BarChart size={16} /></span>Trend</h2>
            <TrendChart months={trend} />
          </section>
        ) : waiting && <PanelSkeleton span="span-6" chart />}

        {monthReady ? (
          <section className="panel span-6 rise" style={rise(2)}>
            <h2 className="panel-title"><span className="icon-chip"><Layers size={16} /></span>Cash and spread</h2>
            <CashSpreadPanel cash={monthData.cash} spread={monthData.spread} />
          </section>
        ) : monthPending && <PanelSkeleton span="span-6" />}

        {view ? (
          <section className="panel span-12 rise" style={rise(3)}>
            <h2 className="panel-title"><span className="icon-chip"><Table size={16} /></span>Categories</h2>
            <CategoryTable month={view} />
          </section>
        ) : monthPending && <PanelSkeleton span="span-12" />}

        {loaded.goals !== null ? (
          <section className="panel span-5 rise" style={rise(4)}>
            <h2 className="panel-title"><span className="icon-chip"><Target size={16} /></span>Goals</h2>
            <GoalsPanel goals={loaded.goals} />
          </section>
        ) : waiting && <PanelSkeleton span="span-5" />}

        {loaded.spreads !== null ? (
          <section className="panel span-7 rise" style={rise(5)}>
            <h2 className="panel-title"><span className="icon-chip"><Clock size={16} /></span>Spreads</h2>
            <SpreadsPanel spreads={loaded.spreads} />
          </section>
        ) : waiting && <PanelSkeleton span="span-7" />}

        {loaded.health !== null && loaded.meta !== null ? (
          <section className="panel span-12 rise" style={rise(6)}>
            <h2 className="panel-title"><span className="icon-chip"><ShieldCheck size={16} /></span>Data health</h2>
            <HealthPanel health={loaded.health} budgetUsd={loaded.meta.budget_usd} />
          </section>
        ) : waiting && <PanelSkeleton span="span-12" />}
      </div>
    </div>
  );
}

/** The entry stagger: 80ms per card (theme.css .rise reads --i). */
const rise = (i: number) => ({ "--i": i }) as CSSProperties;

/** Four tiles of shimmer, the size of the real KPI tiles. */
function TilesSkeleton() {
  return (
    <div className="dash-skeleton" aria-hidden="true">
      <span className="skeleton-line dash-sk-title" />
      <div className="tiles">
        {[0, 1, 2, 3].map((i) => (
          <div className="tile dash-sk-tile" key={i}>
            <span className="skeleton-line dash-sk-label" />
            <span className="skeleton-line dash-sk-value" />
            <span className="skeleton-line dash-sk-change" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A card of shimmer while one panel loads: a title line, then a chart block or text lines. */
function PanelSkeleton({ span, chart = false }: { span: string; chart?: boolean }) {
  return (
    <div className={`panel ${span} dash-skeleton`} aria-hidden="true">
      <span className="skeleton-line dash-sk-title" />
      {chart ? (
        <span className="skeleton-block dash-sk-chart" />
      ) : (
        <>
          <span className="skeleton-line" />
          <span className="skeleton-line dash-sk-short" />
          <span className="skeleton-line" />
          <span className="skeleton-line dash-sk-short" />
        </>
      )}
    </div>
  );
}
