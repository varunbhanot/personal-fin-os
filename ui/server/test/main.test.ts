// The start sequence of ui and ui-check, with fakes for the Keychain, Doppler, Neon (the
// emulator) and /usr/bin/open. No real secret, Keychain or network.
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type StartDeps, settings, start } from "../src/main.js";
import { NeonEmulator } from "./emulator.js";
import { MIGRATIONS } from "./global-setup.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const HOST = "ep-quiet-sky-123456.c-2.ap-south-1.aws.neon.tech";
const TOKEN = "dp.st.ui.FAKETOKEN123";
const KEY = "sk-ant-FAKEKEY-0000";
const NEON_URL = `postgresql://finos_ui:FAKEPASS@${HOST}/neondb?sslmode=require`;
const SECRETS = {
  DOPPLER_PROJECT: "finos", DOPPLER_ENVIRONMENT: "ui", DOPPLER_CONFIG: "ui",
  ANTHROPIC_KEY: KEY, NEON_READONLY_URL: NEON_URL,
};

describe("settings", () => {
  it("reads FINOS_NEON_HOST and FINOS_AI_BUDGET_USD (default 100)", () => {
    expect(settings({ FINOS_NEON_HOST: HOST })).toEqual({ neonHost: HOST, budgetUsd: "100" });
    expect(settings({ FINOS_NEON_HOST: HOST, FINOS_AI_BUDGET_USD: "250.50" }).budgetUsd).toBe("250.50");
  });

  it.each(["0", "-5", "abc", "1e3", "0.00", ""])("refuses FINOS_AI_BUDGET_USD=%j", (value) => {
    expect(() => settings({ FINOS_NEON_HOST: HOST, FINOS_AI_BUDGET_USD: value })).toThrow(
      "FINOS_AI_BUDGET_USD",
    );
  });

  it("needs FINOS_NEON_HOST", () => {
    expect(() => settings({})).toThrow("FINOS_NEON_HOST");
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function send(
  port: number, method: string, path: string, headers: Record<string, string> = {}, payload?: string,
) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(payload);
    },
  );
}

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  send(port, "GET", path, headers);

describe.skipIf(!pgAdmin)(`start (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(() => database?.drop());

  function deps(extra: Partial<StartDeps> = {}) {
    const order: string[] = [];
    const neon = new NeonEmulator(database.config);
    const out: string[] = [];
    const err: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const dist = mkdtempSync(join(tmpdir(), "dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>t</title>");
    mkdirSync(join(dist, "assets"));
    const opened: string[] = [];
    const signals = new EventEmitter();
    const all: StartDeps = {
      env: { FINOS_NEON_HOST: HOST },
      home,
      execFile: vi.fn(async () => {
        order.push("keychain");
        return { stdout: `${TOKEN}\n` };
      }),
      fetch: vi.fn(async () => {
        order.push("doppler");
        return Response.json(SECRETS);
      }),
      neonFetch: async (url: string, init: RequestInit) => {
        order.push("neon");
        return neon.fetchFunction(url, init);
      },
      anthropicFetch: vi.fn(async () => {
        throw new Error("the chat is not used by this test");
      }),
      openBrowser: vi.fn(async (url: string) => {
        order.push("open");
        opened.push(url);
      }),
      out: { write: (t: string) => (out.push(t), true) },
      err: { write: (t: string) => (err.push(t), true) },
      webDist: dist,
      migrationsDir: MIGRATIONS,
      signals,
      ...extra,
    };
    return { all, order, out, err, opened, signals, home, neon };
  }

  it("runs token, Doppler, checks, listen on 127.0.0.1, then opens the launch link", async () => {
    const d = deps();
    const port = await freePort();

    const started = await start({ check: false, port }, d.all);

    expect(started.server!.address()).toMatchObject({ address: "127.0.0.1", port });
    expect(d.order[0]).toBe("keychain");
    expect(d.order[1]).toBe("doppler");
    expect(d.order.at(-1)).toBe("open");
    expect(d.order.filter((o) => o === "neon").length).toBeGreaterThanOrEqual(2);
    expect(d.opened).toEqual([expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:${port}/auth\\?t=[A-Za-z0-9_-]{43}$`))]);
    expect(d.out.join("")).toBe(`Started on port ${port}\n`);
    expect(d.err.join("")).toBe("");

    // The link works once, over a real socket, after the server is ready.
    const auth = await get(port, new URL(d.opened[0]!).pathname + new URL(d.opened[0]!).search, {
      host: `127.0.0.1:${port}`,
    });
    expect(auth.status).toBe(303);

    d.signals.emit("SIGINT");
    expect(await started.done).toBe(0);
    expect(readdirSync(d.home)).toEqual([]);
    const shown = d.out.join("") + d.err.join("");
    for (const secret of [TOKEN, KEY, "FAKEPASS", new URL(d.opened[0]!).searchParams.get("t")!]) {
      expect(shown).not.toContain(secret);
    }
  });

  it("wires the chat: POST /agent reaches the agent, and the model client sends only the key of config ui", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const d = deps({
      anthropicFetch: vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: new Headers(init.headers) });
        return Response.json({ type: "error", error: { type: "authentication_error", message: "x" } }, { status: 401 });
      }),
    });
    const port = await freePort();
    const started = await start({ check: false, port }, d.all);
    const host = `127.0.0.1:${port}`;
    const link = new URL(d.opened[0]!);
    const auth = await send(port, "GET", link.pathname + link.search, { host });
    const cookie = String(auth.headers["set-cookie"]).split(";")[0]!;
    const session = String(auth.headers.location).replace("/#s=", "");
    const input = {
      threadId: "t", runId: "r", state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: "m", role: "user", content: "hello" }],
    };

    const res = await send(port, "POST", "/agent", {
      host, cookie, "x-finos-session": session, origin: `http://${host}`,
      "content-type": "application/json",
    }, JSON.stringify(input));

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    expect(res.body).toContain('"type":"RUN_STARTED"');
    expect(res.body).toContain('"type":"RUN_ERROR"');
    expect(res.body).toContain("ANTHROPIC_KEY in Doppler config ui");
    expect(res.body).not.toContain(KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers.get("x-api-key")).toBe(KEY);
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    d.signals.emit("SIGINT");
    await started.done;
    expect(d.out.join("") + d.err.join("")).not.toContain(KEY);
  });

  it("checks the connection string before any database call", async () => {
    const d = deps({
      fetch: vi.fn(async () => Response.json({ ...SECRETS, NEON_READONLY_URL: NEON_URL.replace("finos_ui:", "neondb_owner:") })),
    });

    await expect(start({ check: false, port: await freePort() }, d.all)).rejects.toThrow("neondb_owner");
    expect(d.order).not.toContain("neon");
    expect(d.all.openBrowser).not.toHaveBeenCalled();
  });

  it("refuses to start when the role can read transactions", async () => {
    const owner = new NeonEmulator(database.config, null);
    const d = deps({ neonFetch: owner.fetchFunction });

    await expect(start({ check: false, port: await freePort() }, d.all)).rejects.toThrow("can read transactions");
    expect(d.all.openBrowser).not.toHaveBeenCalled();
  });

  it("stops with the build command when index.html is missing, before the Keychain", async () => {
    const d = deps({ webDist: mkdtempSync(join(tmpdir(), "empty-")) });

    await expect(start({ check: false, port: await freePort() }, d.all)).rejects.toThrow(
      "Run `npm --prefix ui run build`",
    );
    expect(d.all.execFile).not.toHaveBeenCalled();
  });

  it("gives a plain message for a port in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as { port: number };
    const d = deps();

    await expect(start({ check: false, port }, d.all)).rejects.toThrow(`Port ${port} is in use`);
    blocker.close();
    expect(d.all.openBrowser).not.toHaveBeenCalled();
  });

  it("closes the port and stops with a plain message when the browser does not open", async () => {
    const port = await freePort();
    const d = deps({
      openBrowser: vi.fn(async (url: string) => {
        throw new Error(`open failed for ${url}`);
      }),
    });

    await expect(start({ check: false, port }, d.all)).rejects.toThrow(
      "The browser did not open the launch link",
    );
    // Nothing listens on the port, so the process can exit with code 1.
    await expect(get(port, "/", { host: `127.0.0.1:${port}` })).rejects.toThrow();
    expect(d.err.join("")).not.toContain("auth?t=");
  });

  it("ui-check runs the same checks, prints names and states only, and does not listen", async () => {
    const d = deps({ env: { FINOS_NEON_HOST: HOST, FINOS_AI_BUDGET_USD: "120" } });
    const port = await freePort();

    const result = await start({ check: true, port }, d.all);

    expect(result.server).toBeNull();
    expect(await result.done).toBe(0);
    expect(d.all.openBrowser).not.toHaveBeenCalled();
    const text = d.out.join("");
    for (const line of [
      "Keychain item finos-ui: found", "Token: a service token of config ui",
      "Doppler config: project finos, environment ui, config ui",
      "Secrets: ANTHROPIC_KEY, NEON_READONLY_URL", "NEON_READONLY_URL: role finos_ui, host and sslmode ok",
      "Role: transactions refused", "Schema version: 0009_ai_usage_text",
      "FINOS_AI_BUDGET_USD: 120 in use, 2.3500 spent this month",
    ]) {
      expect(text).toContain(line);
    }
    for (const secret of [TOKEN, KEY, "FAKEPASS"]) expect(text).not.toContain(secret);
    // Nothing listens on the port.
    await expect(get(port, "/", { host: `127.0.0.1:${port}` })).rejects.toThrow();
  });

  it("ui-check exits 1 when the role can read transactions", async () => {
    const owner = new NeonEmulator(database.config, null);
    const d = deps({ neonFetch: owner.fetchFunction });

    const result = await start({ check: true, port: await freePort() }, d.all);

    expect(await result.done).toBe(1);
    expect(d.err.join("")).toContain("can read transactions");
  });

  it("stops the server when the launch link is used twice", async () => {
    const d = deps();
    const port = await freePort();
    const started = await start({ check: false, port }, d.all);
    const link = new URL(d.opened[0]!);
    const path = link.pathname + link.search;
    const headers = { host: `127.0.0.1:${port}` };

    expect((await get(port, path, headers)).status).toBe(303);
    expect((await get(port, path, headers)).status).toBe(403);

    expect(await started.done).toBe(1);
    expect(d.err.join("")).toContain("used twice");
  });
});
