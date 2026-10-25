// The Anthropic client of the chat, locked down (S4). The key is the in-memory ANTHROPIC_KEY of
// config ui. The client never reads the environment: apiKey, authToken, baseURL and logLevel are
// set explicitly, and every request passes lockedFetch, which
// - refuses any host but https://api.anthropic.com,
// - drops authorization, proxy-authorization and every header the SDK does not need (an
//   ANTHROPIC_CUSTOM_HEADERS line, a proxy's credential),
// - sets redirect: "error", so no redirect can carry the key to another host.
// boot.ts has already deleted every ANTHROPIC_* variable before this module is evaluated; the
// options here are the second line. Error texts are fixed: they never hold the key, a header or
// the response body.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageStreamParams, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Secret } from "./secret.js";

export const API_URL = "https://api.anthropic.com";
const HOST = "api.anthropic.com";
const TIMEOUT_MS = 120_000;
// The headers the SDK sets for a messages call, and nothing else.
const ALLOWED_HEADERS =
  /^(x-api-key|anthropic-[a-z-]+|content-type|accept|user-agent|x-stainless-[a-z-]+)$/i;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the agent needs of the SDK: a stream of the raw events of one call. A test passes a
 * scripted fake. */
export type MessagesApi = {
  stream(body: MessageStreamParams, options?: { signal?: AbortSignal }): AsyncIterable<RawMessageStreamEvent>;
};
export type Chat = { messages: MessagesApi };

/** The SDK's fetch, in front of inner. */
export function lockedFetch(inner: Fetch) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      url = new URL("invalid:");
    }
    if (url.protocol !== "https:" || url.hostname !== HOST || url.port !== "" || url.username || url.password) {
      throw new Error(`The Claude client refused a request to a host other than ${HOST}.`);
    }
    const headers = new Headers();
    for (const [name, value] of new Headers(init.headers)) {
      if (ALLOWED_HEADERS.test(name)) headers.set(name, value);
    }
    return inner(url.href, { ...init, headers, redirect: "error" });
  };
}

export function createAnthropic({ key, fetch }: { key: Secret; fetch: Fetch }): Chat {
  const client = new Anthropic({
    apiKey: key.reveal(),
    authToken: null,
    baseURL: API_URL,
    logLevel: "off",
    maxRetries: 3,
    timeout: TIMEOUT_MS,
    fetch: lockedFetch(fetch),
  });
  return { messages: { stream: (body, options) => client.messages.stream(body, options) } };
}

/** A plain text for a failed call. Not error.message: the SDK puts the response body in it. */
export function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIUserAbortError) return "The chat was stopped.";
  if (error instanceof Anthropic.APIConnectionError) {
    return "The connection to the Claude API dropped; try again shortly";
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return (
        `The Claude API refused the key (HTTP ${error.status}). Check ANTHROPIC_KEY in Doppler ` +
        "config ui: it may have been revoked, or its workspace may have hit its spend limit."
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      return "The Claude API rate limit was reached; try again in a few minutes";
    }
    if (error.status === 529) return "The Claude API is overloaded; try again shortly";
    if (error instanceof Anthropic.BadRequestError) return "The Claude API rejected the request.";
    return `The Claude API returned HTTP ${error.status}; try again shortly`;
  }
  return "The Claude API call failed; try again shortly";
}
