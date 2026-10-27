// E4.2.1: the table of the show_table tool. The server sends columns and rows of plain cells;
// a column named for money is shown in rupees with Indian grouping, "pct" as a percentage,
// "complete" as Complete or Partial, a null as a dash. Every other cell is text, as a text node.
import type { Result } from "../results";
import { formatChange, formatInr, formatPct } from "../format";
import { Inbox } from "./Icons";

const DASH = "–";
const MONEY = new Set([
  "income", "expenses", "savings", "investments", "net", "previous", "amount", "budget", "spent",
  "spent_to_date", "remaining",
]);

/** A column whose cells are figures: right-aligned in the mono face, like the dashboard tables. */
const isFigure = (column: string) => MONEY.has(column) || column === "change" || column === "pct";

function show(column: string, cell: string | number | boolean | null): string {
  if (cell === null) return DASH;
  if (column === "complete" && typeof cell === "boolean") return cell ? "Complete" : "Partial";
  if (typeof cell === "string") {
    if (MONEY.has(column)) return formatInr(cell);
    if (column === "change") return formatChange(cell) ?? DASH;
    if (column === "pct") return formatPct(cell) ?? DASH;
  }
  return String(cell);
}

export function ResultTable({ table }: { table: Result<"show_table"> }) {
  if (table.rows.length === 0) {
    return (
      <div className="empty-state result-empty">
        <span className="empty-state-icon" aria-hidden="true"><Inbox size={22} /></span>
        <p className="empty">No rows.</p>
      </div>
    );
  }
  const cell = (column: string) => (isFigure(column) ? "num" : "text");
  return (
    <div className="result-table">
      <div className="scroll-x result-scroll">
        <table aria-label={table.title}>
          <thead>
            <tr>
              {table.columns.map((column, i) => <th key={i} scope="col" className={cell(column)}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r}>
                {table.columns.map((column, c) => <td key={c} className={cell(column)}>{show(column, row[c] ?? null)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.total > table.rows.length && <p className="muted result-more">Showing {table.rows.length} of {table.total} rows.</p>}
    </div>
  );
}
