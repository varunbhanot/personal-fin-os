// E4.2.2: the results of the render tools, as the server's tools.ts returns them. The three
// insight tools (get_top, compare_periods, find_suspects) give the table shape of show_table. The
// content of TOOL_CALL_RESULT is a string; it is parsed as JSON and then checked here, so a
// result that does not match shows "Could not show this result" and never reaches a component.
// Every figure is a decimal string (the browser makes numbers from them for chart bars only),
// and every string and array has a maximum.
import { z } from "./zod";

const MAX_CONTENT = 200_000;
const decimal = z.string().max(30).regex(/^-?[0-9]+(\.[0-9]+)?$/);
const month = z.string().max(7).regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const label = z.string().max(200);
const maybe = decimal.nullable();

const kpi = z.object({
  metric: z.enum(["income", "expenses", "savings", "investments"]),
  value: decimal, previous: maybe, change: maybe, pct: maybe,
});

const cell = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

const table = z.object({
  component: z.literal("table"), title: label, total: z.int().min(0).max(1_000_000),
  columns: z.array(z.string().max(40)).max(12),
  rows: z.array(z.array(cell).max(12)).max(50),
});

export const RESULTS = {
  show_kpis: z.object({
    component: z.literal("kpis"), title: label, month, spread: z.boolean(), complete: z.boolean(),
    previous_month: month.nullable(), tiles: z.array(kpi).max(4),
  }),
  show_chart: z.object({
    component: z.literal("chart"), chart: z.enum(["bar", "line"]), spread: z.boolean(), title: label,
    series: z.array(z.object({
      name: z.string().max(60),
      points: z.array(z.object({ x: month, y: decimal, complete: z.boolean() })).max(24),
    })).max(4),
  }),
  show_table: table,
  get_top: table,
  compare_periods: table,
  find_suspects: table,
  show_category_breakdown: z.object({
    component: z.literal("category_breakdown"), title: label, month, previous_month: month.nullable(),
    complete: z.boolean(), spread: z.boolean(), compare: z.boolean(),
    categories: z.array(z.object({
      kind: z.enum(["income", "expense", "investment", "transfer"]),
      category: z.string().max(80), net: decimal, previous: maybe, change: maybe, pct: maybe,
    })).max(100),
  }),
};

export type RenderTool = keyof typeof RESULTS;
export type Result<T extends RenderTool> = z.infer<(typeof RESULTS)[T]>;
export const isRenderTool = (name: string): name is RenderTool => Object.hasOwn(RESULTS, name);

export type Parsed<T extends RenderTool> =
  | { ok: true; data: Result<T> }
  | { ok: false; error: string | null }; // error: the server's plain text, or null for "unreadable"

/** The content string of a result: JSON, then the shape check. {error} gives the plain text. */
export function parseResult<T extends RenderTool>(tool: T, content: string): Parsed<T> {
  if (content.length > MAX_CONTENT) return { ok: false, error: null };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: null };
  }
  const failure = z.object({ error: z.string().min(1).max(300) }).strict().safeParse(json);
  if (failure.success) return { ok: false, error: failure.data.error };
  const found = RESULTS[tool].safeParse(json);
  return found.success ? { ok: true, data: found.data as Result<T> } : { ok: false, error: null };
}
