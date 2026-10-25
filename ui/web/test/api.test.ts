// E3.2.2 and E3.2.3: the API client sends the second factor, reads typed JSON, and shows plain
// error text only; no raw body, no thrown network message.
import { describe, expect, it } from "vitest";
import { ApiError, SESSION_ENDED, createApi } from "../src/api";
import { SESSION, cashMonths, goalsFixture, goldenFetch, health, meta, monthView, spreads } from "./fixtures";

const api = (fetch: typeof globalThis.fetch) => createApi({ fetch, session: SESSION });
const reply = (body: BodyInit, status: number, type = "application/json") =>
  new Response(body, { status, headers: { "Content-Type": type } });

describe("the requests", () => {
  it("send X-Finos-Session, the same-origin cookie and no cache, to the six routes", async () => {
    const { fetch, calls } = goldenFetch();
    const client = api(fetch);

    expect(await client.meta()).toEqual(meta);
    expect(await client.summary({ spread: false, months: 12 })).toEqual(cashMonths);
    expect(await client.month("2026-09", { spread: true })).toEqual(monthView("spread", "2026-09"));
    expect(await client.goals()).toEqual(goalsFixture);
    expect(await client.spreads()).toEqual(spreads);
    expect(await client.health()).toEqual(health);

    expect(calls.map((c) => c.url)).toEqual([
      "/api/meta", "/api/summary?spread=0&months=12", "/api/month/2026-09?spread=1",
      "/api/goals", "/api/spreads", "/api/health",
    ]);
    for (const call of calls) {
      expect(call.headers["x-finos-session"]).toBe(SESSION);
      expect(call.headers.accept).toBe("application/json");
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.cache).toBe("no-store");
      expect(call.init.redirect).toBe("error");
    }
  });

  it("refuses a month that is not YYYY-MM before any request", async () => {
    const { fetch, calls } = goldenFetch();

    await expect(api(fetch).month("2026-09/../x", { spread: false })).rejects.toThrow(ApiError);
    await expect(api(fetch).month("2026-13", { spread: false })).rejects.toThrow("YYYY-MM");
    expect(calls).toEqual([]);
  });

  it("passes the abort signal to fetch", async () => {
    const { fetch, calls } = goldenFetch();
    const controller = new AbortController();

    await api(fetch).meta(controller.signal);

    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe("the errors", () => {
  it("show the plain {error} text of the server", async () => {
    const fetch = (async () => reply('{"error":"Write the month as YYYY-MM."}', 400)) as typeof globalThis.fetch;

    const error = await api(fetch).meta().catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("Write the month as YYYY-MM.");
    expect(error.status).toBe(400);
  });

  it.each([401, 403])("say the session ended on %i, whatever the body says", async (status) => {
    const fetch = (async () => reply('{"error":"anything <b>else</b>"}', status)) as typeof globalThis.fetch;

    const error = await api(fetch).health().catch((e) => e);

    expect(error.message).toBe(SESSION_ENDED);
    expect(SESSION_ENDED).toBe("Session ended. Stop the UI server and start it again.");
  });

  it("never show a raw body: html, a stack, a wrong shape or a long text", async () => {
    const bodies: [BodyInit, string][] = [
      ["<html>Error: SELECT secret at /srv/app.js:1</html>", "text/html"],
      ['{"message":"boom"}', "application/json"],
      ['{"error":{"deep":"x"}}', "application/json"],
      [JSON.stringify({ error: "x".repeat(500) }), "application/json"],
      ["", "application/json"],
    ];
    for (const [body, type] of bodies) {
      const fetch = (async () => reply(body, 500, type)) as typeof globalThis.fetch;

      const error = await api(fetch).goals().catch((e) => e);

      expect(error.message).toBe("The server could not answer (status 500).");
    }
  });

  it("hide the message of a network failure", async () => {
    const fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED 127.0.0.1:8765 with key sk-secret");
    }) as typeof globalThis.fetch;

    const error = await api(fetch).meta().catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("The UI server did not answer. Is it still running?");
    expect(error.message).not.toContain("sk-secret");
  });

  it("pass an abort through, so the page can ignore it", async () => {
    const fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof globalThis.fetch;

    const error = await api(fetch).meta().catch((e) => e);

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe("AbortError");
  });

  it("say so when a good answer is not JSON", async () => {
    const fetch = (async () => reply("not json", 200, "text/plain")) as typeof globalThis.fetch;

    const error = await api(fetch).meta().catch((e) => e);

    expect(error.message).toBe("The server answer could not be read.");
  });
});
