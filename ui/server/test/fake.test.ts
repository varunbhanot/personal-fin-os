// E5.2: the fake backend. The real createApp over the golden record (tests/ui_golden/expected.json)
// and a scripted fake Claude. It installs the S8 guard itself, so it never reaches the Keychain,
// Doppler, Neon or Anthropic. Here: open /auth, call every /api route, run one chat, and check
// the events and the figures. Everything runs through app.request(), plus one real loopback socket.
import childProcess from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neonConfig } from "@neondatabase/serverless";
import { EventSchema } from "@ag-ui/core/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { listWeb } from "../src/app.js";
import { FAKE_TOKEN, createFake, installGuard, startFake } from "../src/fake.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8"),
);
const SOURCE = readFileSync(new URL("../src/fake.ts", import.meta.url), "utf8");
const PORT = 8791;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

function dist() {
  const dir = mkdtempSync(join(tmpdir(), "fake-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>finos</title>");
  writeFileSync(join(dir, "assets", "app-1.js"), "console.log(1)");
  return dir;
}

function fake(port = PORT) {
  return createFake({ port, web: listWeb(dist()), stop: () => {} });
}

async function login(app: ReturnType<typeof fake>["app"]) {
  const res = await app.request(`/auth?t=${FAKE_TOKEN}`, { headers: { host: HOST } });
  expect(res.status).toBe(303);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const value = res.headers.get("location")!.replace("/#s=", "");
  return { host: HOST, cookie, "x-finos-session": value };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe("the guard", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("makes fetch, the Neon driver's fetch and execFile refuse every call", async () => {
    const before = { fetch: globalThis.fetch, neon: neonConfig.fetchFunction, execFile: childProcess.execFile };
    restore = installGuard();
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(/fake backend/);
    await expect(neonConfig.fetchFunction("https://neon.example/sql", {})).rejects.toThrow(/fake backend/);
    expect(() => childProcess.execFile("/usr/bin/security", ["find-generic-password"])).toThrow(/fake backend/);
    expect(() => childProcess.execFileSync("/usr/bin/open", [])).toThrow(/fake backend/);
    expect(() => childProcess.spawn("/bin/true")).toThrow(/fake backend/);
    restore();
    restore = null;
    expect(globalThis.fetch).toBe(before.fetch);
    expect(neonConfig.fetchFunction).toBe(before.neon);
    expect(childProcess.execFile).toBe(before.execFile);
  });

  it("refuses through the node:child_process named export too (what keychain.ts uses)", async () => {
    restore = installGuard();
    const { execFile } = await import("node:child_process");
    expect(() => execFile("/usr/bin/security", [])).toThrow(/fake backend/);
  });
});

describe("the fake backend", () => {
  it("uses the real app, with the fixed test token, and refuses a wrong one", async () => {
    const { app } = fake();
    const bad = await app.request("/auth?t=wrong", { headers: { host: HOST } });
    expect(bad.status).toBe(403);
    expect((await app.request("/api/meta", { headers: { host: HOST } })).status).toBe(401);
    await login(app);
  });

  it("answers every /api route with the golden figures", async () => {
    const { app } = fake();
    const h = await login(app);
    const get = async (path: string) => {
      const res = await app.request(path, { headers: h });
      expect(res.status, path).toBe(200);
      return res.json() as Promise<any>;
    };

    const meta = await get("/api/meta");
    expect(meta.months).toEqual(EXPECTED.months.cash.map((m: any) => m.month));
    expect(meta.schema_version).toBe(EXPECTED.health.schema_version);
    expect(meta.budget_usd).toBe("100");
    expect(meta.spent_this_month).toBe("0");

    expect(await get("/api/summary?spread=0&months=12")).toEqual(EXPECTED.months.cash);
    expect(await get("/api/summary?spread=1&months=12")).toEqual(EXPECTED.months.spread);
    expect(await get("/api/summary?spread=0&months=1")).toEqual(EXPECTED.months.cash.slice(-1));
    expect(await get("/api/month/2026-09?spread=0")).toEqual(EXPECTED.month.cash["2026-09"]);
    expect(await get("/api/month/2026-08?spread=1")).toEqual(EXPECTED.month.spread["2026-08"]);
    expect(await get("/api/goals")).toEqual(EXPECTED.goals);
    expect(await get("/api/spreads")).toEqual(EXPECTED.spreads);
    expect(await get("/api/health")).toEqual(EXPECTED.health);

    const none = await app.request("/api/month/2020-01?spread=0", { headers: h });
    expect(none.status).toBe(404);
  });

  it("serves the web files it was given, and keeps the app's security headers", async () => {
    const { app } = fake();
    const h = await login(app);
    const page = await app.request("/", { headers: h });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await app.request("/assets/app-1.js", { headers: h })).status).toBe(200);
    expect((await app.request("/", { headers: { ...h, host: "evil.test" } })).status).toBe(421);
  });

  it("runs one scripted chat: a show_kpis round with the golden figures, then text", async () => {
    const { app } = fake();
    const h = await login(app);
    const body = {
      threadId: "t1", runId: "r1", state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: "m1", role: "user", content: "How did September go?" }],
    };
    const res = await app.request("/agent", {
      method: "POST", body: JSON.stringify(body),
      headers: { ...h, origin: ORIGIN, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text())
      .split("\n\n").filter(Boolean)
      .map((chunk) => EventSchema.parse(JSON.parse(chunk.replace(/^data: /, ""))));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types).not.toContain("RUN_ERROR");
    expect(types.filter((t) => t === "TOOL_CALL_START")).toHaveLength(1);
    const start = events.find((e) => e.type === "TOOL_CALL_START") as any;
    expect(start.toolCallName).toBe("show_kpis");

    const result = events.find((e) => e.type === "TOOL_CALL_RESULT") as any;
    const data = JSON.parse(result.content);
    const kpis = EXPECTED.month.cash["2026-09"].kpis;
    expect(data.component).toBe("kpis");
    expect(data.month).toBe("2026-09");
    expect(data.tiles.map((t: any) => [t.metric, t.value])).toEqual(
      ["income", "expenses", "savings", "investments"].map((m) => [m, kpis[m].value]),
    );

    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e: any) => e.delta).join("");
    expect(text).toContain("2026-09");

    // The scripted call cost is recorded in memory, and the next meta shows it.
    const meta = (await (await app.request("/api/meta", { headers: h })).json()) as any;
    expect(Number(meta.spent_this_month)).toBeGreaterThan(0);
  });

  it("answers a second question with the same script", async () => {
    const { app } = fake();
    const h = await login(app);
    const ask = async (runId: string) => {
      const res = await app.request("/agent", {
        method: "POST",
        body: JSON.stringify({
          threadId: "t1", runId, state: {}, tools: [], context: [], forwardedProps: {},
          messages: [{ id: runId, role: "user", content: "Again?" }],
        }),
        headers: { ...h, origin: ORIGIN, "content-type": "application/json" },
      });
      return res.text();
    };
    expect(await ask("r1")).toContain("RUN_FINISHED");
    expect(await ask("r2")).toContain("RUN_FINISHED");
  });

  it("leaks no planted text of the golden seed except the goal name the dashboard shows", async () => {
    const { app } = fake();
    const h = await login(app);
    const res = await app.request("/agent", {
      method: "POST",
      body: JSON.stringify({
        threadId: "t1", runId: "r1", state: {}, tools: [], context: [], forwardedProps: {},
        messages: [{ id: "m", role: "user", content: "Hi" }],
      }),
      headers: { ...h, origin: ORIGIN, "content-type": "application/json" },
    });
    expect(await res.text()).not.toMatch(/ZQX/i);
  });
});

describe("startFake", () => {
  it("listens on 127.0.0.1 only, prints the launch link with the test token, and stops", async () => {
    const port = await freePort();
    let out = "";
    const started = await startFake({
      port, webDist: dist(), out: { write: (text: string) => void (out += text) },
    });
    try {
      expect((started.server.address() as { address: string }).address).toBe("127.0.0.1");
      expect(out).toBe(`Fake backend: http://127.0.0.1:${port}/auth?t=${FAKE_TOKEN}\n`);
      // A real request over loopback, with a wrong Host: 421.
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/meta", headers: { host: "localhost" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.once("error", reject);
        req.end();
      });
      expect(status).toBe(421);
    } finally {
      started.stop();
      expect(await started.done).toBe(0);
    }
  });

  it("stops with 1 when the web app is not built", async () => {
    const port = await freePort();
    await expect(
      startFake({ port, webDist: join(tmpdir(), "no-such-dist"), out: { write: () => {} } }),
    ).rejects.toThrow(/npm --prefix ui run build/);
  });
});

describe("the source", () => {
  it("imports none of the secret-holding modules", () => {
    // A type-only import of Db is erased by tsc; any other import would load the module.
    expect(SOURCE).not.toMatch(/^import (?!type )[^\n]*from "\.\/(keychain|doppler|db|secret)\.js"/m);
    expect(SOURCE).not.toMatch(/NEON_READONLY_URL|ANTHROPIC_KEY|find-generic-password|api\.doppler\.com/);
  });

  it("starts the guard before anything else in its entry point", () => {
    expect(SOURCE).toMatch(/installGuard\(\);[\s\S]*startFake\(/);
  });
});
