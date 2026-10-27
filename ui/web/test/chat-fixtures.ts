// Synthetic AG-UI streams and tool results for the chat tests. The results have the shapes
// that ui/server/src/tools.ts returns (component word, title, figures as decimal strings), made
// from the golden record; no real figures.
import { monthView } from "./fixtures";

export type Ev = Record<string, unknown>;

export const runStarted = (runId = "run-1", threadId = "thread-1"): Ev => ({ type: "RUN_STARTED", threadId, runId });
export const runFinished = (runId = "run-1", threadId = "thread-1"): Ev => ({ type: "RUN_FINISHED", threadId, runId });
export const runError = (message: string, code = "busy"): Ev => ({ type: "RUN_ERROR", message, code });
export const text = (messageId: string, ...deltas: string[]): Ev[] => [
  { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
  ...deltas.map((delta) => ({ type: "TEXT_MESSAGE_CONTENT", messageId, delta })),
  { type: "TEXT_MESSAGE_END", messageId },
];
export const toolCall = (id: string, name: string, args: unknown, result: unknown | null): Ev[] => [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
  { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
  { type: "TOOL_CALL_END", toolCallId: id },
  ...(result === null
    ? []
    : [{
        type: "TOOL_CALL_RESULT", messageId: `m-${id}`, toolCallId: id, role: "tool",
        content: typeof result === "string" ? result : JSON.stringify(result),
      }]),
];

const encoder = new TextEncoder();

/** The SSE bytes of some events: "data: <JSON>" and a blank line for each. */
export const sseBytes = (events: Ev[]): Uint8Array =>
  encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));

/** A stream of byte chunks; a failure after the chunks makes the stream error. */
export function streamOf(chunks: Uint8Array[], failAfter?: Error): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]!);
      else if (failAfter) controller.error(failAfter);
      else controller.close();
    },
  });
}

/** An event stream answer, split into chunks of `size` bytes (to test partial reads). */
export function sseResponse(events: Ev[], size = Infinity, status = 200): Response {
  const bytes = sseBytes(events);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += Math.min(size, bytes.length)) chunks.push(bytes.slice(at, at + size));
  return new Response(streamOf(chunks), { status, headers: { "Content-Type": "text/event-stream" } });
}

// --- tool results ---------------------------------------------------------------------------

const sep = monthView("cash", "2026-09");
const tile = (metric: "income" | "expenses" | "savings" | "investments") => ({ metric, ...sep.kpis[metric] });

export const kpisResult = {
  component: "kpis", title: "Key figures for 2026-09", month: "2026-09", spread: false, complete: false,
  previous_month: "2026-08", tiles: [tile("income"), tile("expenses")],
};
export const chartResult = {
  component: "chart", chart: "bar", spread: false, title: "Income and expenses",
  series: [
    { name: "income", points: [{ x: "2026-08", y: "0", complete: true }, { x: "2026-09", y: "151200.50", complete: false }] },
    { name: "expenses", points: [{ x: "2026-08", y: "500.00", complete: true }, { x: "2026-09", y: "75155.75", complete: false }] },
  ],
};
export const tableResult = {
  component: "table", title: "Months", total: 2,
  columns: ["month", "complete", "income", "expenses"],
  rows: [["2026-08", true, "0", "500.00"], ["2026-09", false, "151200.50", "75155.75"]],
};
export const breakdownResult = {
  component: "category_breakdown", title: "Categories in 2026-09", month: "2026-09",
  previous_month: "2026-08", complete: false, spread: false, compare: true,
  categories: sep.categories.map((l) => ({
    kind: l.kind, category: l.category, net: l.net, previous: l.previous, change: l.change, pct: l.pct,
  })),
};

/** The usual scripted answer: one KPI tool call, then text. */
export const kpiRun = (runId = "run-1"): Ev[] => [
  runStarted(runId),
  ...toolCall("t1", "show_kpis", { month: "2026-09", metrics: ["income", "expenses"], title: "September at a glance" }, kpisResult),
  ...text("a1", "September ", "looks fine."),
  runFinished(runId),
];
