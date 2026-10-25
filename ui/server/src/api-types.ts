// The shapes of the /api answers, in one file that both trees import: ui/server (record.ts
// returns them, app.ts sends them) and ui/web (api.ts reads them, the components draw them), so
// the API cannot drift between the two (E3.2.4). Types only and no import: the web build
// reads this file as a type and never runs any server code.
//
// Money and counts of money are decimal strings, as Postgres numeric sends them. Dates are
// ISO "YYYY-MM-DD" strings; a month is the date of its first day. The browser makes numbers
// from them for charts only.

export type Decimal = string;

/** One row of the summary views (cash or spread): a month's figures. */
export type Summary = {
  month: string; complete: boolean; income: Decimal; expenses: Decimal; savings: Decimal;
  investments_in: Decimal; investments_out: Decimal; investments: Decimal;
  linked_rows: number; linked_out: Decimal; linked_in: Decimal;
  own_rows: number; own_out: Decimal; own_in: Decimal;
  review_rows: number; review_amount: Decimal;
  uncategorised_rows: number; uncategorised_out: Decimal; uncategorised_in: Decimal;
};

export type Metric = "income" | "expenses" | "savings" | "investments";

/** A figure with the month before; change and pct are null without it (pct also when it is 0). */
export type Kpi = { value: Decimal; previous: Decimal | null; change: Decimal | null; pct: string | null };

export type Kind = "income" | "expense" | "investment" | "transfer";

export type CategoryLine = {
  kind: Kind; category: string; rows: number; gross: Decimal; offsets: Decimal; net: Decimal;
  previous: Decimal | null; change: Decimal | null; pct: string | null;
};

export type Coverage = { source: string; account_last4: string; days_covered: number; days_in_month: number };

export type MonthView = {
  month: string; complete: boolean; previous_month: string | null;
  kpis: Record<Metric, Kpi>; categories: CategoryLine[]; coverage: Coverage[];
  flagged: number; spread_problems: number;
};

/** GET /api/meta */
export type Meta = {
  schema_version: string; months: string[]; spent_this_month: Decimal;
  budget_usd: Decimal; // FINOS_AI_BUDGET_USD in use on the laptop
};

export type GoalLine = { rows: number; spent: Decimal; spent_to_date: Decimal; remaining: Decimal };
export type Goal = GoalLine & {
  goal_id: number; name: string; budget: Decimal; months: (GoalLine & { month: string })[];
};

export type Direction = "debit" | "credit";
export type SpreadState = "not counted" | "transfer" | "no category" | "not an expense";

type RowFacts = {
  txn_date: string; source: string; account_last4: string; direction: Direction; amount: Decimal;
};
export type SpreadRow = RowFacts & { spread_id: number; row_id: string; start_month: string; months: number };
export type SpreadProblem = RowFacts & {
  what: "spread" | "goal"; id: number; row_id: string; state: SpreadState;
};
/** GET /api/spreads */
export type Spreads = { spreads: SpreadRow[]; problems: SpreadProblem[] };

export type FlaggedStatement = {
  source: string; account_last4: string; period_start: string; period_end: string; rows: number;
};
export type AiSpendLine = { purpose: string; calls: number; cost_usd: Decimal };

/** GET /api/health */
export type Health = {
  schema_version: string;
  coverage: (Coverage & { month: string })[];
  complete_months: string[]; partial_months: string[];
  review_rows: number; review_amount: Decimal; uncategorised_rows: number;
  unlinked_transfer_rows: number; unlinked_out: Decimal; unlinked_in: Decimal;
  flagged_statements: FlaggedStatement[];
  ai_spend: AiSpendLine[]; ai_spent_this_month: Decimal;
};

/** The body of every error answer. */
export type ApiErrorBody = { error: string };
