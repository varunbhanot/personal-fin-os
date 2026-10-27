// E3.3.3: the month's categories in the order the server gives (the list position of
// categories.yaml), with the month before, the change and the percentage. A negative net is a
// refund that was larger than the spending.
import type { CategoryLine } from "../../../server/src/api-types";
import { formatChange, formatInr, formatPct, toNumber } from "../format";
import { Inbox } from "./Icons";
import "../styles/panels.css";

const KIND: Record<CategoryLine["kind"], string> = {
  income: "Income", expense: "Expense", investment: "Investment", transfer: "Transfer",
};
const DASH = "–";

/** The columns the table draws; a chat result has no row counts or gross figures. */
type Line = Pick<CategoryLine, "kind" | "category" | "net" | "previous" | "change" | "pct">;

/** The largest absolute net of each kind: the share bar of a row is relative to it. */
function largestByKind(lines: Line[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    const size = Math.abs(toNumber(line.net));
    out.set(line.kind, Math.max(out.get(line.kind) ?? 0, size));
  }
  return out;
}

export function CategoryTable({ month }: { month: { categories: Line[] } }) {
  if (month.categories.length === 0) {
    return (
      <div className="empty-state panel-empty">
        <span className="empty-state-icon"><Inbox size={24} /></span>
        <p className="empty">No categories this month.</p>
      </div>
    );
  }
  const largest = largestByKind(month.categories);
  return (
    <div className="scroll-x">
      <table className="panel-table" aria-label="Spending by category">
        <thead>
          <tr>
            <th className="text">Category</th><th className="text hide-narrow">Kind</th><th>Net</th>
            <th className="hide-narrow">Before</th><th>Change</th><th className="hide-narrow">%</th>
          </tr>
        </thead>
        <tbody>
          {month.categories.map((line) => {
            const max = largest.get(line.kind) ?? 0;
            const share = max > 0 ? Math.round((Math.abs(toNumber(line.net)) * 100) / max) : 0;
            const refund = line.kind === "expense" && line.net.startsWith("-");
            return (
              <tr key={`${line.kind}/${line.category}`}>
                <td className="text">
                  <span className="cat-name">
                    <span>{line.category}</span>
                    <span className={refund ? "cat-share is-refund" : "cat-share"} aria-hidden="true">
                      <span style={{ width: `${share}%` }} />
                    </span>
                  </span>
                </td>
                <td className="text hide-narrow"><span className="badge badge-neutral cat-kind">{KIND[line.kind] ?? line.kind}</span></td>
                <td>
                  {formatInr(line.net)}
                  {refund && (
                    <span className="muted"> <span className="badge badge-gold cat-refund">Net refund</span></span>
                  )}
                </td>
                <td className="hide-narrow">{line.previous === null ? DASH : formatInr(line.previous)}</td>
                <td>{formatChange(line.change) ?? DASH}</td>
                <td className="hide-narrow">{formatPct(line.pct) ?? DASH}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
