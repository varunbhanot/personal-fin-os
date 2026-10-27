// E3.3.1: four tiles with the month's figure and its change from the month before.
// Each tile has an icon, an eyebrow label, the figure in mono and a change line. The change
// line carries an arrow icon, the sign and a word ("Up from"), so colour is never the only signal.
import type { Kpi, Metric, MonthView } from "../../../server/src/api-types";
import { formatChange, formatInr, formatPct, monthLabel } from "../format";
import { ArrowDownRight, ArrowUpRight, Coins, Icon, PiggyBank, TrendingUp, Wallet, type IconProps } from "./Icons";
import "../styles/dashboard.css";

const TILES: [Metric, string, (props: IconProps) => React.JSX.Element][] = [
  ["income", "Income", Wallet], ["expenses", "Expenses", Coins],
  ["savings", "Savings", PiggyBank], ["investments", "Investments", TrendingUp],
];

const Level = (props: IconProps) => <Icon {...props}><path d="M5 12h14" /></Icon>;

function Change({ metric, kpi, before }: { metric: Metric; kpi: Kpi; before: string | null }) {
  if (kpi.change === null || before === null) return <p className="change muted">No earlier month</p>;
  const pct = formatPct(kpi.pct);
  const negative = kpi.change.startsWith("-");
  const level = !/[1-9]/.test(formatChange(kpi.change) ?? ""); // the rounded figure, as shown
  const Arrow = level ? Level : negative ? ArrowDownRight : ArrowUpRight;
  const word = level ? "Level with" : negative ? "Down from" : "Up from";
  // More spending is the bad direction; for the other figures, more is good.
  const good = metric === "expenses" ? negative : !negative;
  const tone = level ? "tone-level" : good ? "tone-good" : "tone-bad";
  return (
    <>
      <p className={`change change-line ${tone}`}>
        <Arrow size={14} />
        <span>{formatChange(kpi.change)}</span>
        {pct !== null && <span className="change-pct"> <span>{pct}</span></span>}
      </p>
      {pct === null && <p className="change muted">no % ({monthLabel(before)} was {formatInr(kpi.previous ?? "0")})</p>}
      <p className="change muted change-word">{word} {monthLabel(before)}</p>
    </>
  );
}

/** What the tiles need. A chat result holds only the tiles the model asked for. */
type TilesInput = Pick<MonthView, "complete" | "previous_month"> & { kpis: Partial<Record<Metric, Kpi>> };

export function KpiTiles({ month }: { month: TilesInput }) {
  return (
    <div className="kpis">
      {!month.complete && <p className="kpis-note"><span className="badge">Partial month</span></p>}
      <div className="tiles">
        {TILES.map(([metric, label, Glyph]) => {
          const kpi = month.kpis[metric];
          return kpi && (
            <div className={`tile kpi kpi-${metric}`} role="group" aria-label={label} key={metric}>
              <div className="tile-head">
                <span className="icon-chip kpi-chip"><Glyph size={16} /></span>
                <p className="label eyebrow">{label}</p>
              </div>
              <p className="value">{formatInr(kpi.value)}</p>
              <Change metric={metric} kpi={kpi} before={month.previous_month} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
