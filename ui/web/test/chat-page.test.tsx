// E4.1 and E4.3: the chat page with a mocked fetch that streams scripted AG-UI events.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentClient } from "../src/agentClient";
import { createApi } from "../src/api";
import { ChatPage } from "../src/pages/ChatPage";
import { type Ev, kpiRun, kpisResult, runError, runFinished, runStarted, sseResponse, streamOf, text, toolCall } from "./chat-fixtures";
import { SESSION, goldenFetch, meta } from "./fixtures";

type Body = { threadId: string; runId: string; messages: { content: string }[] };

/** One fetch for /api and /agent: the golden API, and a scripted answer for each /agent call. */
function setup(answers: ((signal: AbortSignal) => Response)[]) {
  const golden = goldenFetch();
  const agentBodies: Body[] = [];
  const agentSignals: (AbortSignal | undefined)[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) === "/agent") {
      agentBodies.push(JSON.parse(init.body as string) as Body);
      agentSignals.push(init.signal as AbortSignal | undefined);
      const answer = answers.shift();
      if (!answer) throw new Error("no scripted answer");
      return answer(init.signal as AbortSignal);
    }
    return golden.fetch(input, init);
  }) as typeof globalThis.fetch;
  const api = createApi({ fetch, session: SESSION });
  const agent = createAgentClient({ fetch, session: SESSION });
  let n = 0;
  const view = render(<ChatPage api={api} agent={agent} newId={() => `id-${++n}`} />);
  return { ...view, agentBodies, agentSignals, golden };
}

const ask = async (question: string) => {
  await userEvent.type(screen.getByRole("textbox", { name: "Your question" }), question);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
};

beforeEach(() => window.history.replaceState(null, "", "/#/chat"));
afterEach(() => vi.restoreAllMocks());

describe("ChatPage", () => {
  it("shows the suggestions, one with the latest month, and the AI spend line", async () => {
    setup([]);

    expect(await screen.findByText(/AI spend this month: \$/)).toBeTruthy();
    expect(screen.getByText(/of \$100\.00/)).toBeTruthy();
    expect(screen.getByText("The chat shares this limit with finos sync.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "How did last month compare?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show spending by category for 2026-09" })).toBeTruthy();
  });

  it("sends a suggestion as the question", async () => {
    const { agentBodies } = setup([() => sseResponse(kpiRun())]);

    await userEvent.click(await screen.findByRole("button", { name: "Show spending by category for 2026-09" }));

    await screen.findByText("September looks fine.");
    expect(agentBodies[0]!.messages[0]!.content).toBe("Show spending by category for 2026-09");
  });

  it("renders the KPI tiles from the tool result and the closing text", async () => {
    const { agentBodies } = setup([() => sseResponse(kpiRun(), 40)]);

    await ask("How did September go?");

    expect(await screen.findByText("September looks fine.")).toBeTruthy();
    expect(screen.getByText("How did September go?")).toBeTruthy();
    const tiles = screen.getAllByRole("group");
    expect(tiles.map((g) => g.getAttribute("aria-label"))).toEqual(["Income", "Expenses"]);
    expect(within(tiles[1]!).getByText("₹75,155.75")).toBeTruthy();
    expect(agentBodies).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveProperty("value", "");
  });

  it("keeps one thread id and makes a new run id for each question", async () => {
    const { agentBodies } = setup([() => sseResponse(kpiRun("r1")), () => sseResponse([runStarted("r2"), ...text("b", "ok")])]);

    await ask("one");
    await screen.findByText("September looks fine.");
    await ask("two");
    await screen.findByText("ok");

    expect(agentBodies[0]!.threadId).toBe(agentBodies[1]!.threadId);
    expect(agentBodies[0]!.runId).not.toBe(agentBodies[1]!.runId);
  });

  it("shows assistant text as plain text: no link, image or math element", async () => {
    const reply = "See [x](https://evil.example) and ![](https://evil.example/a.png) and $x$ <b>bold</b> **star**";
    const { container } = setup([() => sseResponse([runStarted(), ...text("a", reply)])]);

    await ask("hi");

    expect(await screen.findByText(reply)).toBeTruthy();
    expect(container.querySelector("a[href^='http'], img, .katex, b, strong, em")).toBeNull();
  });

  it("keeps nothing in storage and opens no IndexedDB (S7)", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setup([() => sseResponse(kpiRun())]);

    await ask("hi");
    await screen.findByText("September looks fine.");

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows a RUN_ERROR as a plain message and lets the user ask again", async () => {
    const message = "The chat is busy with another question. Wait for it to finish.";
    setup([() => sseResponse([runStarted(), runError(message)])]);

    await ask("hi");

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    await userEvent.type(screen.getByRole("textbox", { name: "Your question" }), "again");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
  });

  it("shows the plain error when the stream cannot be read", async () => {
    const bad = new Response(streamOf([new TextEncoder().encode("data: {oops\n\n")]), {
      headers: { "Content-Type": "text/event-stream" },
    });
    setup([() => bad]);

    await ask("hi");

    expect((await screen.findByRole("alert")).textContent).toBe("The chat answer could not be read");
  });

  it("shows an error when the stream ends before RUN_FINISHED", async () => {
    setup([() => sseResponse([runStarted(), ...text("a", "half")])]);

    await ask("hi");

    expect((await screen.findByRole("alert")).textContent).toBe("The chat answer ended before it was complete.");
    expect(screen.getByText("half")).toBeTruthy();
  });

  it("shows a skeleton while a tool runs, then the result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const call = toolCall("t1", "show_kpis", { title: "Sept" }, kpisResult);
    const encoder = new TextEncoder();
    const encode = (events: Ev[]) => encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encode([runStarted(), ...call.slice(0, 3)]));
        await gate;
        controller.enqueue(encode([call[3]!, runFinished()]));
        controller.close();
      },
    });
    setup([() => new Response(stream, { headers: { "Content-Type": "text/event-stream" } })]);

    await ask("hi");

    expect(await screen.findByText("Sept")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
    release();
    expect(await screen.findAllByRole("group")).toHaveLength(2);
  });

  it("stops the run with the stop button: it aborts the fetch and enables Send", async () => {
    const open = (signal: AbortSignal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(runStarted())}\n\n`));
            // A real fetch body errors with AbortError when its signal fires.
            signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const { agentSignals } = setup([open]);

    await ask("hi");
    const stop = await screen.findByRole("button", { name: "Stop" });
    await userEvent.type(screen.getByRole("textbox", { name: "Your question" }), "next");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    await userEvent.click(stop);

    expect(agentSignals[0]!.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("ends an open tool call when the stream breaks, so no skeleton stays busy", async () => {
    const call = toolCall("t1", "show_chart", { title: "Trend" }, null);
    setup([() => sseResponse([runStarted(), ...call])]);

    await ask("hi");

    await screen.findByRole("alert");
    expect(screen.getByText("Stopped before the result arrived")).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("ends an open tool call when the user presses Stop", async () => {
    const open = (signal: AbortSignal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const events = [runStarted(), ...toolCall("t1", "show_chart", {}, null)];
            controller.enqueue(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")));
            signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    setup([open]);

    await ask("hi");
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Stopped before the result arrived")).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("does not send an empty or a too long question", async () => {
    const { agentBodies } = setup([]);

    await userEvent.type(await screen.findByRole("textbox", { name: "Your question" }), "   ");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "Your question" }).getAttribute("maxlength")).toBe("2000");
    expect(agentBodies).toHaveLength(0);
  });

  it("refreshes the AI spend line after a run", async () => {
    const { golden } = setup([() => sseResponse(kpiRun())]);
    await screen.findByText(/AI spend this month/);
    const before = golden.calls.filter((c) => c.url === "/api/meta").length;

    await ask("hi");
    await screen.findByText("September looks fine.");

    await waitFor(() => expect(golden.calls.filter((c) => c.url === "/api/meta").length).toBe(before + 1));
    expect(meta.budget_usd).toBe("100");
  });
});
