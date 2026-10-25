// E3.3.1: four tiles with the month's figure and its change from the month before.
import type { Kpi, Metric, MonthView } from "../../../server/src/api-types";
import { formatChange, formatInr, formatPct, monthLabel } from "../format";

const TILES: [Metric, string][] = [
  ["income", "Income"], ["expenses", "Expenses"], ["savings", "Savings"], ["investments", "Investments"],
];

function Change({ kpi, before }: { kpi: Kpi; before: string | null }) {
  if (kpi.change === null || before === null) return <p className="change muted">No earlier month</p>;
  const pct = formatPct(kpi.pct);
  const negative = kpi.change.startsWith("-");
  const level = !/[1-9]/.test(formatChange(kpi.change) ?? ""); // the rounded figure, as shown
  const arrow = level ? "▬" : negative ? "▼" : "▲";
  const word = level ? "Level with" : negative ? "Down from" : "Up from";
  return (
    <>
      <p className="change">
        <span aria-hidden="true">{arrow} </span>
        <span>{formatChange(kpi.change)}</span>
        {pct !== null && <span> <span>{pct}</span></span>}
      </p>
      {pct === null && <p className="change muted">no % ({monthLabel(before)} was {formatInr(kpi.previous ?? "0")})</p>}
      <p className="change muted">{word} {monthLabel(before)}</p>
    </>
  );
}

/** What the tiles need. A chat result holds only the tiles the model asked for. */
type TilesInput = Pick<MonthView, "complete" | "previous_month"> & { kpis: Partial<Record<Metric, Kpi>> };

export function KpiTiles({ month }: { month: TilesInput }) {
  return (
    <div>
      {!month.complete && <p><span className="badge">Partial month</span></p>}
      <div className="tiles">
        {TILES.map(([metric, label]) => {
          const kpi = month.kpis[metric];
          return kpi && (
            <div className="tile" role="group" aria-label={label} key={metric}>
              <p className="label">{label}</p>
              <p className="value">{formatInr(kpi.value)}</p>
              <Change kpi={kpi} before={month.previous_month} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
