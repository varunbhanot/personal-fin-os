// E3.3.4: the month's cash and spread figures side by side, and what the spreads move
// (spread minus cash).
import type { Metric, MonthView } from "../../../server/src/api-types";
import { formatChange, formatInr, subtract, toNumber } from "../format";
import { Coins } from "./Icons";
import "../styles/panels.css";

const ROWS: [Metric, string][] = [
  ["income", "Income"], ["expenses", "Expenses"], ["savings", "Savings"], ["investments", "Investments"],
];

export function CashSpreadPanel({ cash, spread }: { cash: MonthView | null; spread: MonthView | null }) {
  if (!cash || !spread) {
    const missing = !cash && !spread ? "No" : !cash ? "No cash" : "No spread";
    return (
      <div className="empty-state panel-empty">
        <span className="empty-state-icon"><Coins size={24} /></span>
        <p className="empty">{missing} figures for this month.</p>
      </div>
    );
  }
  return (
    <div className="scroll-x">
      <table className="panel-table" aria-label="Cash and spread side by side">
        <thead>
          <tr><th className="text">Figure</th><th>Cash</th><th>Spread</th><th>Difference</th></tr>
        </thead>
        <tbody>
          {ROWS.map(([metric, label]) => {
            const diff = subtract(spread.kpis[metric].value, cash.kpis[metric].value);
            return (
              <tr key={metric}>
                <td className="text">
                  <span className="metric-name">
                    <span className={`swatch s-${metric}`} aria-hidden="true" />
                    <span>{label}</span>
                  </span>
                </td>
                <td>{formatInr(cash.kpis[metric].value)}</td>
                <td>{formatInr(spread.kpis[metric].value)}</td>
                <td className={toNumber(diff) === 0 ? "diff-zero" : undefined}>{formatChange(diff)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
