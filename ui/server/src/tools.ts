// The ten tools of the chat agent (S1, S2). Each is a typed function over the read API in
// record.ts, which reads only the safe views of migration 0008. The model never writes SQL, and
// this module holds none and imports no database code. Every text that a result holds is a
// number, a date, a fixed word, a packaged category name, a source ID, last-4 digits or an
// 8-character row ID (the cleaners of record.ts), or the model's own title. The household's
// goals appear as "Goal <id>", never by name: the tools read v_ui_goal_progress through
// record.goalProgress().
//
// Four tools make what the browser draws (show_kpis, show_chart, show_table,
// show_category_breakdown): the server runs the query spec and returns the figures; the model
// never writes one. Three read tools (get_health, get_rows, get_stats) cover what no component
// shows; get_stats does the arithmetic (totals, averages) so that the model never does. Three
// insight tools answer ordinary questions as a table the browser draws: get_top (where the
// money went), compare_periods (get_stats for two periods, with the difference) and
// find_suspects (rows that may distort a figure). A result is JSON with a "component" word.
// Bad input is a result with is_error, not an exception.
import { z } from "zod";
import { add, compare, divide, pct, sub } from "./decimal.js";
import categories from "./categories.json" with { type: "json" };
import { MAX_RANGE_MONTHS, RecordInputError, type Record_, UNLISTED, parseMonth } from "./record.js";

export type ToolRecord = Pick<
  Record_,
  | "months" | "month" | "rows" | "health" | "goalProgress" | "spreads" | "categorySeries"
  | "topCategories" | "topRows" | "suspects"
>;
export type ToolOutcome = { content: string; is_error: boolean };
export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: unknown; required?: string[]; additionalProperties?: boolean };
};

export const TOOL_NAMES = [
  "show_kpis", "show_chart", "show_table", "show_category_breakdown", "get_health", "get_rows",
  "get_stats", "get_top", "compare_periods", "find_suspects",
] as const;

const MAX_CHART_MONTHS = 24;
const MAX_TABLE_ROWS = 50;
// Each result is sent again with every later call of the question: keep one result small.
const MAX_RESULT_CHARS = 32_000;
const HEALTH_MONTHS = 12; // the coverage that get_health gives
const LISTED = categories.map((c) => c.name) as [string, ...string[]];
const METRICS = ["income", "expenses", "savings", "investments"] as const;

/** A mistake in the model's input that it can fix; the message is fixed text. */
class ToolInputError extends Error {}

// --- input schemas (zod 4; strict, and every string and array has a maximum) ----------------

const month = z
  .string().max(7).regex(/^[0-9]{4}-[0-9]{2}$/, "write the month as YYYY-MM")
  .describe("A month written YYYY-MM, for example 2026-09");
const title = z
  .string().max(80).refine((t) => !/\p{C}/u.test(t), "no control characters")
  .describe("A short title for the component, at most 80 characters");
const metric = z.enum(METRICS);
const metrics = z.array(metric).min(1).max(4);
const spread = z
  .boolean().default(false)
  .describe("true to count spread costs in the month they are spread to; false for cash months");
const profile = z.string().max(40).regex(/^[a-z0-9-]{1,40}$/, "a profile ID such as axis-bank");
const amount = z.string().max(15).regex(/^[0-9]{1,12}(\.[0-9]{1,2})?$/, "an amount in rupees, such as 1000 or 99.50");
const category = z.enum(LISTED);
const rowCategory = z.enum([...LISTED, UNLISTED]);
const limit = z.int().min(1).max(MAX_TABLE_ROWS);
const sort = z
  .enum(["date", "amount"])
  .describe("date (the default) for oldest first, or amount for the largest first");
const fromMonth = month.describe("The first month of a range, YYYY-MM; give to_month too, and not month");
const toMonth = month.describe("The last month of a range, YYYY-MM, inclusive; at most 24 months from from_month");
const countedKind = z
  .enum(["expense", "income", "investment"]).default("expense")
  .describe("expense (the default), income or investment");
const statsTarget = {
  metric: metric.optional().describe("A month metric, or give category instead"),
  category: category.optional().describe("One category (its monthly net), or give metric instead"),
};
const completeOnly = z
  .boolean().default(true)
  .describe("true (the default) to leave out partial months, which do not cover every day");
const oneTarget = (v: { metric?: unknown; category?: unknown }) => (v.metric === undefined) !== (v.category === undefined);

const SCHEMAS = {
  show_kpis: z
    .object({ month, spread, metrics, title: title.optional() })
    .strict(),
  show_chart: z
    .object({
      kind: z.enum(["bar", "line"]),
      series: metrics.optional().describe("Month metrics to plot, or give category instead"),
      category: category.optional().describe("One category to plot, or give series instead"),
      from_month: month, to_month: month, spread, title: title.optional(),
    })
    .strict()
    .refine((v) => (v.series === undefined) !== (v.category === undefined), "give series or category, not both"),
  show_table: z
    .object({
      source: z.enum(["months", "month_categories", "rows", "goals", "spreads", "coverage"]),
      title: title.optional(),
      month: month.optional(), spread: z.boolean().optional(), last: z.int().min(1).max(MAX_CHART_MONTHS).optional(),
      profile: profile.optional(), category: rowCategory.optional(), min_amount: amount.optional(),
      limit: limit.optional(), from_month: fromMonth.optional(), to_month: toMonth.optional(),
      sort: sort.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const allowed = TABLE_ARGUMENTS[v.source] ?? [];
      for (const key of Object.keys(v)) {
        if (key !== "source" && key !== "title" && !allowed.includes(key)) {
          ctx.addIssue({ code: "custom", message: `${key} does not apply to source ${v.source}`, path: [key] });
        }
      }
      if (v.source === "month_categories" && v.month === undefined) {
        ctx.addIssue({ code: "custom", message: "month is needed for source month_categories", path: ["month"] });
      }
    }),
  show_category_breakdown: z
    .object({ month, spread, compare: z.boolean().default(true), title: title.optional() })
    .strict(),
  get_health: z.object({}).strict(),
  get_rows: z
    .object({
      month: month.optional(), category: rowCategory.optional(), source: profile.optional(),
      min_amount: amount.optional(), limit: limit.default(20),
      from_month: fromMonth.optional(), to_month: toMonth.optional(), sort: sort.optional(),
    })
    .strict(),
  get_stats: z
    .object({ ...statsTarget, from_month: month, to_month: month, spread, complete_only: completeOnly })
    .strict()
    .refine(oneTarget, "give metric or category, not both"),
  get_top: z
    .object({
      by: z.enum(["categories", "rows"]).describe("categories for the total of each category, rows for the largest rows"),
      from_month: month, to_month: month, kind: countedKind,
      limit: z.int().min(1).max(20).default(10).describe("How many to list, 1 to 20 (default 10)"),
      spread: spread.describe("by categories only: true to count spread costs in the months they are spread to"),
      title: title.optional(),
    })
    .strict(),
  compare_periods: z
    .object({
      ...statsTarget,
      a_from: month.describe("First month of period A"), a_to: month.describe("Last month of period A"),
      b_from: month.describe("First month of period B"), b_to: month.describe("Last month of period B"),
      spread, complete_only: completeOnly, title: title.optional(),
    })
    .strict()
    .refine(oneTarget, "give metric or category, not both"),
  find_suspects: z
    .object({
      from_month: fromMonth.optional(), to_month: toMonth.optional(),
      min_amount: amount.default("25000").describe("Only rows of at least this many rupees (default 25000)"),
      limit: limit.default(25).describe("How many rows to list, 1 to 50 (default 25)"),
      title: title.optional(),
    })
    .strict()
    .refine((v) => (v.from_month === undefined) === (v.to_month === undefined), "give from_month and to_month together, or neither"),
};

// The arguments each table source takes; any other is refused.
const TABLE_ARGUMENTS: Record<string, string[]> = {
  months: ["spread", "last"],
  month_categories: ["month", "spread"],
  rows: ["month", "profile", "category", "min_amount", "limit", "from_month", "to_month", "sort"],
  goals: [],
  spreads: [],
  coverage: ["month"],
};

const DESCRIPTIONS: Record<(typeof TOOL_NAMES)[number], string> = {
  show_kpis:
    "Show KPI tiles for one month: the chosen metrics (income, expenses, savings, investments) " +
    "with the change from the month before. The server fills in the figures. Says if the month is partial.",
  show_chart:
    "Show a bar or line chart over a range of at most 24 months: either month metrics (series) or " +
    "the net of one category. Use a line for a trend over the months. The server fills in the points.",
  show_table:
    "Show a table from one source: months (the monthly summary), month_categories (one month by " +
    "category), rows (single transactions, at most 50, with filters), goals (budget, spent, " +
    "remaining; goals are named Goal 1, Goal 2), spreads, or coverage (days covered per account). " +
    "For rows: month, or from_month and to_month for a range; sort amount lists the largest first.",
  show_category_breakdown:
    "Show a month's spending, income and investments by category, optionally compared with the month before.",
  get_health:
    "Read the data health numbers for your own reasoning, with no component: which months are " +
    "complete or partial, coverage, rows waiting for review, unlinked transfers, flagged " +
    "statements, and the AI spend this month. Call it to learn which months exist.",
  get_rows:
    "Read up to 50 transactions (date, amount, direction, category, source) with the total that " +
    "match, for your own reasoning, with no component. Filters: month, or from_month and to_month " +
    "(at most 24 months), category, source, min_amount. sort amount gives the largest first.",
  get_stats:
    "Work out the total, average, median, highest and lowest month of one metric or one category " +
    "over a range of at most 24 months, for your own reasoning, with no component. Leaves out " +
    "partial months unless complete_only is false, and names the months it used and left out.",
  get_top:
    "Show a table of where the money went over a range of at most 24 months. by categories: the " +
    "total of each category of one kind (expense by default, or income or investment) with its " +
    "share of that kind's total, largest first, and a last row All with the kind's total. It " +
    "counts partial months too (unlike get_stats) and names them in partial_months. by " +
    "rows: the largest single rows of that kind. Use it for 'what did I spend most on', 'my " +
    "biggest expenses', 'top categories this year'. The server does the sums and shares.",
  compare_periods:
    "Show a table that compares one metric or one category over two periods A and B (each at most " +
    "24 months): months used and left out, total and monthly average of each, and a row 'B minus " +
    "A' with the differences and the percent change of the average. Use it for 'this quarter " +
    "against the last', 'this year against last year', 'did I spend more since June'. Leaves out " +
    "partial months unless complete_only is false. Never work out a difference yourself.",
  find_suspects:
    "Show a table of rows that may distort the figures, largest first, each with a reason: " +
    "other_or_unknown (category Other, unlisted or none), unlinked_round (a round expense or " +
    "income amount, a multiple of 1000, not linked as a transfer: it may be a move between your " +
    "own accounts), outlier (at least 5 times the median of its category in the range). Only rows " +
    "of at least min_amount (default 25000). Use it when figures look wrong, when a month is " +
    "unexpectedly high or savings look low, or when the user asks why a month is high. The " +
    "default range is the last 12 months of the record.",
};

function inputSchema(schema: z.ZodType): ToolDefinition["input_schema"] {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest as ToolDefinition["input_schema"];
}

// --- helpers --------------------------------------------------------------------------------

/** The first day of a month, or the fixed error. */
function firstDay(text: string): string {
  const first = parseMonth(text);
  if (!first) throw new ToolInputError("month is written YYYY-MM, as a month of the calendar.");
  return first;
}

const short = (firstDayText: string) => firstDayText.slice(0, 7);
const NO_MONTH = "No statement covers that month.";

/** The first days of a range of months written YYYY-MM, in order and at most 24 months. The
 * error texts name the fields, e.g. "a_from must not be after a_to.". */
function range(from: string, to: string, names = ["from_month", "to_month"]): [string, string] {
  const first = firstDay(from);
  const last = firstDay(to);
  if (first > last) throw new ToolInputError(`${names[0]} must not be after ${names[1]}.`);
  if (monthsBetween(first, last) > MAX_RANGE_MONTHS) {
    throw new ToolInputError(`A range covers at most ${MAX_RANGE_MONTHS} months.`);
  }
  return [first, last];
}

function monthsBetween(first: string, last: string): number {
  const [y1, m1] = first.split("-").map(Number) as [number, number];
  const [y2, m2] = last.split("-").map(Number) as [number, number];
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

type Cell = string | number | boolean | null;
const table = (titleText: string, columns: string[], rows: Cell[][], total = rows.length) => ({
  component: "table", title: titleText, columns, rows: rows.slice(0, MAX_TABLE_ROWS), total,
});

/** Total, average, median, highest and lowest of month values, in exact decimals. Ties go to the
 * earliest month. */
function stats(points: { month: string; value: string }[]) {
  if (points.length === 0) return { count: 0, total: null, average: null, median: null, highest: null, lowest: null };
  const total = points.reduce((sum, p) => add(sum, p.value), "0.00");
  const sorted = [...points].sort((a, b) => compare(a.value, b.value) || (a.month < b.month ? -1 : 1));
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? divide(sorted[mid]!.value, 1) : divide(add(sorted[mid - 1]!.value, sorted[mid]!.value), 2);
  const highest = points.reduce((best, p) => (compare(p.value, best.value) > 0 ? p : best));
  const lowest = points.reduce((best, p) => (compare(p.value, best.value) < 0 ? p : best));
  return {
    count: points.length, total: divide(total, 1), average: divide(total, points.length), median,
    highest: { month: highest.month, value: highest.value }, lowest: { month: lowest.month, value: lowest.value },
  };
}

type Point = { month: string; value: string; complete: boolean };

/** The month values of one metric or one category from first to last (first days of months). */
async function points(
  record: ToolRecord,
  target: { metric?: (typeof METRICS)[number]; category?: string; spread: boolean },
  first: string, last: string,
): Promise<Point[]> {
  if (target.category !== undefined) {
    const series = await record.categorySeries({ spread: target.spread, category: target.category, first, last });
    return series.map((p) => ({ month: short(p.month), value: p.net, complete: p.complete }));
  }
  const all = await record.months({ spread: target.spread, last: 60 });
  return all
    .filter((m) => (m.month as string) >= first && (m.month as string) <= last)
    .map((m) => ({ month: short(m.month as string), value: String(m[target.metric!]), complete: m.complete === true }));
}

/** The months a statistic uses and leaves out, and its figures. */
function usedStats(list: Point[], completeOnly: boolean) {
  const used = list.filter((p) => p.complete || !completeOnly);
  return {
    months_used: used.map((p) => p.month),
    months_skipped: list.filter((p) => !used.includes(p)).map((p) => p.month),
    ...stats(used.map(({ month: mo, value }) => ({ month: mo, value }))),
  };
}

const rowCells = (r: { row_id: string; txn_date: unknown; source: string; account_last4: string; amount: unknown; direction: string; category: string | null }) =>
  [r.row_id, r.txn_date as string, r.source, r.account_last4, r.amount as string, r.direction, r.category];
const ROW_COLUMNS = ["row_id", "date", "source", "account", "amount", "direction", "category"];
const nameOf = (metricName: string) => metricName[0]!.toUpperCase() + metricName.slice(1);

// --- the tools ------------------------------------------------------------------------------

type Runners = {
  [K in keyof typeof SCHEMAS]: (input: z.output<(typeof SCHEMAS)[K]>, record: ToolRecord) => Promise<unknown>;
};

const RUN: Runners = {
  async show_kpis(input, record) {
    const view = await record.month(firstDay(input.month), { spread: input.spread });
    if (!view) throw new ToolInputError(NO_MONTH);
    return {
      component: "kpis", title: input.title ?? `Key figures for ${input.month}`, month: input.month,
      spread: input.spread, complete: view.complete,
      previous_month: view.previous_month ? short(view.previous_month) : null,
      tiles: input.metrics.map((m) => ({ metric: m, ...view.kpis[m] })),
    };
  },

  async show_chart(input, record) {
    const first = firstDay(input.from_month);
    const last = firstDay(input.to_month);
    if (first > last) throw new ToolInputError("from_month must not be after to_month.");
    if (monthsBetween(first, last) > MAX_CHART_MONTHS) {
      throw new ToolInputError(`A chart covers at most ${MAX_CHART_MONTHS} months.`);
    }
    let series: { name: string; points: { x: string; y: string; complete: boolean }[] }[];
    if (input.category !== undefined) {
      const points = await record.categorySeries({ spread: input.spread, category: input.category, first, last });
      series = [{ name: input.category, points: points.map((p) => ({ x: short(p.month), y: p.net, complete: p.complete })) }];
    } else {
      const all = await record.months({ spread: input.spread, last: 60 });
      const inRange = all.filter((m) => m.month >= first && m.month <= last);
      series = input.series!.map((name) => ({
        name,
        points: inRange.map((m) => ({ x: short(m.month as string), y: String(m[name]), complete: m.complete === true })),
      }));
    }
    return {
      component: "chart", chart: input.kind, spread: input.spread,
      title: input.title ?? `${input.from_month} to ${input.to_month}`, series,
    };
  },

  async show_table(input, record) {
    const heading = (fallback: string) => input.title ?? fallback;
    switch (input.source) {
      case "months": {
        const rows = await record.months({ spread: input.spread ?? false, last: input.last ?? 12 });
        return table(heading("Months"), ["month", "complete", "income", "expenses", "savings", "investments"],
          rows.map((m) => [short(m.month as string), m.complete as boolean, m.income as string, m.expenses as string, m.savings as string, m.investments as string]));
      }
      case "month_categories": {
        const view = await record.month(firstDay(input.month!), { spread: input.spread ?? false });
        if (!view) throw new ToolInputError(NO_MONTH);
        return table(heading(`Categories in ${input.month}`), ["kind", "category", "rows", "net", "previous", "change", "pct"],
          view.categories.map((l) => [l.kind, l.category, l.rows, l.net, l.previous, l.change, l.pct]));
      }
      case "rows": {
        const found = await record.rows({
          limit: input.limit ?? 20,
          ...(input.month !== undefined ? { month: input.month } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.profile !== undefined ? { source: input.profile } : {}),
          ...(input.min_amount !== undefined ? { min_amount: input.min_amount } : {}),
          ...rangeAndSort(input),
        });
        return table(heading("Transactions"), ["row_id", "date", "source", "account", "amount", "direction", "category", "kind"],
          found.rows.map((r) => [r.row_id, r.txn_date as string, r.source, r.account_last4, r.amount as string, r.direction, r.category, r.kind]),
          found.total);
      }
      case "goals": {
        const progress = await record.goalProgress();
        return table(heading("Goals"), ["goal", "budget", "spent", "spent_to_date", "remaining"],
          progress.map((g) => [`Goal ${g.goal_id}`, g.budget as string, (g.spent ?? null) as string | null, (g.spent_to_date ?? null) as string | null, (g.remaining ?? null) as string | null]));
      }
      case "spreads": {
        const { spreads } = await record.spreads();
        return table(heading("Spreads"), ["spread_id", "row_id", "date", "source", "account", "direction", "amount", "start_month", "months"],
          spreads.map((s) => [s.spread_id, s.row_id, s.txn_date as string, s.source, s.account_last4, s.direction, s.amount as string, s.start_month as string, s.months]));
      }
      case "coverage": {
        const { coverage } = await record.health();
        const wanted = input.month === undefined ? null : firstDay(input.month);
        const rows = coverage.filter((c) => wanted === null || c.month === wanted);
        return table(heading("Coverage"), ["month", "source", "account", "days_covered", "days_in_month"],
          rows.map((c) => [short(c.month), c.source, c.account_last4, c.days_covered, c.days_in_month]));
      }
    }
  },

  async show_category_breakdown(input, record) {
    const view = await record.month(firstDay(input.month), { spread: input.spread });
    if (!view) throw new ToolInputError(NO_MONTH);
    return {
      component: "category_breakdown", title: input.title ?? `Categories in ${input.month}`,
      month: input.month, previous_month: view.previous_month ? short(view.previous_month) : null,
      complete: view.complete, spread: input.spread, compare: input.compare,
      categories: view.categories.map((l) => ({
        kind: l.kind, category: l.category, net: l.net,
        previous: input.compare ? l.previous : null,
        change: input.compare ? l.change : null,
        pct: input.compare ? l.pct : null,
      })),
    };
  },

  async get_health(_input, record) {
    const health = await record.health();
    // The coverage grid grows each month; the last 12 months are what a question needs.
    const recent = [...new Set(health.coverage.map((c) => c.month))].sort().slice(-HEALTH_MONTHS);
    return { component: "read", ...health, coverage: health.coverage.filter((c) => recent.includes(c.month)) };
  },

  async get_rows(input, record) {
    const found = await record.rows({
      limit: input.limit,
      ...(input.month !== undefined ? { month: input.month } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.min_amount !== undefined ? { min_amount: input.min_amount } : {}),
      ...rangeAndSort(input),
    });
    return { component: "read", total: found.total, rows: found.rows };
  },

  async get_stats(input, record) {
    const first = firstDay(input.from_month);
    const last = firstDay(input.to_month);
    if (first > last) throw new ToolInputError("from_month must not be after to_month.");
    if (monthsBetween(first, last) > MAX_CHART_MONTHS) {
      throw new ToolInputError(`Statistics cover at most ${MAX_CHART_MONTHS} months.`);
    }
    return {
      component: "read", metric: input.metric ?? null, category: input.category ?? null,
      from_month: input.from_month, to_month: input.to_month, spread: input.spread,
      complete_only: input.complete_only,
      ...usedStats(await points(record, input, first, last), input.complete_only),
    };
  },

  async get_top(input, record) {
    const [first, last] = range(input.from_month, input.to_month);
    const span = `${input.from_month} to ${input.to_month}`;
    if (input.by === "rows") {
      if (input.spread) {
        throw new ToolInputError("spread applies to by categories only; rows count in the month they were paid.");
      }
      const found = await record.topRows({ kind: input.kind, first, last, limit: input.limit });
      return table(input.title ?? `Largest ${input.kind} rows, ${span}`, ROW_COLUMNS,
        found.rows.map(rowCells), found.total);
    }
    // The totals count every month of the range, partial ones too (unlike get_stats), so the
    // result names the partial months and the default title counts them.
    const partial = (await points(record, { metric: "expenses", spread: input.spread }, first, last))
      .filter((p) => !p.complete).map((p) => p.month);
    const lines = await record.topCategories({ spread: input.spread, kind: input.kind, first, last });
    const all = lines.reduce((sum, l) => add(sum, l.net), "0");
    const allRows = lines.reduce((n, l) => n + l.rows, 0);
    // pct(part, whole) is part as a percentage of |whole|, to 0.1; null when the whole is 0.
    const share = (net: string) => pct(net, all);
    const note = partial.length === 0 ? "" : ` (${partial.length} partial month${partial.length === 1 ? "" : "s"})`;
    return {
      // total counts the All row too, so "Showing X of Y" appears when a category is cut.
      ...table(input.title ?? `Top ${input.kind} categories, ${span}${note}`, ["category", "rows", "total", "share_pct"],
        [
          ...lines.slice(0, input.limit).map((l) => [l.category, l.rows, l.net, share(l.net)]),
          ["All", allRows, all, share(all) === null ? null : "100.0"],
        ],
        lines.length + 1),
      partial_months: partial,
    };
  },

  async compare_periods(input, record) {
    const a = range(input.a_from, input.a_to, ["a_from", "a_to"]);
    const b = range(input.b_from, input.b_to, ["b_from", "b_to"]);
    const [statsA, statsB] = [
      usedStats(await points(record, input, ...a), input.complete_only),
      usedStats(await points(record, input, ...b), input.complete_only),
    ];
    const line = (label: string, from: string, to: string, s: ReturnType<typeof usedStats>) =>
      [label, from, to, s.months_used.length, s.months_skipped.length, s.total, s.average, null];
    const both = statsA.average !== null && statsB.average !== null;
    const avgChange = both ? sub(statsB.average!, statsA.average!) : null;
    const name = input.category ?? nameOf(input.metric!);
    return table(
      input.title ?? `${name}: ${input.a_from} to ${input.a_to} against ${input.b_from} to ${input.b_to}`,
      ["period", "from", "to", "months_used", "months_skipped", "total", "average", "pct_change"],
      [
        line("A", input.a_from, input.a_to, statsA),
        line("B", input.b_from, input.b_to, statsB),
        ["B minus A", null, null, null, null, both ? divide(sub(statsB.total!, statsA.total!), 1) : null,
          avgChange === null ? null : divide(avgChange, 1), pct(avgChange, statsA.average)],
      ],
    );
  },

  async find_suspects(input, record) {
    let first: string;
    let last: string;
    if (input.from_month !== undefined && input.to_month !== undefined) {
      [first, last] = range(input.from_month, input.to_month);
    } else {
      const known = await record.months({ spread: false, last: 12 });
      if (known.length === 0) return table(input.title ?? "Rows to check", SUSPECT_COLUMNS, []);
      first = known[0]!.month as string;
      last = known.at(-1)!.month as string;
    }
    const found = await record.suspects({ first, last, min_amount: input.min_amount, limit: input.limit });
    return table(input.title ?? `Rows to check, ${short(first)} to ${short(last)}`, SUSPECT_COLUMNS,
      found.rows.map((r) => [...rowCells(r), r.kind, r.reason]), found.total);
  },
};

const SUSPECT_COLUMNS = [...ROW_COLUMNS, "kind", "reason"];

/** The range and sort of a row query, as record.rows takes them. */
function rangeAndSort(input: { from_month?: string; to_month?: string; sort?: "date" | "amount" }) {
  return {
    ...(input.from_month !== undefined ? { from_month: input.from_month } : {}),
    ...(input.to_month !== undefined ? { to_month: input.to_month } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
  };
}

// --- the list the agent uses ----------------------------------------------------------------

const fail = (error: string): ToolOutcome => ({ content: JSON.stringify({ error }), is_error: true });

/** What the model may fix, in at most 300 characters. The texts are zod's and ours, and the
 * only model-supplied text in them is an unknown key name. */
function describeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
  return `The input is not valid. ${issues.join("; ")}`.slice(0, 300);
}

export function createTools(record: ToolRecord) {
  const definitions: ToolDefinition[] = TOOL_NAMES.map((name) => ({
    name, description: DESCRIPTIONS[name], input_schema: inputSchema(SCHEMAS[name]),
  }));

  async function run(name: string, input: unknown): Promise<ToolOutcome> {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) return fail("There is no tool with that name.");
    const tool = name as (typeof TOOL_NAMES)[number];
    const parsed = SCHEMAS[tool].safeParse(input);
    if (!parsed.success) return fail(describeIssues(parsed.error));
    try {
      const data = await (RUN[tool] as (i: unknown, r: ToolRecord) => Promise<unknown>)(parsed.data, record);
      const content = JSON.stringify(data);
      if (content.length > MAX_RESULT_CHARS) {
        return fail("The result is too large for the chat. Ask for fewer months or rows.");
      }
      return { content, is_error: false };
    } catch (error) {
      // Only our own fixed texts reach the model; a database error never does.
      if (error instanceof ToolInputError || error instanceof RecordInputError) return fail(error.message);
      return fail("The record could not be read. Try again.");
    }
  }

  return { definitions, run };
}
