// E4.2.1: the chart of the show_chart tool: bars or lines over months, one series for each
// metric or one for a category. Same look and the same rules as TrendChart: a partial month is
// lighter and named under the chart, and a data table holds the figures for a screen reader.
import { Bar, BarChart, Cell, Line, LineChart, ResponsiveContainer } from "recharts";
import type { Result } from "../results";
import { formatInr, monthLabel, toNumber } from "../format";
import { BAR_RADIUS, CHART_MARGIN, PARTIAL_FILL_OPACITY, barCell, chartFrame } from "./TrendChart";
import "../styles/dashboard.css";

const COLORS: Record<string, string> = {
  income: "var(--income)", expenses: "var(--expenses)", savings: "var(--savings)", investments: "var(--investments)",
};
const FALLBACK = ["var(--accent)", "var(--expenses)", "var(--savings)", "var(--investments)"];
const day = (month: string) => `${month}-01`;

export function SeriesChart({ chart }: { chart: Result<"show_chart"> }) {
  const series = chart.series.filter((s) => s.points.length > 0);
  if (series.length === 0) return <p className="empty">No figures to chart.</p>;
  const colour = (name: string, index: number) => COLORS[name] ?? FALLBACK[index % FALLBACK.length]!;
  const months = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const partial = new Set(series.flatMap((s) => s.points.filter((p) => !p.complete).map((p) => p.x)));
  const data = months.map((x) => ({
    label: monthLabel(day(x)), complete: !partial.has(x),
    ...Object.fromEntries(series.map((s) => [s.name, toNumber(s.points.find((p) => p.x === x)?.y ?? "0")])),
  }));
  const shown = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
  const axes = chartFrame();
  const margin = CHART_MARGIN;
  return (
    <div className="chart-block">
      <ul className="legend" aria-label="Series">
        {series.map((s, i) => (
          <li key={s.name}>
            <span className="swatch" style={{ background: colour(s.name, i) }} aria-hidden="true" />
            {shown(s.name)}
          </li>
        ))}
      </ul>
      <div className="chart" role="img" aria-label={`${chart.title} (chart)`}>
        <ResponsiveContainer width="100%" height={240} minWidth={0}>
          {chart.chart === "bar" ? (
            <BarChart data={data} margin={margin} barGap={3} barCategoryGap="22%">
              {axes}
              {series.map((s, i) => (
                <Bar key={s.name} dataKey={s.name} name={shown(s.name)} fill={colour(s.name, i)} radius={BAR_RADIUS}
                  maxBarSize={22} isAnimationActive={false}>
                  {data.map((d) => (
                    <Cell key={d.label} {...barCell(colour(s.name, i), d.complete)} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          ) : (
            <LineChart data={data} margin={margin}>
              {axes}
              {series.map((s, i) => (
                <Line
                  key={s.name} dataKey={s.name} name={shown(s.name)} stroke={colour(s.name, i)} strokeWidth={2.25}
                  isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; index?: number; key?: React.Key | null }) => {
                    // A partial month is a hollow point: a full-colour ring over a faint fill.
                    const partialPoint = data[p.index ?? 0]?.complete === false;
                    return (
                      <circle
                        key={p.key ?? p.index ?? 0} cx={p.cx} cy={p.cy} r={4} fill={colour(s.name, i)}
                        stroke={partialPoint ? colour(s.name, i) : "var(--surface)"} strokeWidth={partialPoint ? 1.75 : 2}
                        fillOpacity={partialPoint ? PARTIAL_FILL_OPACITY : 1}
                      />
                    );
                  }}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      {partial.size > 0 && (
        <p className="muted chart-note">
          Lighter {chart.chart === "bar" ? "bars" : "points"} are partial months: {[...partial].sort().map((x) => monthLabel(day(x))).join(", ")}.
        </p>
      )}
      <div className="sr-only">
        <table aria-label={chart.title}>
          <thead>
            <tr><th>Month</th>{series.map((s) => <th key={s.name}>{shown(s.name)}</th>)}<th>Status</th></tr>
          </thead>
          <tbody>
            {months.map((x) => (
              <tr key={x}>
                <td>{monthLabel(day(x))}</td>
                {series.map((s) => <td key={s.name}>{formatInr(s.points.find((p) => p.x === x)?.y ?? "0")}</td>)}
                <td>{partial.has(x) ? "Partial" : "Complete"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
