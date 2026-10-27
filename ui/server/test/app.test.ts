// S3: the HTTP surface. app.request() with a fake clock and a fake record; one real socket.
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, CSP, createApp, listWeb } from "../src/app.js";
import { FIXED_ERROR_LINE, hardenEnv, installErrorHandlers } from "../src/harden.js";

const EXPECTED = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8",
  ),
);
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = "LAUNCHTOKENLAUNCHTOKENLAUNCHTOKEN0123456789a";
const INDEX = '<!doctype html><title>finos</title><script type="module" src="/assets/app-1.js"></script>';

function web() {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "app-1.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "app-1.css"), "body{}");
  return { dist, files: listWeb(dist) };
}

const record = {
  meta: vi.fn(async () => ({ schema_version: "0009_ai_usage_text", months: ["2026-08-01", "2026-09-01"], spent_this_month: "2.3500" })),
  months: vi.fn(async ({ spread }: { spread: boolean; last?: number }) => EXPECTED.months[spread ? "spread" : "cash"]),
  month: vi.fn(async (m: string, { spread }: { spread: boolean }) => EXPECTED.month[spread ? "spread" : "cash"][m.slice(0, 7)] ?? null),
  goals: vi.fn(async () => EXPECTED.goals),
  spreads: vi.fn(async () => EXPECTED.spreads),
  health: vi.fn(async () => EXPECTED.health),
};

let clock = 1_000_000;
let stop: ReturnType<typeof vi.fn>;
let agent: ReturnType<typeof vi.fn>;
let site: ReturnType<typeof web>;

function make(extra: Partial<AppDeps> = {}) {
  return createApp({
    port: PORT, record, budgetUsd: "100", launchToken: TOKEN, issuedAt: clock,
    now: () => clock, stop, web: site.files, agent, ...extra,
  } as AppDeps);
}

beforeEach(() => {
  clock = 1_000_000;
  stop = vi.fn();
  agent = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  site = web();
});

type Session = { cookie: string; cookieValue: string; value: string };

async function login(app: ReturnType<typeof make>): Promise<Session> {
  const res = await app.request(`/auth?t=${TOKEN}`, { headers: { host: HOST } });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  const value = res.headers.get("location")!.replace("/#s=", "");
  return { cookie, cookieValue: cookie.split("=")[1]!, value };
}

function api(session: Session, extra: Record<string, string> = {}) {
  return { host: HOST, cookie: session.cookie, "x-finos-session": session.value, ...extra };
}

function agentPost(session: Session, body: string | ReadableStream, extra: Record<string, string> = {}) {
  return {
    method: "POST",
    body,
    headers: { ...api(session), origin: ORIGIN, "content-type": "application/json", ...extra },
  };
}

describe("the Host check", () => {
  const paths = ["/auth?t=x", "/", "/assets/app-1.js", "/api/meta", "/agent"];
  it.each(["evil.example:8765", "localhost:8765", "[::1]:8765", "127.0.0.1:9999", "127.0.0.1"])(
    "answers 421 to Host %s on every route, /auth included",
    async (host) => {
      const app = make();
      for (const path of paths) {
        const res = await app.request(path, { method: path === "/agent" ? "POST" : "GET", headers: { host } });
        expect(res.status, path).toBe(421);
      }
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it("answers 421 to a request with no Host header over a real socket", async () => {
    const app = make();
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
      let text = "";
      socket.on("data", (d) => (text += d));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    server.close();

    expect(answer.split("\r\n")[0]).toMatch(/^HTTP\/1\.[01] 421 /);
  });
});

describe("/auth", () => {
  it("refuses a wrong token, or one of another length, without throwing", async () => {
    const app = make();
    for (const t of ["x", TOKEN.replace("L", "M"), `${TOKEN}0`, ""]) {
      const res = await app.request(`/auth?t=${t}`, { headers: { host: HOST } });
      expect(res.status, t).toBe(403);
    }
    expect((await app.request("/auth", { headers: { host: HOST } })).status).toBe(403);
    await login(app); // the right token still works
  });

  it("sets a session-only cookie and sends the session value in the hash", async () => {
    const app = make();
    const res = await app.request(`/auth?t=${TOKEN}`, { headers: { host: HOST } });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/#s=[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^finos_ui_8765=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("refuses a first use after 60 seconds", async () => {
    const app = make();
    clock += 60_001;

    const res = await app.request(`/auth?t=${TOKEN}`, { headers: { host: HOST } });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("expired");
  });

  it("revokes the session and stops the server on a second use of the token", async () => {
    const app = make();
    const session = await login(app);
    expect((await app.request("/api/meta", { headers: api(session) })).status).toBe(200);

    const again = await app.request(`/auth?t=${TOKEN}`, { headers: { host: HOST } });

    expect(again.status).toBe(403);
    const text = "This launch link was used twice. The UI server stopped. Start it again.";
    expect(((await again.json()) as { error: string }).error).toBe(text);
    expect(stop).toHaveBeenCalledWith(text);
    expect((await app.request("/api/meta", { headers: api(session) })).status).toBe(401);
    expect((await app.request("/", { headers: api(session) })).status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });
});

describe("the session", () => {
  it("uses two separate values for the cookie and X-Finos-Session", async () => {
    const app = make();
    const session = await login(app);

    expect(session.cookieValue).not.toBe(session.value);
    const res = await app.request("/api/meta", { headers: api(session, { "x-finos-session": session.cookieValue }) });
    expect(res.status).toBe(403);
  });

  it("needs the cookie of this port's name for every route but /auth", async () => {
    const app = make();
    const session = await login(app);
    const otherPort = `finos_ui_9999=${session.cookieValue}`;

    for (const path of ["/", "/assets/app-1.js", "/api/meta"]) {
      expect((await app.request(path, { headers: { host: HOST } })).status, path).toBe(401);
      expect((await app.request(path, { headers: api(session, { cookie: otherPort }) })).status, path).toBe(401);
      expect((await app.request(path, { headers: api(session, { cookie: "finos_ui_8765=nope" }) })).status, path).toBe(401);
    }
  });

  it("needs X-Finos-Session on /api and refuses a cross-site fetch", async () => {
    const app = make();
    const session = await login(app);
    const without = { host: HOST, cookie: session.cookie };

    expect((await app.request("/api/meta", { headers: without })).status).toBe(403);
    expect((await app.request("/api/meta", { headers: api(session, { "x-finos-session": "wrong" }) })).status).toBe(403);
    for (const value of ["same-site", "cross-site", "none"]) {
      const res = await app.request("/api/meta", { headers: api(session, { "sec-fetch-site": value }) });
      expect(res.status, value).toBe(403);
    }
    expect((await app.request("/api/meta", { headers: api(session, { "sec-fetch-site": "same-origin" }) })).status).toBe(200);
  });
});

describe("POST /agent", () => {
  it("passes a good request to the agent handler", async () => {
    const app = make();
    const session = await login(app);

    const res = await app.request("/agent", agentPost(session, '{"threadId":"t"}'));

    expect(res.status).toBe(200);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0]![0]).toEqual({ threadId: "t" });
  });

  it.each([
    [undefined], ["http://localhost:8765"], ["http://127.0.0.1:9999"],
    ["http://127.0.0.1:8765.evil.example"], ["null"], ["https://127.0.0.1:8765"],
  ])("refuses Origin %s", async (origin) => {
    const app = make();
    const session = await login(app);
    const init = agentPost(session, "{}");
    if (origin === undefined) delete (init.headers as Record<string, string>).origin;
    else (init.headers as Record<string, string>).origin = origin;

    expect((await app.request("/agent", init)).status).toBe(403);
    expect(agent).not.toHaveBeenCalled();
  });

  it("needs application/json, the session value and a body of 64 KiB at most", async () => {
    const app = make();
    const session = await login(app);

    const text = await app.request("/agent", agentPost(session, "{}", { "content-type": "text/plain" }));
    expect(text.status).toBe(415);
    const noSession = agentPost(session, "{}");
    delete (noSession.headers as Record<string, string>)["x-finos-session"];
    expect((await app.request("/agent", noSession)).status).toBe(403);
    const big = await app.request("/agent", agentPost(session, `"${"x".repeat(65 * 1024)}"`));
    expect(big.status).toBe(413);
    const bad = await app.request("/agent", agentPost(session, "{not json"));
    expect(bad.status).toBe(400);
    expect(agent).not.toHaveBeenCalled();
  });

  it("counts the bytes it reads, not a Content-Length that lies", async () => {
    const app = make();
    const session = await login(app);
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const init = { ...agentPost(session, body, { "content-length": "10" }), duplex: "half" };

    const res = await app.request("/agent", init as RequestInit);

    expect(res.status).toBe(413);
    expect(agent).not.toHaveBeenCalled();
  });

  it("answers 503 while the chat is not built", async () => {
    const app = make({ agent: undefined });
    const session = await login(app);

    expect((await app.request("/agent", agentPost(session, "{}"))).status).toBe(503);
  });
});

describe("the headers of every response", () => {
  it("hold the CSP, nosniff, no-referrer and no-store, and no CORS header", async () => {
    const app = make();
    const session = await login(app);
    const responses = [
      await app.request("/", { headers: { host: "evil.example" } }),
      await app.request("/auth?t=bad", { headers: { host: HOST } }),
      await app.request("/", { headers: api(session) }),
      await app.request("/assets/app-1.js", { headers: api(session) }),
      await app.request("/api/meta", { headers: api(session) }),
      await app.request("/api/nothing", { headers: api(session) }),
      await app.request("/agent", agentPost(session, "{}")),
    ];

    for (const res of responses) {
      expect(res.headers.get("content-security-policy")).toBe(CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    }
  });

  it("keep a strict CSP", () => {
    const parts = Object.fromEntries(CSP.split("; ").map((p) => [p.split(" ")[0], p.slice(p.indexOf(" ") + 1)]));

    expect(parts["script-src"]).toBe("'self'");
    // E3.1.6: Recharts needs no inline style, so style-src stays 'self'.
    expect(parts["style-src"]).toBe("'self'");
    expect(CSP).not.toMatch(/unsafe-eval/);
    expect(parts["script-src"]).not.toMatch(/unsafe-inline/);
    expect(parts["default-src"]).toBe("'self'");
    expect(parts["connect-src"]).toBe("'self'");
    expect(parts["base-uri"]).toBe("'none'");
    expect(parts["form-action"]).toBe("'none'");
    expect(parts["object-src"]).toBe("'none'");
    expect(parts["frame-ancestors"]).toBe("'none'");
  });
});

describe("static files", () => {
  it("serves index.html unchanged and the assets listed at start-up only", async () => {
    const app = make();
    const session = await login(app);

    const index = await app.request("/", { headers: api(session) });
    expect(await index.text()).toBe(INDEX);
    expect(index.headers.get("content-type")).toMatch(/^text\/html/);
    const js = await app.request("/assets/app-1.js", { headers: api(session) });
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    writeFileSync(join(site.dist, "assets", "late.js"), "1");
    for (const path of [
      "/assets/../package.json", "/assets/%2e%2e/x", "/assets/..%2fx", "/assets/app-1.js%2f",
      "/assets%2fapp-1.js", "/assets/late.js", "/index.html/", "/package.json",
    ]) {
      expect((await app.request(path, { headers: api(session) })).status, path).toBe(404);
    }
  });

  it("holds neither the launch token nor the session value in any body", async () => {
    const app = make();
    const session = await login(app);
    for (const path of ["/", "/assets/app-1.js", "/api/meta", "/api/health", "/nothing"]) {
      const body = await (await app.request(path, { headers: api(session) })).text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(session.value);
      expect(body).not.toContain(session.cookieValue);
    }
  });
});

describe("the dashboard API", () => {
  it("answers each endpoint with the record's figures and the budget in use", async () => {
    const app = make({ budgetUsd: "250" });
    const session = await login(app);
    const get = async (path: string) => {
      const res = await app.request(path, { headers: api(session) });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      return res.json();
    };

    expect(await get("/api/meta")).toEqual({
      schema_version: "0009_ai_usage_text", months: ["2026-08-01", "2026-09-01"],
      spent_this_month: "2.3500", budget_usd: "250",
    });
    expect(await get("/api/summary?spread=1&months=12")).toEqual(EXPECTED.months.spread);
    expect(record.months).toHaveBeenLastCalledWith({ spread: true, last: 12 });
    expect(await get("/api/summary")).toEqual(EXPECTED.months.cash);
    expect(await get("/api/month/2026-09?spread=0")).toEqual(EXPECTED.month.cash["2026-09"]);
    expect(record.month).toHaveBeenLastCalledWith("2026-09-01", { spread: false });
    expect(await get("/api/goals")).toEqual(EXPECTED.goals);
    expect(await get("/api/spreads")).toEqual(EXPECTED.spreads);
    expect(await get("/api/health")).toEqual(EXPECTED.health);
  });

  it.each([
    "/api/month/2026-13", "/api/month/26-09", "/api/month/2026-09?spread=2",
    "/api/summary?months=0", "/api/summary?months=61", "/api/summary?months=1.5",
    "/api/summary?spread=yes",
  ])("answers 400 with a plain message to %s", async (path) => {
    const app = make();
    const session = await login(app);

    const res = await app.request(path, { headers: api(session) });

    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()) as object)).toEqual(["error"]);
  });

  it("answers 404 for a month with no statement", async () => {
    const app = make();
    const session = await login(app);

    expect((await app.request("/api/month/2020-01", { headers: api(session) })).status).toBe(404);
  });

  it("answers 500 with a plain message, no stack, header or SQL, when a handler throws", async () => {
    const failing = { ...record, health: vi.fn(async () => {
      throw Object.assign(new Error("select narration from transactions; sk-ant-FAKE"), {
        headers: { "neon-connection-string": "postgresql://u:FAKEPASS@h/db" },
      });
    }) };
    const app = make({ record: failing } as Partial<AppDeps>);
    const session = await login(app);

    const res = await app.request("/api/health", { headers: api(session) });

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "The server could not answer this request." });
    expect(body).not.toMatch(/narration|FAKE|at /);
  });
});

describe("logging", () => {
  let spies: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    spies = [
      ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      ),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));
  const written = () => spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(" "))).join("\n");

  // The app code logs nothing. This loads no SDK: the SDK's ANTHROPIC_LOG is covered by the
  // boot-order test (boot.test.ts) and by the E2 client test.
  it("app code writes nothing in a full session, and hardenEnv drops ANTHROPIC_LOG", async () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_LOG: "debug", HOME: "/h" };
    hardenEnv({ env, execArgv: [] });
    expect(env.ANTHROPIC_LOG).toBeUndefined();
    const app = make();
    const session = await login(app);
    for (const path of ["/", "/assets/app-1.js", "/api/meta", "/api/summary", "/api/month/2026-09",
      "/api/goals", "/api/spreads", "/api/health", "/api/month/bad", "/nothing"]) {
      await app.request(path, { headers: api(session) });
    }
    await app.request("/agent", agentPost(session, "{}"));
    await app.request(`/auth?t=${TOKEN}`, { headers: { host: HOST } });

    expect(written()).toBe("");
  });

  it("writes only the fixed line for an error with secrets in it, however it is thrown", async () => {
    const secretError = () => Object.assign(
      new Error("sk-ant-FAKEKEY postgresql://finos_ui:FAKEPASS@h/db dp.st.ui.FAKETOKEN"),
      { cause: "dp.st.ui.FAKETOKEN", headers: { authorization: "Bearer dp.st.ui.FAKETOKEN" } },
    );
    const failing = { ...record, meta: vi.fn(async () => { throw secretError(); }) };
    const app = make({ record: failing } as Partial<AppDeps>);
    const session = await login(app);
    await app.request("/api/meta", { headers: api(session) });
    const handlers = new Map<string, (e: unknown) => void>();
    installErrorHandlers({
      on: (event, handler) => handlers.set(event, handler),
      exit: () => {},
      stderr: process.stderr,
    });
    handlers.get("unhandledRejection")!(secretError());
    handlers.get("uncaughtException")!(secretError());

    expect(written()).toBe(`${FIXED_ERROR_LINE}\n\n${FIXED_ERROR_LINE}\n`);
  });
});

describe("listWeb", () => {
  it("serves only index.html and the files under assets with a known type", () => {
    const { dist } = web();
    writeFileSync(join(dist, "secret.txt"), "x");
    writeFileSync(join(dist, "assets", "notes.unknown"), "x");

    expect([...listWeb(dist).keys()].sort()).toEqual(["/", "/assets/app-1.css", "/assets/app-1.js"]);
  });

  it("stops with the build command when index.html is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "dist-"));

    expect(() => listWeb(empty)).toThrow("Run `npm --prefix ui run build`");
  });
});

