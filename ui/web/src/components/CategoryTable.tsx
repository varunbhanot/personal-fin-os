// E3.3.3: the month's categories in the order the server gives (the list position of
// categories.yaml), with the month before, the change and the percentage. A negative net is a
// refund that was larger than the spending.
import type { CategoryLine } from "../../../server/src/api-types";
import { formatChange, formatInr, formatPct } from "../format";

const KIND: Record<CategoryLine["kind"], string> = {
  income: "Income", expense: "Expense", investment: "Investment", transfer: "Transfer",
};
const DASH = "–";

/** The columns the table draws; a chat result has no row counts or gross figures. */
type Line = Pick<CategoryLine, "kind" | "category" | "net" | "previous" | "change" | "pct">;

export function CategoryTable({ month }: { month: { categories: Line[] } }) {
  if (month.categories.length === 0) return <p className="empty">No categories this month.</p>;
  return (
    <div className="scroll-x">
      <table aria-label="Spending by category">
        <thead>
          <tr>
            <th className="text">Category</th><th className="text">Kind</th><th>Net</th>
            <th>Before</th><th>Change</th><th>%</th>
          </tr>
        </thead>
        <tbody>
          {month.categories.map((line) => (
            <tr key={`${line.kind}/${line.category}`}>
              <td className="text">{line.category}</td>
              <td className="text">{KIND[line.kind] ?? line.kind}</td>
              <td>
                {formatInr(line.net)}
                {line.kind === "expense" && line.net.startsWith("-") && (
                  <span className="muted"> <span>Net refund</span></span>
                )}
              </td>
              <td>{line.previous === null ? DASH : formatInr(line.previous)}</td>
              <td>{formatChange(line.change) ?? DASH}</td>
              <td>{formatPct(line.pct) ?? DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
