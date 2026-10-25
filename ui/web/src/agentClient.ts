// E4.1: the chat transport. POST /agent with the session header, then a small SSE reader. Every
// event is parsed with EventSchema from @ag-ui/core/schemas before anything uses it; an event
// that does not parse ends the run with a fixed message. The only thing sent is the question:
// the server keeps the thread itself and ignores everything else in the body (S2).
import "./zod"; // first: it must run before @ag-ui/core makes its schemas
import { EventSchema } from "@ag-ui/core/schemas";
import type { z } from "./zod";
import { SESSION_ENDED } from "./api";

export type AgentEvent = z.infer<typeof EventSchema>;

export const UNREADABLE_CHAT = "The chat answer could not be read";
const NO_ANSWER = "The UI server did not answer. Is it still running?";
const MAX_EVENT_BYTES = 1_048_576;

/** An error whose message is plain text, fit to show on the page. */
export class ChatError extends Error {
  override name = "ChatError";
}

/** Events from an SSE body: "data:" lines, a blank line ends an event, chunks may split anything. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new ChatError(UNREADABLE_CHAT);
      });
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      // A CR at the end of a chunk may be half of a CRLF: keep it until the next chunk.
      const held = !done && buffer.endsWith("\r") ? "\r" : "";
      buffer = buffer.slice(0, buffer.length - held.length).replace(/\r\n?/g, "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const data = buffer.slice(0, end).split("\n").filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""));
        buffer = buffer.slice(end + 2);
        if (data.length > 0) yield parse(data.join("\n"));
      }
      buffer += held;
      if (done) return; // a last event without its blank line is not complete: dropped
      if (buffer.length > MAX_EVENT_BYTES) throw new ChatError(UNREADABLE_CHAT);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function parse(data: string): AgentEvent {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ChatError(UNREADABLE_CHAT);
  }
  const event = EventSchema.safeParse(json);
  if (!event.success) throw new ChatError(UNREADABLE_CHAT);
  return event.data;
}

export type RunInput = { text: string; threadId: string; runId: string };
type Deps = { fetch: typeof globalThis.fetch; session: string };

export function createAgentClient({ fetch, session }: Deps) {
  /** The events of one run. It throws ChatError for a failure and AbortError for a stop. */
  async function* run(input: RunInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let response: Response;
    try {
      response = await fetch("/agent", {
        method: "POST",
        headers: {
          "X-Finos-Session": session, "Content-Type": "application/json", Accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: input.threadId, runId: input.runId, state: {}, tools: [], context: [], forwardedProps: {},
          messages: [{ id: input.runId, role: "user", content: input.text }],
        }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ChatError(NO_ANSWER);
    }
    if (response.status === 401 || response.status === 403) throw new ChatError(SESSION_ENDED);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const error = (body as { error?: unknown } | null)?.error;
      throw new ChatError(
        typeof error === "string" && error.length > 0 && error.length <= 200
          ? error
          : `The server could not answer (status ${response.status}).`,
      );
    }
    if (!response.body || !(response.headers.get("Content-Type") ?? "").startsWith("text/event-stream")) {
      throw new ChatError(UNREADABLE_CHAT);
    }
    yield* readEvents(response.body);
  }
  return { run };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
