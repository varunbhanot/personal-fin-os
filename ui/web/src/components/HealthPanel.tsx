// E3.3.5: is the record fit to read? Coverage of each account in each month, which months are
// complete, what waits for review, what has no category, which transfer rows are not linked,
// which statements are flagged, and the AI spend against the limit in use on this laptop.
// "Transfer rows not linked" is a different count from the "unpaired" of `finos status`.
import type { ReactNode } from "react";
import type { Health } from "../../../server/src/api-types";
import { formatInr, formatUsd, monthLabel, toNumber } from "../format";
import { AlertTriangle, Calendar, CheckCircle, Coins, Database, Sparkles } from "./Icons";
import "../styles/panels.css";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const account = (source: string, last4: string) => (last4 ? `${source} ••${last4}` : source);
const months = (list: string[]) => (list.length ? list.map(monthLabel).join(", ") : "none");

type Cell = { text: string; state: "is-full" | "is-part" | "is-none" };

/** The coverage cells as a grid: one row for each account, one column for each month. */
function grid(coverage: Health["coverage"]) {
  const columns = [...new Set(coverage.map((c) => c.month))].sort();
  const rows = new Map<string, Map<string, Cell>>();
  for (const c of coverage) {
    const label = account(c.source, c.account_last4);
    const row = rows.get(label) ?? new Map<string, Cell>();
    const state = c.days_covered <= 0 ? "is-none" : c.days_covered >= c.days_in_month ? "is-full" : "is-part";
    row.set(c.month, { text: `${c.days_covered}/${c.days_in_month}`, state });
    rows.set(label, row);
  }
  return { columns, rows: [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

/** One line of the status list: an icon and a badge in words, so colour is not the only signal. */
function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li>
      {ok ? <CheckCircle size={18} className="icon is-ok" /> : <AlertTriangle size={18} className="icon is-warn" />}
      <span className="status-text">{children}</span>
      {ok ? <span className="badge badge-ok">OK</span> : <span className="badge badge-warn">Check</span>}
    </li>
  );
}

export function HealthPanel({ health, budgetUsd }: { health: Health; budgetUsd: string }) {
  const { columns, rows } = grid(health.coverage);
  const limit = toNumber(budgetUsd);
  const spent = toNumber(health.ai_spent_this_month);
  const used = limit > 0 ? Math.min(100, Math.round((spent * 100) / limit)) : 100;
  const reached = limit <= 0 || spent >= limit;
  return (
    <div className="health">
      <div className="health-section">
        <h3><Calendar size={16} />Coverage</h3>
        {columns.length > 0 && (
          <div className="scroll-x">
            <table className="panel-table coverage" aria-label="Days covered by account and month">
              <thead>
                <tr>
                  <th className="text">Account</th>
                  {columns.map((c) => <th key={c}>{monthLabel(c)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, cells]) => (
                  <tr key={label}>
                    <td className="text">{label}</td>
                    {columns.map((c) => {
                      const cell = cells.get(c);
                      return (
                        <td key={c} className="cov">
                          <span className={`cov-cell ${cell?.state ?? "is-none"}`}>{cell?.text ?? "–"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="month-lines">
          <p>
            {health.complete_months.length > 0
              ? <CheckCircle size={16} className="icon pos" />
              : <AlertTriangle size={16} className="icon muted" />}
            <span>Complete months: {months(health.complete_months)}</span>
          </p>
          <p>
            <Calendar size={16} className="icon muted" />
            <span>Partial months: {months(health.partial_months)}</span>
          </p>
        </div>
      </div>

      <div className="health-cols">
        <div className="health-section">
          <h3><Database size={16} />Record</h3>
          <ul className="status-list">
            <Status ok={health.review_rows === 0}>
              {plural(health.review_rows, "row waits", "rows wait")} for review, {formatInr(health.review_amount)}
            </Status>
            <Status ok={health.uncategorised_rows === 0}>
              {plural(health.uncategorised_rows, "row has", "rows have")} no category
            </Status>
            <Status ok={health.unlinked_transfer_rows === 0}>
              {plural(health.unlinked_transfer_rows, "transfer row is", "transfer rows are")} not linked (out{" "}
              {formatInr(health.unlinked_out)}, in {formatInr(health.unlinked_in)})
            </Status>
          </ul>
          <p className="muted health-note">Run finos transfers in a cloud session for the detail.</p>

          <h3><AlertTriangle size={16} />Flagged statements</h3>
          {health.flagged_statements.length === 0 ? (
            <ul className="status-list">
              <Status ok>No statement is flagged.</Status>
            </ul>
          ) : (
            <ul className="status-list">
              {health.flagged_statements.map((s) => (
                <li key={`${s.source}/${s.account_last4}/${s.period_start}`}>
                  <AlertTriangle size={18} className="icon is-danger" />
                  <span className="status-text">
                    {account(s.source, s.account_last4)}, {s.period_start} to {s.period_end}, {plural(s.rows, "row", "rows")}
                  </span>
                  <span className="badge badge-danger">Flagged</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="health-section">
          <h3><Sparkles size={16} />AI spend</h3>
          <p className="ai-spend-figure">{formatUsd(health.ai_spent_this_month)} of {formatUsd(budgetUsd)} this month</p>
          <div
            className={reached ? "bar over" : "bar"} role="progressbar" aria-label="AI spend against the monthly limit"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}
          >
            <div style={{ width: `${used}%` }} />
          </div>
          {reached && <p className="error">The monthly AI limit is reached.</p>}
          <ul className="facts ai-purposes" aria-label="AI spend by purpose">
            {health.ai_spend.map((s) => (
              <li key={s.purpose}>{s.purpose}: {formatUsd(s.cost_usd, 4)} ({plural(s.calls, "call", "calls")})</li>
            ))}
          </ul>
          <p className="muted health-footer">
            <Coins size={14} className="icon" /> <span className="health-version">Schema version {health.schema_version}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
