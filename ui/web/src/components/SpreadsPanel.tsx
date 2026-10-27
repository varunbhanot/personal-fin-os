// E3.3.4: the spreads (which row, how much, how many months, from when), and a warning for
// spread and goal rows that add nothing now (a row that became a transfer, lost its category,
// or is no longer an expense). A row ID is the 8 characters that `finos` prints.
import type { Spreads } from "../../../server/src/api-types";
import { formatInr, monthLabel } from "../format";
import { AlertTriangle, Layers } from "./Icons";
import "../styles/panels.css";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function SpreadsPanel({ spreads }: { spreads: Spreads }) {
  const { problems } = spreads;
  return (
    <div className="stack">
      {problems.length > 0 && (
        <div className="warning spread-warning" role="status">
          <AlertTriangle size={18} className="icon" />
          <p>
            {problems.length} spread or goal {plural(problems.length, "row adds", "rows add")} nothing now.{" "}
            {plural(problems.length, "Add it again.", "Add them again.")}
          </p>
          <ul>
            {problems.map((p) => (
              <li key={`${p.what}/${p.id}/${p.row_id}`}>{p.row_id} · {p.what} · {p.state}</li>
            ))}
          </ul>
        </div>
      )}
      {spreads.spreads.length === 0 ? (
        <div className="empty-state panel-empty">
          <span className="empty-state-icon"><Layers size={24} /></span>
          <p className="empty">No spreads yet.</p>
        </div>
      ) : (
        <div className="scroll-x">
          <table className="panel-table" aria-label="Spreads">
            <thead>
              <tr>
                <th className="text">Row</th><th className="text">Date</th><th>Amount</th>
                <th>Months</th><th>Start</th>
              </tr>
            </thead>
            <tbody>
              {spreads.spreads.map((s) => (
                <tr key={s.spread_id}>
                  <td className="text mono">{s.row_id}</td>
                  <td className="text mono">{s.txn_date}</td>
                  <td>
                    {formatInr(s.amount)}
                    {s.direction === "credit" && <>{" "}<span className="badge badge-gold spread-credit">credit</span></>}
                  </td>
                  <td>{s.months}</td>
                  <td>{monthLabel(s.start_month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
