// E3.3.4: each goal with its budget, spent, remaining and a bar, and its month lines. The
// name is the household's own text (browser only; the agent never sees it): a text node.
import type { CSSProperties } from "react";
import type { Goal } from "../../../server/src/api-types";
import { formatInr, monthLabel, toNumber } from "../format";
import { AlertTriangle, CheckCircle, Target } from "./Icons";
import "../styles/panels.css";

/** Spent as a whole percent of the budget, from 0 to 100 (a bar length, not a figure). */
function percent(goal: Goal): number {
  const budget = toNumber(goal.budget);
  if (budget <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((toNumber(goal.spent) * 100) / budget)));
}

export function GoalsPanel({ goals }: { goals: Goal[] }) {
  if (goals.length === 0) {
    return (
      <div className="empty-state panel-empty">
        <span className="empty-state-icon"><Target size={24} /></span>
        <p className="empty">No goals yet.</p>
      </div>
    );
  }
  return (
    <div className="goal-list">
      {goals.map((goal, index) => {
        const over = goal.remaining.startsWith("-");
        const used = percent(goal);
        return (
          <div
            className={over ? "goal goal-card is-over" : "goal goal-card"} role="group" aria-label={goal.name}
            key={goal.goal_id} style={{ "--i": index } as CSSProperties}
          >
            <div className="goal-head">
              <h3>{goal.name}</h3>
              {over ? (
                <span className="badge badge-danger"><AlertTriangle size={14} />Over budget</span>
              ) : (
                <span className="badge badge-ok"><CheckCircle size={14} />On track</span>
              )}
            </div>
            <div className="goal-meter">
              <div className="goal-meter-label" aria-hidden="true">
                <span>Spent of the budget</span><span className="mono">{used}%</span>
              </div>
              <div
                className={over ? "bar over" : "bar"} role="progressbar" aria-label="Spent of the budget"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}
              >
                <div style={{ width: `${used}%` }} />
              </div>
            </div>
            <dl className="facts">
              <div><dt className="muted">Budget</dt><dd>{formatInr(goal.budget)}</dd></div>
              <div><dt className="muted">Spent</dt><dd>{formatInr(goal.spent)}</dd></div>
              <div><dt className="muted">Remaining</dt><dd>{formatInr(goal.remaining)}</dd></div>
            </dl>
            {over && <p className="error">Over budget by {formatInr(goal.remaining.slice(1))}</p>}
            {goal.months.length > 0 && (
              <details>
                <summary className="muted">Months</summary>
                <ul className="facts goal-months">
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
