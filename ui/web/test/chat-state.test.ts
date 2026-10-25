// E4.1/E4.2: how events become the items the page draws.
import { EventSchema } from "@ag-ui/core/schemas";
import { describe, expect, it } from "vitest";
import "../src/zod";
import { type ChatItem, applyEvent, applyEvents, endOpenTools } from "../src/chatState";
import { type Ev, kpisResult, runError, runFinished, runStarted, text, toolCall } from "./chat-fixtures";

const events = (list: Ev[]) => list.map((e) => EventSchema.parse(e));
const run = (list: Ev[], items: ChatItem[] = []) => applyEvents(items, events(list));

describe("applyEvent", () => {
  it("joins the deltas of one assistant message", () => {
    expect(run([runStarted(), ...text("a", "Hel", "lo"), runFinished()])).toEqual([
      { kind: "assistant", id: "a", text: "Hello" },
    ]);
  });

  it("keeps messages and tool calls in the order they come", () => {
    const items = run([...text("a", "one"), ...toolCall("t", "show_kpis", {}, kpisResult), ...text("b", "two")]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("takes the title of a tool call from complete arguments only", () => {
    const start = events([{ type: "TOOL_CALL_START", toolCallId: "t", toolCallName: "show_kpis" }]);
    let items = applyEvents([], start);
    items = applyEvent(items, events([{ type: "TOOL_CALL_ARGS", toolCallId: "t", delta: '{"title": "Sep' }])[0]!);
    expect((items[0] as { title: string | null }).title).toBeNull();
    items = applyEvent(items, events([{ type: "TOOL_CALL_ARGS", toolCallId: "t", delta: 'tember"}' }])[0]!);
    expect((items[0] as { title: string | null }).title).toBe("September");
  });

  it.each([
    ["longer than 80 characters", { title: "x".repeat(81) }],
    ["not a string", { title: 5 }],
    ["with a control character", { title: "a\u0007b" }],
  ])("drops a title %s", (_name, args) => {
    const items = run(toolCall("t", "show_kpis", args, null));
    expect((items[0] as { title: string | null }).title).toBeNull();
  });

  it("stores the result string and marks the call done", () => {
    const [item] = run(toolCall("t", "show_kpis", {}, kpisResult)) as unknown as [{ done: boolean; result: string }];
    expect(item.done).toBe(true);
    expect(JSON.parse(item.result)).toEqual(kpisResult);
  });

  it("limits the arguments it keeps", () => {
    const items = run([
      ...toolCall("t", "show_kpis", { title: "x".repeat(20_000) }, null),
    ]);
    expect((items[0] as { args: string }).args.length).toBeLessThanOrEqual(8_192);
  });

  it("ignores a delta or result for a call or message it does not know", () => {
    expect(run([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "nope", delta: "x" },
      { type: "TOOL_CALL_ARGS", toolCallId: "nope", delta: "{}" },
      { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "nope", content: "{}", role: "tool" },
    ])).toEqual([]);
  });

  it("adds a RUN_ERROR as an error item with its message, cut to 300 characters", () => {
    const items = run([runStarted(), runError("x".repeat(500))]);
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toHaveLength(300);
    expect(items[0]!.kind).toBe("error");
  });

  it("does not change the list it was given", () => {
    const before: ChatItem[] = [{ kind: "assistant", id: "a", text: "x" }];
    const copy = structuredClone(before);
    run(text("a", "y"), before);
    expect(before).toEqual(copy);
  });
});

describe("endOpenTools", () => {
  it("marks only the tool calls without a result as stopped", () => {
    const items = run([...toolCall("a", "show_kpis", {}, kpisResult), ...toolCall("b", "show_chart", {}, null)]);

    const ended = endOpenTools(items) as { id: string; stopped: boolean }[];

    expect(ended.map((i) => [i.id, i.stopped])).toEqual([["a", false], ["b", true]]);
  });

  it("returns the same list when no call is open", () => {
    const items = run(text("a", "hi"));
    expect(endOpenTools(items)).toBe(items);
  });
});
