// E3.3.2: the last months of income, expenses and savings as grouped bars. A partial month has
// hollow bars (outline over a faint fill), a "Partial" line in the data table and a note under the chart. The table holds
// the figures for a screen reader. The figures drawn come from the record's decimal strings.
// The chart look (grid, axes, tooltip) is shared with SeriesChart through chartFrame().
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Summary } from "../../../server/src/api-types";
import { formatInr, formatInrCompact, monthLabel, toNumber } from "../format";
import "../styles/dashboard.css";

const SERIES = [
  { key: "income", label: "Income", color: "var(--income)" },
  { key: "expenses", label: "Expenses", color: "var(--expenses)" },
  { key: "savings", label: "Savings", color: "var(--savings)" },
] as const;
const NAME = "Income, expenses and savings by month";
/** A partial month is a hollow bar: a full-colour outline over a faint fill. The outline keeps the
    hue clean on dark, and the hollow shape tells partial from complete without the colour. */
export const PARTIAL_FILL_OPACITY = 0.22;
export function barCell(color: string, complete: boolean) {
  return complete
    ? { fill: color, fillOpacity: 1 }
    : { fill: color, fillOpacity: PARTIAL_FILL_OPACITY, stroke: color, strokeWidth: 1.5 };
}

/** The bar look of both charts: rounded tops, a small gap inside a month. */
export const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
export const CHART_MARGIN = { top: 12, right: 4, bottom: 0, left: 0 };

type TipEntry = { name?: unknown; value?: unknown; color?: string; payload?: { complete?: boolean } };
type TipProps = { active?: boolean; payload?: ReadonlyArray<TipEntry>; label?: unknown };

/** The hover card: an elevated surface, the month, then one line per series in mono. */
export function ChartTooltip({ active, payload, label }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const partial = payload[0]?.payload?.complete === false;
  return (
    <div className="chart-tip">
      <p className="chart-tip-head">
        <span>{String(label ?? "")}</span>
        {partial && <span className="chart-tip-flag">Partial</span>}
      </p>
      <ul className="chart-tip-list">
        {payload.map((entry) => (
          <li key={String(entry.name)}>
            <span className="swatch" style={{ background: entry.color }} aria-hidden="true" />
            <span className="chart-tip-name">{String(entry.name ?? "")}</span>
            <span className="chart-tip-value">{formatInr(Number(entry.value ?? 0).toFixed(2))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal grid lines only, no axis lines, muted mono ticks and the custom tooltip. */
export function chartFrame() {
  const tick = { fill: "var(--muted)", fontSize: 11 };
  return (
    <>
      <CartesianGrid stroke="var(--border)" strokeOpacity={0.7} strokeDasharray="2 4" vertical={false} />
      <XAxis
        dataKey="label" axisLine={false} tickLine={false} tick={tick} tickMargin={10}
        interval="preserveStartEnd"
      />
      <YAxis
        axisLine={false} tickLine={false} tick={tick} width={60} tickMargin={6}
        tickFormatter={(v: number) => formatInrCompact(v)}
      />
      <Tooltip
        content={(props) => <ChartTooltip {...(props as TipProps)} />}
        cursor={{ fill: "var(--row-hover)", stroke: "var(--border-strong)" }}
        wrapperStyle={{ outline: "none" }}
      />
    </>
  );
}

export function TrendChart({ months }: { months: Summary[] }) {
  if (months.length === 0) return <p className="empty">No months in the record yet.</p>;
  const data = months.map((m) => ({
    label: monthLabel(m.month), complete: m.complete,
    income: toNumber(m.income), expenses: toNumber(m.expenses), savings: toNumber(m.savings),
  }));
  return (
    <div className="chart-block">
      <ul className="legend" aria-label="Series">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="chart" role="img" aria-label={`${NAME} (chart)`}>
        <ResponsiveContainer width="100%" height={280} minWidth={0}>
          <BarChart data={data} margin={CHART_MARGIN} barGap={3} barCategoryGap="22%">
            {chartFrame()}
            {SERIES.map((s) => (
              <Bar
                key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={BAR_RADIUS} maxBarSize={22}
                isAnimationActive={false}
              >
                {data.map((d) => (
                  <Cell key={d.label} {...barCell(s.color, d.complete)} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {months.some((m) => !m.complete) && <p className="muted chart-note">Lighter bars are partial months.</p>}
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
