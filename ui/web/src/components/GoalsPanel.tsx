// E3.3.4: each goal with its budget, spent, remaining and a bar, and its month lines. The
// name is the household's own text (browser only; the agent never sees it): a text node.
import type { Goal } from "../../../server/src/api-types";
import { formatInr, monthLabel, toNumber } from "../format";

/** Spent as a whole percent of the budget, from 0 to 100 (a bar length, not a figure). */
function percent(goal: Goal): number {
  const budget = toNumber(goal.budget);
  if (budget <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((toNumber(goal.spent) * 100) / budget)));
}

export function GoalsPanel({ goals }: { goals: Goal[] }) {
  if (goals.length === 0) return <p className="empty">No goals yet.</p>;
  return (
    <div>
      {goals.map((goal) => {
        const over = goal.remaining.startsWith("-");
        return (
          <div className="goal" role="group" aria-label={goal.name} key={goal.goal_id}>
            <h3>{goal.name}</h3>
            <dl className="facts">
              <div><dt className="muted">Budget</dt><dd>{formatInr(goal.budget)}</dd></div>
              <div><dt className="muted">Spent</dt><dd>{formatInr(goal.spent)}</dd></div>
              <div><dt className="muted">Remaining</dt><dd>{formatInr(goal.remaining)}</dd></div>
            </dl>
            <div
              className={over ? "bar over" : "bar"} role="progressbar" aria-label="Spent of the budget"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(goal)}
            >
              <div style={{ width: `${percent(goal)}%` }} />
            </div>
            {over && <p className="error">Over budget by {formatInr(goal.remaining.slice(1))}</p>}
            {goal.months.length > 0 && (
              <details>
                <summary className="muted">Months</summary>
                <ul className="facts">
                  {goal.months.map((m) => (
                    <li key={m.month}><span>{monthLabel(m.month)}</span> <span>{formatInr(m.spent)} spent</span></li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
