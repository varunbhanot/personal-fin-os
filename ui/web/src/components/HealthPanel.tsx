// E3.3.5: is the record fit to read? Coverage of each account in each month, which months are
// complete, what waits for review, what has no category, which transfer rows are not linked,
// which statements are flagged, and the AI spend against the limit in use on this laptop.
// "Transfer rows not linked" is a different count from the "unpaired" of `finos status`.
import type { Health } from "../../../server/src/api-types";
import { formatInr, formatUsd, monthLabel, toNumber } from "../format";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const account = (source: string, last4: string) => (last4 ? `${source} ••${last4}` : source);
const months = (list: string[]) => (list.length ? list.map(monthLabel).join(", ") : "none");

/** The coverage cells as a grid: one row for each account, one column for each month. */
function grid(coverage: Health["coverage"]) {
  const columns = [...new Set(coverage.map((c) => c.month))].sort();
  const rows = new Map<string, Map<string, string>>();
  for (const c of coverage) {
    const label = account(c.source, c.account_last4);
    const row = rows.get(label) ?? new Map<string, string>();
    row.set(c.month, `${c.days_covered}/${c.days_in_month}`);
    rows.set(label, row);
  }
  return { columns, rows: [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

export function HealthPanel({ health, budgetUsd }: { health: Health; budgetUsd: string }) {
  const { columns, rows } = grid(health.coverage);
  const limit = toNumber(budgetUsd);
  const spent = toNumber(health.ai_spent_this_month);
  const used = limit > 0 ? Math.min(100, Math.round((spent * 100) / limit)) : 100;
  const reached = limit <= 0 || spent >= limit;
  return (
    <div>
      {columns.length > 0 && (
        <div className="scroll-x">
          <table aria-label="Days covered by account and month">
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
                  {columns.map((c) => <td key={c}>{cells.get(c) ?? "–"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>Complete months: {months(health.complete_months)}</p>
      <p>Partial months: {months(health.partial_months)}</p>

      <ul className="facts">
        <li>{plural(health.review_rows, "row waits", "rows wait")} for review, {formatInr(health.review_amount)}</li>
        <li>{plural(health.uncategorised_rows, "row has", "rows have")} no category</li>
        <li>
          {plural(health.unlinked_transfer_rows, "transfer row is", "transfer rows are")} not linked (out{" "}
          {formatInr(health.unlinked_out)}, in {formatInr(health.unlinked_in)})
        </li>
      </ul>
      <p className="muted">Run finos transfers in a cloud session for the detail.</p>

      <h3>Flagged statements</h3>
      {health.flagged_statements.length === 0 ? (
        <p>No statement is flagged.</p>
      ) : (
        <ul className="facts">
          {health.flagged_statements.map((s) => (
            <li key={`${s.source}/${s.account_last4}/${s.period_start}`}>
              {account(s.source, s.account_last4)}, {s.period_start} to {s.period_end}, {plural(s.rows, "row", "rows")}
            </li>
          ))}
        </ul>
      )}

      <h3>AI spend</h3>
      <p>{formatUsd(health.ai_spent_this_month)} of {formatUsd(budgetUsd)} this month</p>
      <div
        className={reached ? "bar over" : "bar"} role="progressbar" aria-label="AI spend against the monthly limit"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}
      >
        <div style={{ width: `${used}%` }} />
      </div>
      {reached && <p className="error">The monthly AI limit is reached.</p>}
      <ul className="facts" aria-label="AI spend by purpose">
        {health.ai_spend.map((s) => (
          <li key={s.purpose}>{s.purpose}: {formatUsd(s.cost_usd, 4)} ({plural(s.calls, "call", "calls")})</li>
        ))}
      </ul>
      <p className="muted">Schema version {health.schema_version}</p>
    </div>
  );
}
