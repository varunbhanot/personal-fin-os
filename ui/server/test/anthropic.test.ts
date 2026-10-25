// E2.1.6 and E2.1.7: the locked-down Anthropic client and the plain error texts. The fake fetch
// is the only transport; test/no-network.ts refuses everything else.
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_URL, createAnthropic, describeError, lockedFetch } from "../src/anthropic.js";
import { Secret } from "../src/secret.js";

const KEY = "sk-ant-api03-FAKEKEYFAKEKEYFAKEKEY";
const BODY = { "type": "error", "error": { "type": "authentication_error", "message": `bad key ${KEY}` } };

type Seen = { url: string; init: RequestInit; headers: Headers };

function fake(respond: () => Response = () => Response.json(BODY, { status: 401 })) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init, headers: new Headers(init.headers) });
    return respond();
  });
  return { fetch, seen };
}

const params = {
  model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user" as const, content: "hi" }],
};

async function ask(client: ReturnType<typeof createAnthropic>) {
  try {
    for await (const _ of client.messages.stream(params)) void _;
  } catch (error) {
    return error;
  }
  return null;
}

afterEach(() => vi.unstubAllEnvs());

describe("the client", () => {
  it("sends only x-api-key to api.anthropic.com, whatever ANTHROPIC_* the shell had", async () => {
    // hardenEnv deletes these before the SDK loads; here they are set and the client must
    // still ignore every one of them (explicit options win, and the fetch drops the rest).
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-ENVKEY");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ENVTOKEN");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-evil: 1\nAuthorization: Bearer ENVTOKEN");
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((n) =>
      vi.spyOn(console, n).mockImplementation(() => {}),
    );
    const { fetch, seen } = fake();
    await ask(createAnthropic({ key: new Secret(KEY), fetch }));
    expect(seen).toHaveLength(1);
    const { url, headers } = seen[0]!;
    expect(url).toBe(`${API_URL}/v1/messages`);
    expect(new URL(url).origin).toBe("https://api.anthropic.com");
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-evil")).toBeNull();
    for (const [name] of headers) {
      expect(name).toMatch(/^(x-api-key|anthropic-[a-z-]+|content-type|accept|user-agent|x-stainless-[a-z-]+)$/);
    }
    expect(JSON.stringify([...headers])).not.toContain("ENV");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not follow a redirect (redirect: error)", async () => {
    const { fetch, seen } = fake();
    await ask(createAnthropic({ key: new Secret(KEY), fetch }));
    expect(seen[0]!.init.redirect).toBe("error");
  });

  it("does not show the key in JSON, inspect or a string", () => {
    const secret = new Secret(KEY);
    expect(JSON.stringify(createAnthropic({ key: secret, fetch: fake().fetch }))).not.toContain(KEY);
  });
});

describe("lockedFetch", () => {
  it.each([
    "https://evil.example/v1/messages",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com.evil.example/v1/messages",
    "https://api.anthropic.com@evil.example/v1/messages",
    "https://api.anthropic.com:8443/v1/messages",
    "not a url",
  ])("refuses a request to %s and never calls the transport", async (url) => {
    const { fetch } = fake();
    await expect(lockedFetch(fetch)(url, {})).rejects.toThrow("api.anthropic.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes authorization, proxy-authorization and unknown headers, from any header form", async () => {
    for (const headers of [
      { "x-api-key": "k", Authorization: "Bearer x", "Proxy-Authorization": "y", "x-evil": "1" },
      new Headers({ "x-api-key": "k", authorization: "Bearer x", "proxy-authorization": "y", "x-evil": "1" }),
      [["x-api-key", "k"], ["Authorization", "Bearer x"], ["Proxy-Authorization", "y"], ["x-evil", "1"]] as [string, string][],
    ]) {
      const { fetch, seen } = fake();
      await lockedFetch(fetch)("https://api.anthropic.com/v1/messages", { headers });
      expect([...seen[0]!.headers]).toEqual([["x-api-key", "k"]]);
    }
  });

  it("sets redirect: error whatever the caller asked", async () => {
    const { fetch, seen } = fake();
    await lockedFetch(fetch)("https://api.anthropic.com/v1/messages", { redirect: "follow" });
    expect(seen[0]!.init.redirect).toBe("error");
  });
});

describe("describeError", () => {
  const generate = (status: number) =>
    Anthropic.APIError.generate(status, BODY, `${status} ${JSON.stringify(BODY)}`, new Headers());

  it("names ANTHROPIC_KEY in Doppler config ui for 401 and 403", () => {
    for (const status of [401, 403]) {
      expect(describeError(generate(status))).toBe(
        `The Claude API refused the key (HTTP ${status}). Check ANTHROPIC_KEY in Doppler ` +
          "config ui: it may have been revoked, or its workspace may have hit its spend limit.",
      );
    }
  });

  it.each([
    [429, "The Claude API rate limit was reached; try again in a few minutes"],
    [529, "The Claude API is overloaded; try again shortly"],
    [400, "The Claude API rejected the request."],
    [500, "The Claude API returned HTTP 500; try again shortly"],
    [418, "The Claude API returned HTTP 418; try again shortly"],
  ])("gives a plain text for HTTP %s", (status, wanted) => {
    expect(describeError(generate(status))).toBe(wanted);
  });

  it("gives plain texts for a dropped connection, a timeout, an abort and anything else", () => {
    const lost = new Anthropic.APIConnectionError({ cause: new Error(`dns ${KEY}`) });
    expect(describeError(lost)).toBe("The connection to the Claude API dropped; try again shortly");
    expect(describeError(new Anthropic.APIConnectionTimeoutError())).toBe(
      "The connection to the Claude API dropped; try again shortly",
    );
    expect(describeError(new Anthropic.APIUserAbortError())).toBe("The chat was stopped.");
    expect(describeError(new TypeError(`fetch failed ${KEY}`))).toBe(
      "The Claude API call failed; try again shortly",
    );
    expect(describeError("a string")).toBe("The Claude API call failed; try again shortly");
  });

  it("never holds the key, a header or the response body", () => {
    const shown = [401, 403, 429, 400, 500, 529].map((s) => describeError(generate(s))).join("\n");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain("authentication_error");
    expect(shown).not.toContain("bad key");
  });
});
