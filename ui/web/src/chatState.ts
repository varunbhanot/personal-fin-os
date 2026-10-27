// E4.1/E4.2: how AG-UI events become the list of items the chat page draws. A pure function, so
// the page holds one list in state and never changes it in place. Only these events matter
// (the ones ui/server sends); the others are ignored. Text is kept as a plain string for text
// nodes. A tool call keeps its raw result string: the renderer parses and checks it (E4.2.2).
import { EventType } from "@ag-ui/core";
import type { AgentEvent } from "./agentClient";

export type ToolItem = {
  kind: "tool"; id: string; name: string;
  title: string | null; // the model's title, from complete arguments; shown only as text
  args: string; // the arguments as they arrive; kept only to find the title
  done: boolean; // the result has arrived
  result: string | null;
  stopped: boolean; // the run ended with no result for this call (stop, break, error)
};
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | ToolItem;

const MAX_ARGS = 8_192;
const MAX_TEXT = 100_000;
const MAX_ERROR = 300;

/** The title of a tool call: a string of at most 80 characters, with no control character. */
function titleOf(args: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return null;
  }
  const title = (value as { title?: unknown } | null)?.title;
  return typeof title === "string" && title.length > 0 && title.length <= 80 && !/\p{C}/u.test(title) ? title : null;
}

const update = <T extends ChatItem>(
  items: ChatItem[], kind: T["kind"], id: string, change: (item: T) => T,
): ChatItem[] => {
  const at = items.findIndex((i) => i.kind === kind && i.id === id);
  if (at < 0) return items;
  return items.map((item, index) => (index === at ? change(item as T) : item));
};

export function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
      return [...items, { kind: "assistant", id: event.messageId, text: "" }];
    case EventType.TEXT_MESSAGE_CONTENT:
      return update<Extract<ChatItem, { kind: "assistant" }>>(items, "assistant", event.messageId, (item) => ({
        ...item, text: (item.text + event.delta).slice(0, MAX_TEXT),
      }));
    case EventType.TOOL_CALL_START:
      return [...items, {
        kind: "tool", id: event.toolCallId, name: event.toolCallName,
        title: null, args: "", done: false, result: null, stopped: false,
      }];
    case EventType.TOOL_CALL_ARGS:
      return update<ToolItem>(items, "tool", event.toolCallId, (item) => {
        const args = (item.args + event.delta).slice(0, MAX_ARGS);
        return { ...item, args, title: titleOf(args) };
      });
    case EventType.TOOL_CALL_RESULT:
      return update<ToolItem>(items, "tool", event.toolCallId, (item) => ({
        ...item, done: true, result: typeof event.content === "string" ? event.content : "", // not text: unreadable
      }));
    case EventType.RUN_ERROR:
      return [...items, { kind: "error", id: `error-${items.length}`, text: event.message.slice(0, MAX_ERROR) }];
    default:
      return items;
  }
}

export const applyEvents = (items: ChatItem[], events: AgentEvent[]): ChatItem[] =>
  events.reduce(applyEvent, items);

/** Marks each tool call that has no result as stopped, when a run ends. Same list if none is open. */
export function endOpenTools(items: ChatItem[]): ChatItem[] {
  const open = (i: ChatItem) => i.kind === "tool" && !i.done && !i.stopped;
  if (!items.some(open)) return items;
  return items.map((i) => (i.kind === "tool" && open(i) ? { ...i, stopped: true } : i));
}
