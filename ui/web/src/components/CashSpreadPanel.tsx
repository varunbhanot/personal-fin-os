// E3.3.4: the month's cash and spread figures side by side, and what the spreads move
// (spread minus cash).
import type { Metric, MonthView } from "../../../server/src/api-types";
import { formatChange, formatInr, subtract } from "../format";

const ROWS: [Metric, string][] = [
  ["income", "Income"], ["expenses", "Expenses"], ["savings", "Savings"], ["investments", "Investments"],
];

export function CashSpreadPanel({ cash, spread }: { cash: MonthView | null; spread: MonthView | null }) {
  if (!cash || !spread) {
    const missing = !cash && !spread ? "No" : !cash ? "No cash" : "No spread";
    return <p className="empty">{missing} figures for this month.</p>;
  }
  return (
    <div className="scroll-x">
      <table aria-label="Cash and spread side by side">
        <thead>
          <tr><th className="text">Figure</th><th>Cash</th><th>Spread</th><th>Difference</th></tr>
        </thead>
        <tbody>
          {ROWS.map(([metric, label]) => (
            <tr key={metric}>
              <td className="text">{label}</td>
              <td>{formatInr(cash.kpis[metric].value)}</td>
              <td>{formatInr(spread.kpis[metric].value)}</td>
              <td>{formatChange(subtract(spread.kpis[metric].value, cash.kpis[metric].value))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
