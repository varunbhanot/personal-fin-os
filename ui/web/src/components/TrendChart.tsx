// E3.3.2: the last months of income, expenses and savings as grouped bars. A partial month has
// lighter bars, a "Partial" line in the data table and a note under the chart. The table holds
// the figures for a screen reader. The figures drawn come from the record's decimal strings.
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Summary } from "../../../server/src/api-types";
import { formatInr, formatInrCompact, monthLabel, toNumber } from "../format";

const SERIES = [
  { key: "income", label: "Income", color: "var(--income)" },
  { key: "expenses", label: "Expenses", color: "var(--expenses)" },
  { key: "savings", label: "Savings", color: "var(--savings)" },
] as const;
const NAME = "Income, expenses and savings by month";
const PARTIAL_OPACITY = 0.45;

export function TrendChart({ months }: { months: Summary[] }) {
  if (months.length === 0) return <p className="empty">No months in the record yet.</p>;
  const data = months.map((m) => ({
    label: monthLabel(m.month), complete: m.complete,
    income: toNumber(m.income), expenses: toNumber(m.expenses), savings: toNumber(m.savings),
  }));
  return (
    <div>
      <ul className="legend" aria-label="Series">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="chart" role="img" aria-label={`${NAME} (chart)`}>
        <ResponsiveContainer width="100%" height={260} minWidth={0}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 12 }} interval="preserveStartEnd" />
            <YAxis
              stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 12 }} width={56}
              tickFormatter={(v: number) => formatInrCompact(v)}
            />
            <Tooltip
              formatter={(v) => formatInr(Number(v).toFixed(2))}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
            />
            {SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={d.label} fill={s.color} fillOpacity={d.complete ? 1 : PARTIAL_OPACITY} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {months.some((m) => !m.complete) && <p className="muted">Lighter bars are partial months.</p>}
      <div className="sr-only">
        <table aria-label={NAME}>
          <thead>
            <tr><th>Month</th><th>Income</th><th>Expenses</th><th>Savings</th><th>Status</th></tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td><td>{formatInr(m.income)}</td><td>{formatInr(m.expenses)}</td>
                <td>{formatInr(m.savings)}</td><td>{m.complete ? "Complete" : "Partial"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
