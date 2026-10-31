// E4.2: one tool call in the chat. A renderer map by tool name draws the render tools with
// the E3 components, from the TOOL_CALL_RESULT content only: the arguments of the call never
// give a figure, only the model's title, and that is shown as a text node. The read tools and
// any unknown name show one small "read: <tool>" line.
import type { ToolItem } from "../chatState";
import { type RenderTool, isRenderTool, parseResult } from "../results";
import { CategoryTable } from "./CategoryTable";
import { AlertTriangle, BarChart, Database, Layers, Sparkles, Square, Table, TrendingUp } from "./Icons";
import { KpiTiles } from "./KpiTiles";
import { ResultTable } from "./ResultTable";
import { SeriesChart } from "./SeriesChart";

const WAITING: Record<RenderTool, string> = {
  show_kpis: "Preparing key figures…", show_chart: "Preparing a chart…",
  show_table: "Preparing a table…", show_category_breakdown: "Preparing a category breakdown…",
  get_top: "Preparing a top list…", compare_periods: "Preparing a comparison…",
  find_suspects: "Looking for rows to check…",
};
const SAFE_NAME = /^[a-z_]{1,40}$/;
const day = (month: string | null) => (month === null ? null : `${month}-01`);

/** The fixed label and icon of each render tool, for the card header. Never from the model. */
const KIND: Record<RenderTool, { label: string; Icon: typeof Sparkles }> = {
  show_kpis: { label: "Key figures", Icon: TrendingUp },
  show_chart: { label: "Chart", Icon: BarChart },
  show_table: { label: "Table", Icon: Table },
  show_category_breakdown: { label: "Categories", Icon: Layers },
  get_top: { label: "Top list", Icon: Table },
  compare_periods: { label: "Comparison", Icon: Table },
  find_suspects: { label: "Rows to check", Icon: AlertTriangle },
};

function Titled({ tool, title, children }: { tool: RenderTool; title: string; children: React.ReactNode }) {
  const { label, Icon } = KIND[tool];
  return (
    <section className="panel tool-result">
      <header className="tool-head">
        <span className="icon-chip" aria-hidden="true"><Icon size={16} /></span>
        <div className="tool-head-text">
          <span className="eyebrow tool-kind">{label}</span>
          <h3>{title}</h3>
        </div>
      </header>
      <div className="tool-body">{children}</div>
    </section>
  );
}

/** The text for a result that did not check: the server's plain {error}, or the fixed one. */
function Failure({ error }: { error: string | null }) {
  return (
    <div className="tool-failure">
      <AlertTriangle size={16} className="tool-failure-icon" />
      {error === null ? <p className="error">Could not show this result</p> : <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Rendered({ tool, content }: { tool: RenderTool; content: string }) {
  switch (tool) {
    case "show_kpis": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      const { data } = found;
      return (
        <Titled tool={tool} title={data.title}>
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
      return <Titled tool={tool} title={found.data.title}><SeriesChart chart={found.data} /></Titled>;
    }
    case "show_table":
    case "get_top":
    case "compare_periods":
    case "find_suspects": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      return <Titled tool={tool} title={found.data.title}><ResultTable table={found.data} /></Titled>;
    }
    case "show_category_breakdown": {
      const found = parseResult(tool, content);
      if (!found.ok) return <Failure error={found.error} />;
      return <Titled tool={tool} title={found.data.title}><CategoryTable month={found.data} /></Titled>;
    }
  }
}

export function ToolCall({ item }: { item: ToolItem }) {
  if (!isRenderTool(item.name)) {
    return (
      <p className="muted tool-read">
        <Database size={14} />
        <span>read: {SAFE_NAME.test(item.name) ? item.name : "tool"}</span>
      </p>
    );
  }
  if (item.result === null) {
    if (item.stopped) {
      return (
        <p className="muted tool-read">
          <Square size={14} />
          <span>Stopped before the result arrived</span>
        </p>
      );
    }
    const { Icon } = KIND[item.name];
    return (
      <div className="tool-pending" aria-busy="true">
        <div className="tool-head">
          <span className="icon-chip" aria-hidden="true"><Icon size={16} /></span>
          <span className="tool-pending-title">{item.title ?? WAITING[item.name]}</span>
        </div>
        <span className="skeleton-line" aria-hidden="true" />
        <span className="skeleton-line is-short" aria-hidden="true" />
        <span className="skeleton-block" aria-hidden="true" />
      </div>
    );
  }
  return <Rendered tool={item.name} content={item.result} />;
}
