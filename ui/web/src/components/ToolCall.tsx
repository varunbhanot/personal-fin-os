// E4.2: one tool call in the chat. A renderer map by tool name draws the four render tools with
// the E3 components, from the TOOL_CALL_RESULT content only: the arguments of the call never
// give a figure, only the model's title, and that is shown as a text node. The read tools and
// any unknown name show one small "read: <tool>" line.
import type { ToolItem } from "../chatState";
import { type RenderTool, isRenderTool, parseResult } from "../results";
import { CategoryTable } from "./CategoryTable";
import { KpiTiles } from "./KpiTiles";
import { ResultTable } from "./ResultTable";
import { SeriesChart } from "./SeriesChart";

const WAITING: Record<RenderTool, string> = {
  show_kpis: "Preparing key figures…", show_chart: "Preparing a chart…",
  show_table: "Preparing a table…", show_category_breakdown: "Preparing a category breakdown…",
};
const SAFE_NAME = /^[a-z_]{1,40}$/;
const day = (month: string | null) => (month === null ? null : `${month}-01`);

function Titled({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel tool-result">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** The text for a result that did not check: the server's plain {error}, or the fixed one. */
function Failure({ error }: { error: string | null }) {
  return error === null ? <p className="error">Could not show this result</p> : <p className="error" role="alert">{error}</p>;
}

function Rendered({ tool, content }: { tool: RenderTool; content: string }) {
  switch (tool) {
    case "show_kpis": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      const { data } = found;
      return (
        <Titled title={data.title}>
          <KpiTiles
            month={{
              complete: data.complete, previous_month: day(data.previous_month),
              kpis: Object.fromEntries(data.tiles.map((t) => [t.metric, t])),
            }}
          />
        </Titled>
      );
    }
    case "show_chart": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      return <Titled title={found.data.title}><SeriesChart chart={found.data} /></Titled>;
    }
    case "show_table": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      return <Titled title={found.data.title}><ResultTable table={found.data} /></Titled>;
    }
    case "show_category_breakdown": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      return <Titled title={found.data.title}><CategoryTable month={found.data} /></Titled>;
    }
  }
}

export function ToolCall({ item }: { item: ToolItem }) {
  if (!isRenderTool(item.name)) {
    return <p className="muted tool-read">read: {SAFE_NAME.test(item.name) ? item.name : "tool"}</p>;
  }
  if (item.result === null) {
    if (item.stopped) return <p className="muted tool-read">Stopped before the result arrived</p>;
    return (
      <div className="skeleton" aria-busy="true">
        {item.title ?? WAITING[item.name]}
      </div>
    );
  }
  return <Rendered tool={item.name} content={item.result} />;
}
