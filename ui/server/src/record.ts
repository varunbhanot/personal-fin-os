// The read API of the dashboard (and, from E2, of the agent's tools) over the safe views of
// migration 0008. The views do the arithmetic, so the figures are finos month's figures
// (tests/ui_golden/expected.json holds them for the golden seed). This module only merges,
// compares months and cleans.
//
// Every text column passes an output cleaner: it is a fixed value or a strict pattern, so no
// text from a statement, a categorisation or the household reaches the browser or the model
// (S1, S2). A category name the packaged list does not have becomes "Other (unlisted)". Only
// goals() returns a goal's name, for the browser's goals panel; the tools never call it.
import categories from "./categories.json" with { type: "json" };
import type { Db, Row } from "./db.js";
import { add, pct, sub } from "./decimal.js";

export const UNLISTED = "Other (unlisted)";
const PACKAGED = new Set(categories.map((c) => c.name));
const PACKAGED_NAMES = [...PACKAGED];

export class RecordInputError extends Error {
  override name = "RecordInputError";
}

// --- output cleaners ----------------------------------------------------------------------

function oneOf<T extends string>(values: readonly T[], fallback: T) {
  return (value: unknown): T =>
    typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pattern(re: RegExp, fallback: string) {
  return (value: unknown): string => (typeof value === "string" && re.test(value) ? value : fallback);
}

const KINDS = ["income", "expense", "investment", "transfer"] as const;
const kind = oneOf(KINDS, "expense");

export const clean = {
  source: pattern(/^[a-z0-9-]{1,40}$/, "unknown"),
  account_last4: pattern(/^[0-9]{0,4}$/, "?"),
  row_id: pattern(/^[0-9a-f]{8}$/, "????????"),
  direction: oneOf(["debit", "credit"] as const, "debit"),
  kind: (value: unknown) => (value === null ? null : kind(value)),
  status: oneOf(["ok", "flagged"] as const, "flagged"),
  what: oneOf(["spread", "goal"] as const, "spread"),
  purpose: oneOf(
    ["extract", "categorise", "eval-extract", "eval-categorise", "chat"] as const, "other",
  ),
  model: pattern(/^claude-[a-z0-9-]{1,60}$/, "unknown"),
  state: oneOf(["not counted", "transfer", "no category", "not an expense"] as const, "not counted"),
  category: (value: unknown): string | null =>
    value === null ? null : typeof value === "string" && PACKAGED.has(value) ? value : UNLISTED,
};

/** A goal's name for the browser: printable characters only, at most 60. */
function goalName(value: unknown): string {
  return String(value ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 60);
}

// --- inputs -------------------------------------------------------------------------------

/** The first day of a month written YYYY-MM, as month.parse_month; else null. */
export function parseMonth(text: string): string | null {
  const found = /^([0-9]{4})-([0-9]{2})$/.exec(text);
  if (!found || Number(found[1]) < 1 || Number(found[2]) < 1 || Number(found[2]) > 12) return null;
  return `${text}-01`;
}

function monthBefore(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const year = m === 1 ? y - 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-01`;
}

// --- shapes -------------------------------------------------------------------------------

const SUMMARY_COLUMNS = [
  "month", "complete", "income", "expenses", "savings", "investments_in", "investments_out",
  "investments", "linked_rows", "linked_out", "linked_in", "own_rows", "own_out", "own_in",
  "review_rows", "review_amount", "uncategorised_rows", "uncategorised_out", "uncategorised_in",
] as const;
const COUNTS = new Set(["linked_rows", "own_rows", "review_rows", "uncategorised_rows"]);
const METRICS = ["income", "expenses", "savings", "investments"] as const;

export type Summary = Record<(typeof SUMMARY_COLUMNS)[number], string | number | boolean>;
export type Kpi = { value: string; previous: string | null; change: string | null; pct: string | null };
export type CategoryLine = {
  kind: string; category: string; rows: number; gross: string; offsets: string; net: string;
  previous: string | null; change: string | null; pct: string | null;
};
export type Coverage = { source: string; account_last4: string; days_covered: number; days_in_month: number };
export type MonthView = {
  month: string; complete: boolean; previous_month: string | null;
  kpis: Record<(typeof METRICS)[number], Kpi>; categories: CategoryLine[]; coverage: Coverage[];
  flagged: number; spread_problems: number;
};
export type RowFilter = {
  month?: string; category?: string; source?: string; min_amount?: string; limit: number;
};

function summary(row: Row): Summary {
  return Object.fromEntries(
    SUMMARY_COLUMNS.map((c) => [c, COUNTS.has(c) ? Number(row[c]) : (row[c] as string | boolean)]),
  ) as Summary;
}

function views(spread: boolean) {
  return spread
    ? { summary: "v_monthly_summary_spread", byCategory: "v_monthly_by_category_spread" }
    : { summary: "v_monthly_summary", byCategory: "v_monthly_by_category" };
}

// Fixed queries; a view name is one of the two constants above, never input.
const Q = {
  months: (view: string) =>
    `select ${SUMMARY_COLUMNS.join(", ")} from ${view} order by month desc limit $1`,
  twoMonths: (view: string) =>
    `select ${SUMMARY_COLUMNS.join(", ")} from ${view} where month in ($1::date, $2::date)`,
  categories: (view: string) =>
    "select month, kind, category, position, rows, gross, offsets, net " +
    `from ${view} where month in ($1::date, $2::date) order by position`,
  coverage:
    "select source, account_last4, days_covered, days_in_month from v_month_coverage " +
    "where month = $1::date order by source, account_last4",
  flagged:
    "select count(*)::int as n from v_statement_health where status is distinct from 'ok' " +
    "and period_start < ($1::date + interval '1 month') and period_end >= $1::date",
  spreadProblems:
    "select count(*)::int as n from v_spread_problems where what is distinct from 'goal'",
  version: "select max(version) as v from schema_migrations",
  spent:
    "select coalesce(sum(cost_usd), 0) as spent from v_ai_spend " +
    "where month = date_trunc('month', now())::date",
  monthsAvailable: "select month from v_monthly_summary order by month",
  goals:
    "select goal_id, goal, budget, month, rows, spent, spent_to_date, remaining " +
    "from v_goal_progress order by goal_id, month nulls last",
  spreads:
    "select spread_id, row_id, txn_date, source, account_last4, direction, amount, " +
    "start_month, months from v_ui_spreads order by spread_id",
  problems:
    "select what, id, txn_id, txn_date, source, account_last4, direction, amount, state " +
    "from v_spread_problems order by what desc, id, txn_date, txn_id",
  allCoverage:
    "select month, source, account_last4, days_covered, days_in_month from v_month_coverage " +
    "order by month, source, account_last4",
  monthStates: "select month, complete from v_monthly_summary order by month",
  totals:
    "select coalesce(sum(review_rows), 0)::int as review_rows, " +
    "coalesce(sum(review_amount), 0) as review_amount, " +
    "coalesce(sum(uncategorised_rows), 0)::int as uncategorised_rows, " +
    "coalesce(sum(own_rows), 0)::int as unlinked_transfer_rows, " +
    "coalesce(sum(own_out), 0) as unlinked_out, coalesce(sum(own_in), 0) as unlinked_in " +
    "from v_monthly_summary",
  statements:
    "select source, account_last4, period_start, period_end, status, rows " +
    "from v_statement_health order by period_start, source, account_last4",
  aiSpend:
    "select purpose, calls, cost_usd from v_ai_spend " +
    "where month = date_trunc('month', now())::date",
  rows:
    "select row_id, txn_date, month, source, account_last4, amount, direction, category, " +
    "linked, kind, refund, value, needs_review, count(*) over ()::int as total from v_ui_rows " +
    "where ($1::date is null or month = $1::date) and ($2::text is null or source = $2) " +
    "and ($3::numeric is null or amount >= $3::numeric) " +
    "and ($4::text is null or lower(category) = lower($4::text)) " + // as finos rows matches
    "and (not $5::boolean or (category is not null and category <> all($6::text[]))) " +
    "order by txn_date, source, account_last4, row_id limit $7",
};

function coverage(r: Row): Coverage {
  return {
    source: clean.source(r.source),
    account_last4: clean.account_last4(r.account_last4),
    days_covered: Number(r.days_covered),
    days_in_month: Number(r.days_in_month),
  };
}

function kpi(value: string, previous: string | null): Kpi {
  const change = previous === null ? null : sub(value, previous);
  return { value, previous, change, pct: pct(change, previous) };
}

/** The category lines of both months, merged by kind and shown name, in list order. */
function categoryLines(rows: Row[], month: string, hasBefore: boolean): CategoryLine[] {
  const lines = new Map<string, CategoryLine & { position: number; before: string }>();
  for (const r of rows) {
    const k = clean.kind(r.kind) ?? "expense";
    const name = clean.category(r.category) ?? UNLISTED;
    const key = `${k}\u0000${name}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        kind: k, category: name, rows: 0, gross: "0", offsets: "0", net: "0", before: "0",
        previous: null, change: null, pct: null, position: Number(r.position),
      };
      lines.set(key, line);
    }
    line.position = Math.min(line.position, Number(r.position));
    if (r.month === month) {
      line.rows += Number(r.rows);
      line.gross = add(line.gross, r.gross as string);
      line.offsets = add(line.offsets, r.offsets as string);
      line.net = add(line.net, r.net as string);
    } else {
      line.before = add(line.before, r.net as string);
    }
  }
  return [...lines.values()]
    .sort((a, b) => a.position - b.position || (a.category < b.category ? -1 : 1))
    .map(({ position: _p, before, ...line }) => {
      const previous = hasBefore ? before : null;
      const change = previous === null ? null : sub(line.net, previous);
      return { ...line, previous, change, pct: pct(change, previous) };
    });
}

export function createRecord(db: Db) {
  return {
    /** The last N months of the summary view, oldest first. */
    async months({ spread, last = 12 }: { spread: boolean; last?: number }): Promise<Summary[]> {
      const [rows] = await db.read([{ text: Q.months(views(spread).summary), params: [last] }]);
      return rows!.map(summary).reverse();
    },

    /** The month in full, with the change from the month before; null when it has no row. */
    async month(month: string, { spread }: { spread: boolean }): Promise<MonthView | null> {
      const before = monthBefore(month);
      const v = views(spread);
      const [summaries, cats, cover, flagged, problems] = await db.read([
        { text: Q.twoMonths(v.summary), params: [month, before] },
        { text: Q.categories(v.byCategory), params: [month, before] },
        { text: Q.coverage, params: [month] },
        { text: Q.flagged, params: [month] },
        { text: Q.spreadProblems },
      ]);
      const now = summaries!.find((r) => r.month === month);
      if (!now) return null;
      const prev = summaries!.find((r) => r.month === before) ?? null;
      return {
        month,
        complete: now.complete as boolean,
        previous_month: prev ? before : null,
        kpis: Object.fromEntries(
          METRICS.map((m) => [m, kpi(now[m] as string, prev ? (prev[m] as string) : null)]),
        ) as MonthView["kpis"],
        categories: categoryLines(cats!, month, prev !== null),
        coverage: cover!.map(coverage),
        flagged: Number(flagged![0]!.n),
        spread_problems: spread ? Number(problems![0]!.n) : 0,
      };
    },

    /** Each goal with its total and its month lines. The name is for the browser only. */
    async goals() {
      const [rows] = await db.read([{ text: Q.goals }]);
      const goals = new Map<string, Record<string, unknown> & { months: unknown[] }>();
      for (const r of rows!) {
        const id = String(r.goal_id);
        let goal = goals.get(id);
        if (!goal) {
          goal = { goal_id: Number(r.goal_id), name: goalName(r.goal), budget: r.budget, months: [] };
          goals.set(id, goal);
        }
        const line = {
          rows: Number(r.rows), spent: r.spent, spent_to_date: r.spent_to_date,
          remaining: r.remaining,
        };
        if (r.month === null) Object.assign(goal, line);
        else goal.months.push({ month: r.month, ...line });
      }
      return [...goals.values()];
    },

    /** The spreads, and the spreads and goal rows that add nothing now. */
    async spreads() {
      const [spreads, problems] = await db.read([{ text: Q.spreads }, { text: Q.problems }]);
      const row = (r: Row) => ({
        txn_date: r.txn_date,
        source: clean.source(r.source),
        account_last4: clean.account_last4(r.account_last4),
        direction: clean.direction(r.direction),
        amount: r.amount,
      });
      return {
        spreads: spreads!.map((r) => ({
          spread_id: Number(r.spread_id), row_id: clean.row_id(r.row_id), ...row(r),
          start_month: r.start_month, months: Number(r.months),
        })),
        problems: problems!.map((r) => ({
          what: clean.what(r.what), id: Number(r.id),
          row_id: clean.row_id(String(r.txn_id ?? "").slice(0, 8)), ...row(r),
          state: clean.state(r.state),
        })),
      };
    },

    /** The data health panel. */
    async health() {
      const [version, cover, states, totals, statements, spend] = await db.read([
        { text: Q.version }, { text: Q.allCoverage }, { text: Q.monthStates },
        { text: Q.totals }, { text: Q.statements }, { text: Q.aiSpend },
      ]);
      const t = totals![0]!;
      const byPurpose = new Map<string, { calls: number; cost_usd: string }>();
      for (const r of spend!) {
        const purpose = clean.purpose(r.purpose);
        const entry = byPurpose.get(purpose) ?? { calls: 0, cost_usd: "0" };
        entry.calls += Number(r.calls);
        entry.cost_usd = add(entry.cost_usd, r.cost_usd as string);
        byPurpose.set(purpose, entry);
      }
      const aiSpend = [...byPurpose.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([purpose, entry]) => ({ purpose, ...entry }));
      return {
        schema_version: schemaVersion(version!),
        coverage: cover!.map((r) => ({ month: r.month as string, ...coverage(r) })),
        complete_months: states!.filter((r) => r.complete === true).map((r) => r.month as string),
        partial_months: states!.filter((r) => r.complete !== true).map((r) => r.month as string),
        review_rows: Number(t.review_rows),
        review_amount: t.review_amount as string,
        uncategorised_rows: Number(t.uncategorised_rows),
        unlinked_transfer_rows: Number(t.unlinked_transfer_rows),
        unlinked_out: t.unlinked_out as string,
        unlinked_in: t.unlinked_in as string,
        flagged_statements: statements!
          .filter((r) => clean.status(r.status) === "flagged")
          .map((r) => ({
            source: clean.source(r.source), account_last4: clean.account_last4(r.account_last4),
            period_start: r.period_start as string, period_end: r.period_end as string,
            rows: Number(r.rows),
          })),
        ai_spend: aiSpend,
        ai_spent_this_month: aiSpend.reduce((sum, s) => add(sum, s.cost_usd), "0"),
      };
    },

    /** Rows of v_ui_rows, at most 50, with the count of all that match. */
    async rows(filter: RowFilter) {
      const f = checkFilter(filter);
      const unlisted = f.category === UNLISTED;
      const [rows] = await db.read([
        {
          text: Q.rows,
          params: [
            f.month ?? null, f.source ?? null, f.min_amount ?? null,
            unlisted ? null : (f.category ?? null), unlisted, PACKAGED_NAMES, f.limit,
          ],
        },
      ]);
      return {
        total: rows!.length ? Number(rows![0]!.total) : 0,
        rows: rows!.map((r) => ({
          row_id: clean.row_id(r.row_id), txn_date: r.txn_date, month: r.month,
          source: clean.source(r.source), account_last4: clean.account_last4(r.account_last4),
          amount: r.amount, direction: clean.direction(r.direction),
          category: clean.category(r.category), linked: r.linked, kind: clean.kind(r.kind),
          refund: r.refund, value: r.value, needs_review: r.needs_review,
        })),
      };
    },

    /** What /api/meta shows besides the budget. */
    async meta() {
      const [version, months, spent] = await db.read([
        { text: Q.version }, { text: Q.monthsAvailable }, { text: Q.spent },
      ]);
      return {
        schema_version: schemaVersion(version!),
        months: months!.map((r) => r.month as string),
        spent_this_month: spent![0]!.spent as string,
      };
    },
  };
}

export type Record_ = ReturnType<typeof createRecord>;

function schemaVersion(rows: Row[]): string {
  return pattern(/^[0-9]{4}_[a-z0-9_]{1,60}$/, "unknown")(rows[0]?.v);
}

const FILTER_KEYS = new Set(["month", "category", "source", "min_amount", "limit"]);

function checkFilter(filter: RowFilter): RowFilter {
  for (const key of Object.keys(filter)) {
    if (!FILTER_KEYS.has(key)) throw new RecordInputError(`Unknown row filter ${key.slice(0, 20)}.`);
  }
  const { month, category, source, min_amount: min, limit } = filter;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RecordInputError("limit is a whole number from 1 to 50.");
  }
  const first = month === undefined ? undefined : parseMonth(month);
  if (first === null) throw new RecordInputError("month is written YYYY-MM.");
  if (category !== undefined && category !== UNLISTED && !PACKAGED.has(category)) {
    throw new RecordInputError("category is not in the category list.");
  }
  if (source !== undefined && !/^[a-z0-9-]{1,40}$/.test(source)) {
    throw new RecordInputError("source is a profile ID such as axis-bank.");
  }
  if (min !== undefined && !/^[0-9]{1,12}(\.[0-9]{1,2})?$/.test(min)) {
    throw new RecordInputError("min_amount is an amount in rupees, such as 1000 or 99.50.");
  }
  return { ...filter, ...(first ? { month: first } : {}) };
}
