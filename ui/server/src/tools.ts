// The seven tools of the chat agent (S1, S2). Each is a typed function over the read API in
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
// shows; get_stats does the arithmetic (totals, averages) so that the model never does. A
// result is JSON with a "component" word. Bad input is a result with is_error, not an exception.
import { z } from "zod";
import { add, compare, divide } from "./decimal.js";
import categories from "./categories.json" with { type: "json" };
import { RecordInputError, type Record_, UNLISTED, parseMonth } from "./record.js";

export type ToolRecord = Pick<
  Record_,
  "months" | "month" | "rows" | "health" | "goalProgress" | "spreads" | "categorySeries"
>;
export type ToolOutcome = { content: string; is_error: boolean };
export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: unknown; required?: string[]; additionalProperties?: boolean };
};

export const TOOL_NAMES = [
  "show_kpis", "show_chart", "show_table", "show_category_breakdown", "get_health", "get_rows",
  "get_stats",
] as const;

const MAX_CHART_MONTHS = 24;
const MAX_TABLE_ROWS = 50;
// Each result is sent again with every later call of the question: keep one result small.
const MAX_RESULT_CHARS = 32_000;
const HEALTH_MONTHS = 12; // the coverage that get_health gives
const LISTED = categories.map((c) => c.name) as [string, ...string[]];

/** A mistake in the model's input that it can fix; the message is fixed text. */
class ToolInputError extends Error {}

// --- input schemas (zod 4; strict, and every string and array has a maximum) ----------------

const month = z
  .string().max(7).regex(/^[0-9]{4}-[0-9]{2}$/, "write the month as YYYY-MM")
  .describe("A month written YYYY-MM, for example 2026-09");
const title = z
  .string().max(80).refine((t) => !/\p{C}/u.test(t), "no control characters")
  .describe("A short title for the component, at most 80 characters");
const metric = z.enum(["income", "expenses", "savings", "investments"]);
const metrics = z.array(metric).min(1).max(4);
const spread = z
  .boolean().default(false)
  .describe("true to count spread costs in the month they are spread to; false for cash months");
const profile = z.string().max(40).regex(/^[a-z0-9-]{1,40}$/, "a profile ID such as axis-bank");
const amount = z.string().max(15).regex(/^[0-9]{1,12}(\.[0-9]{1,2})?$/, "an amount in rupees, such as 1000 or 99.50");
const category = z.enum(LISTED);
const rowCategory = z.enum([...LISTED, UNLISTED]);
const limit = z.int().min(1).max(MAX_TABLE_ROWS);

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
      limit: limit.optional(),
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
    })
    .strict(),
  get_stats: z
    .object({
      metric: metric.optional().describe("A month metric, or give category instead"),
      category: category.optional().describe("One category (its monthly net), or give metric instead"),
      from_month: month, to_month: month, spread,
      complete_only: z
        .boolean().default(true)
        .describe("true (the default) to leave out partial months, which do not cover every day"),
    })
    .strict()
    .refine((v) => (v.metric === undefined) !== (v.category === undefined), "give metric or category, not both"),
};

// The arguments each table source takes; any other is refused.
const TABLE_ARGUMENTS: Record<string, string[]> = {
  months: ["spread", "last"],
  month_categories: ["month", "spread"],
  rows: ["month", "profile", "category", "min_amount", "limit"],
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
    "the net of one category. The server fills in the points.",
  show_table:
    "Show a table from one source: months (the monthly summary), month_categories (one month by " +
    "category), rows (single transactions, at most 50, with filters), goals (budget, spent, " +
    "remaining; goals are named Goal 1, Goal 2), spreads, or coverage (days covered per account).",
  show_category_breakdown:
    "Show a month's spending, income and investments by category, optionally compared with the month before.",
  get_health:
    "Read the data health numbers for your own reasoning, with no component: which months are " +
    "complete or partial, coverage, rows waiting for review, unlinked transfers, flagged " +
    "statements, and the AI spend this month. Call it to learn which months exist.",
  get_rows:
    "Read up to 50 transactions (date, amount, direction, category, source) with the total that " +
    "match, for your own reasoning, with no component. Filters: month, category, source, min_amount.",
  get_stats:
    "Work out the total, average, median, highest and lowest month of one metric or one category " +
    "over a range of at most 24 months, for your own reasoning, with no component. Leaves out " +
    "partial months unless complete_only is false, and names the months it used and left out.",
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
    let points: { month: string; value: string; complete: boolean }[];
    if (input.category !== undefined) {
      const series = await record.categorySeries({ spread: input.spread, category: input.category, first, last });
      points = series.map((p) => ({ month: short(p.month), value: p.net, complete: p.complete }));
    } else {
      const all = await record.months({ spread: input.spread, last: 60 });
      points = all
        .filter((m) => (m.month as string) >= first && (m.month as string) <= last)
        .map((m) => ({ month: short(m.month as string), value: String(m[input.metric!]), complete: m.complete === true }));
    }
    const used = points.filter((p) => p.complete || !input.complete_only);
    return {
      component: "read", metric: input.metric ?? null, category: input.category ?? null,
      from_month: input.from_month, to_month: input.to_month, spread: input.spread,
      complete_only: input.complete_only,
      months_used: used.map((p) => p.month),
      months_skipped: points.filter((p) => !used.includes(p)).map((p) => p.month),
      ...stats(used.map(({ month: mo, value }) => ({ month: mo, value }))),
    };
  },
};

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
