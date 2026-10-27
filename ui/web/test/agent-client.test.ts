// E4.1: the chat transport. POST /agent with the session header, an SSE reader that handles
// partial chunks, and EventSchema on every event.
import { describe, expect, it } from "vitest";
import { ChatError, UNREADABLE_CHAT, createAgentClient, readEvents } from "../src/agentClient";
import { type Ev, kpiRun, runError, runFinished, runStarted, sseBytes, sseResponse, streamOf, text } from "./chat-fixtures";
import { SESSION } from "./fixtures";

async function collect(iterable: AsyncIterable<{ type: string }>) {
  const out: string[] = [];
  for await (const event of iterable) out.push(event.type);
  return out;
}

describe("readEvents", () => {
  it("reads whole events in one chunk", async () => {
    const events = [runStarted(), ...text("a", "hi"), runFinished()];
    const types = await collect(readEvents(streamOf([sseBytes(events)])));
    expect(types).toEqual(events.map((e) => e.type));
  });

  it("reads events split at any byte, also inside a multi-byte character", async () => {
    const events: Ev[] = [runStarted(), ...text("a", "₹ 5 – ok"), runFinished()];
    const bytes = sseBytes(events);
    for (const size of [1, 2, 3, 7, 50]) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
      const seen: unknown[] = [];
      for await (const event of readEvents(streamOf(chunks))) seen.push(event);
      expect(seen.length, `size ${size}`).toBe(events.length);
      expect((seen[2] as { delta: string }).delta, `size ${size}`).toBe("₹ 5 – ok");
    }
  });

  it("accepts CRLF framing, comments and a data field split over lines", async () => {
    const json = JSON.stringify(runStarted());
    const comma = json.indexOf(",") + 1; // a line break after a comma is JSON white space
    const raw = `: keep-alive\r\n\r\nevent: x\r\ndata: ${json.slice(0, comma)}\r\ndata: ${json.slice(comma)}\r\n\r\n`;
    expect(await collect(readEvents(streamOf([new TextEncoder().encode(raw)])))).toEqual(["RUN_STARTED"]);
  });

  it("keeps a CRLF CRLF boundary that is split between chunks", async () => {
    const enc = new TextEncoder();
    const json = JSON.stringify(runStarted());
    const second = JSON.stringify(runFinished());
    for (const cut of [1, 2, 3]) {
      const raw = `data: ${json}\r\n\r\ndata: ${second}\r\n\r\n`;
      const at = raw.indexOf("\r\n\r\n") + cut;
      const chunks = [enc.encode(raw.slice(0, at)), enc.encode(raw.slice(at))];
      expect(await collect(readEvents(streamOf(chunks))), `cut ${cut}`).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    }
  });

  it("does not turn a lone CR then LF across chunks into a blank line", async () => {
    const enc = new TextEncoder();
    const json = JSON.stringify(runStarted());
    const comma = json.indexOf(",") + 1;
    const raw = `data: ${json.slice(0, comma)}\r\ndata: ${json.slice(comma)}\r\n\r\n`;
    const at = raw.indexOf("\r\n") + 1; // between the CR and the LF
    const chunks = [enc.encode(raw.slice(0, at)), enc.encode(raw.slice(at))];
    expect(await collect(readEvents(streamOf(chunks)))).toEqual(["RUN_STARTED"]);
  });

  it("ignores a last event that has no blank line after it", async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(runStarted())}\n`);
    expect(await collect(readEvents(streamOf([bytes])))).toEqual([]);
  });

  it.each([
    ["not JSON", "data: {oops\n\n"],
    ["an unknown event type", `data: ${JSON.stringify({ type: "NOT_AN_EVENT" })}\n\n`],
    ["an event with a missing field", `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "a" })}\n\n`],
    ["a JSON null", "data: null\n\n"],
  ])("ends the run with a fixed message for %s", async (_name, raw) => {
    await expect(collect(readEvents(streamOf([new TextEncoder().encode(raw)])))).rejects.toThrow(
      new ChatError(UNREADABLE_CHAT),
    );
  });

  it("stops at an event larger than 1 MiB", async () => {
    const big = new TextEncoder().encode(`data: ${"x".repeat(1_100_000)}`);
    await expect(collect(readEvents(streamOf([big])))).rejects.toThrow(UNREADABLE_CHAT);
  });

  it("turns a failed stream into a plain message, not the error text", async () => {
    const stream = streamOf([sseBytes([runStarted()])], new Error("secret detail"));
    const error = await collect(readEvents(stream)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatError);
    expect((error as Error).message).not.toContain("secret detail");
  });
});

describe("createAgentClient", () => {
  const input = { text: "How did last month compare?", threadId: "thread-1", runId: "run-1" };

  it("posts a RunAgentInput with the session header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return sseResponse(kpiRun());
    }) as unknown as typeof globalThis.fetch;

    const types = await collect(createAgentClient({ fetch, session: SESSION }).run(input));

    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe("/agent");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Finos-Session")).toBe(SESSION);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({
      threadId: "thread-1", runId: "run-1", state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: "run-1", role: "user", content: "How did last month compare?" }],
    });
  });

  it("shows the plain {error} text of a refusal and never a raw body", async () => {
    const answer = (status: number, body: string) =>
      createAgentClient({ fetch: (async () => new Response(body, { status })) as typeof fetch, session: SESSION });

    await expect(collect(answer(413, JSON.stringify({ error: "The request is larger than 64 KiB." })).run(input)))
      .rejects.toThrow("The request is larger than 64 KiB.");
    await expect(collect(answer(500, "<html>stack trace</html>").run(input)))
      .rejects.toThrow("The server could not answer (status 500).");
    await expect(collect(answer(403, "{}").run(input)))
      .rejects.toThrow("Session ended. Stop the UI server and start it again.");
    await expect(collect(answer(401, "{}").run(input)))
      .rejects.toThrow("Session ended. Stop the UI server and start it again.");
  });

  it("says the server did not answer when the request fails", async () => {
    const client = createAgentClient({ fetch: (async () => { throw new TypeError("secret detail"); }) as typeof fetch, session: SESSION });
    await expect(collect(client.run(input))).rejects.toThrow("The UI server did not answer. Is it still running?");
  });

  it("rejects an answer that is not an event stream", async () => {
    const client = createAgentClient({ fetch: (async () => new Response("{}", { headers: { "Content-Type": "application/json" } })) as typeof fetch, session: SESSION });
    await expect(collect(client.run(input))).rejects.toThrow(UNREADABLE_CHAT);
  });

  it("aborts the fetch when the signal fires (the stop button)", async () => {
    let seen: AbortSignal | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(sseBytes([runStarted()]));
          // A real fetch body errors with AbortError when its signal fires.
          seen!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
    const abort = new AbortController();
    const iterator = createAgentClient({ fetch, session: SESSION }).run(input, abort.signal);

    expect((await iterator.next()).value).toMatchObject({ type: "RUN_STARTED" });
    abort.abort();

    expect(seen?.aborted).toBe(true);
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes a RUN_ERROR through as an event", async () => {
    const client = createAgentClient({ fetch: (async () => sseResponse([runStarted(), runError("The chat is busy with another question. Wait for it to finish.")])) as typeof fetch, session: SESSION });
    expect(await collect(client.run(input))).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  });
});
