// The HTTP surface on 127.0.0.1:<port> (S3). Only the browser tab that the server opened can
// use the API:
// - Host must be 127.0.0.1:<port> on every route, /auth and static files included (421 first:
//   DNS rebinding). No "localhost": it can resolve to ::1, which another process can hold.
// - /auth takes the one-time launch token (60 s) and makes the one session of this process. A
//   second use of the token revokes the session and stops the server.
// - The session is two separate random values: a cookie (cookies are not port-scoped, so a
//   listener on another 127.0.0.1 port can get it) and X-Finos-Session, which the page keeps in
//   port-scoped sessionStorage. /api and /agent need both.
// - Static files come from a map made at start-up; no path from the URL reaches the disk.
// Nothing here logs: no request log, and onError answers with fixed text.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { StartError } from "./errors.js";
import { type Record_, parseMonth } from "./record.js";

// style-src 'self' only (E3.1.6, decided). Recharts draws SVG and sets style through React's
// style prop, which writes element.style (the CSSOM); CSP style-src does not restrict that, only
// style attributes in markup and <style> elements. A Chromium run of the built page, light and
// dark, with this CSP reported no violation. Never 'unsafe-inline' for scripts or styles.
// (zod's Function("") probe would be a script-src violation; ui/web/src/zod.ts turns it off.)
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "img-src 'self' data:", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LAUNCH_SECONDS = 60;
const BODY_LIMIT = 64 * 1024;
const USED_TWICE = "This launch link was used twice. The UI server stopped. Start it again.";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
};

export type WebFile = { body: Uint8Array<ArrayBuffer>; type: string };
export type AgentHandler = (input: unknown, c: Context) => Response | Promise<Response>;

export type AppDeps = {
  port: number;
  record: Pick<Record_, "meta" | "months" | "month" | "goals" | "spreads" | "health">;
  budgetUsd: string; // FINOS_AI_BUDGET_USD in use, shown by /api/meta
  launchToken: string;
  issuedAt: number; // ms, when the launch link was made
  now: () => number;
  stop: (reason: string) => void;
  web: Map<string, WebFile>;
  agent?: AgentHandler; // POST /agent, from E2
};

/** A file read once at start-up, copied into its own ArrayBuffer (readFileSync may pool). */
function copy(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(path));
}

/** The files the server may serve: index.html as "/", and the files under assets/. */
export function listWeb(dist: string): Map<string, WebFile> {
  const files = new Map<string, WebFile>();
  try {
    files.set("/", { body: copy(join(dist, "index.html")), type: TYPES[".html"]! });
  } catch {
    throw new StartError("The web app is not built. Run `npm --prefix ui run build` first.");
  }
  const walk = (dir: string, prefix: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else if (TYPES[extname(name)] && /^[A-Za-z0-9._-]+$/.test(name)) {
        files.set(`${prefix}${name}`, { body: copy(path), type: TYPES[extname(name)]! });
      }
    }
  };
  walk(join(dist, "assets"), "/assets/");
  return files;
}

/** Equal strings, compared in constant time; false for unequal lengths (no throw). */
function same(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const fail = (c: Context, status: 400 | 401 | 403 | 404 | 413 | 415 | 421 | 500 | 503, error: string) =>
  c.json({ error }, status);

export function createApp(deps: AppDeps) {
  const host = `127.0.0.1:${deps.port}`;
  const origin = `http://${host}`;
  const cookieName = `finos_ui_${deps.port}`;
  let tokenUsed = false;
  let session: { cookie: string; value: string } | null = null;

  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", CSP);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.use(async (c, next) => {
    if (c.req.header("host") !== host) return fail(c, 421, "This server answers 127.0.0.1 only.");
    return next();
  });

  app.get("/auth", (c) => {
    const given = c.req.query("t");
    if (!same(given, deps.launchToken)) return fail(c, 403, "This launch link is not valid.");
    if (tokenUsed) {
      session = null;
      deps.stop(USED_TWICE);
      return fail(c, 403, USED_TWICE);
    }
    if (deps.now() - deps.issuedAt > LAUNCH_SECONDS * 1000) {
      return fail(c, 403, "This launch link expired. Start the UI server again.");
    }
    tokenUsed = true;
    session = {
      cookie: randomBytes(32).toString("base64url"),
      value: randomBytes(32).toString("base64url"),
    };
    c.header("Set-Cookie", `${cookieName}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/`);
    return c.redirect(`/#s=${session.value}`, 303);
  });

  // Every other route: the session cookie of this port.
  app.use(async (c, next) => {
    if (!session || !same(getCookie(c, cookieName), session.cookie)) {
      return fail(c, 401, "No session. Stop the UI server and start it again.");
    }
    return next();
  });

  // The API and the chat: also the second value, and a same-origin fetch.
  const secondFactor = async (c: Context, next: () => Promise<void>) => {
    const value = c.req.header("x-finos-session");
    if (!session || same(value, session.cookie) || !same(value, session.value)) {
      return fail(c, 403, "Session ended. Stop the UI server and start it again.");
    }
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      return fail(c, 403, "Only the page of this server may call it.");
    }
    return next();
  };
  app.use("/api/*", secondFactor);
  app.use("/agent", secondFactor);

  const spreadParam = (c: Context): boolean | null => {
    const value = c.req.query("spread") ?? "0";
    return value === "0" ? false : value === "1" ? true : null;
  };

  app.get("/api/meta", async (c) =>
    c.json({ ...(await deps.record.meta()), budget_usd: deps.budgetUsd }),
  );

  app.get("/api/summary", async (c) => {
    const spread = spreadParam(c);
    const months = c.req.query("months") ?? "12";
    if (spread === null) return fail(c, 400, "spread is 0 or 1.");
    if (!/^[0-9]{1,2}$/.test(months) || Number(months) < 1 || Number(months) > 60) {
      return fail(c, 400, "months is a whole number from 1 to 60.");
    }
    return c.json(await deps.record.months({ spread, last: Number(months) }));
  });

  app.get("/api/month/:month", async (c) => {
    const spread = spreadParam(c);
    const month = parseMonth(c.req.param("month"));
    if (spread === null) return fail(c, 400, "spread is 0 or 1.");
    if (!month) return fail(c, 400, "Write the month as YYYY-MM.");
    const view = await deps.record.month(month, { spread });
    return view ? c.json(view) : fail(c, 404, "No statement covers that month.");
  });

  app.get("/api/goals", async (c) => c.json(await deps.record.goals()));
  app.get("/api/spreads", async (c) => c.json(await deps.record.spreads()));
  app.get("/api/health", async (c) => c.json(await deps.record.health()));

  app.post("/agent", async (c) => {
    if (c.req.header("origin") !== origin) return fail(c, 403, "Only the page of this server may call it.");
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return fail(c, 415, "The chat takes application/json.");
    const text = await readBody(c.req.raw, BODY_LIMIT);
    if (text === null) return fail(c, 413, "The request is larger than 64 KiB.");
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return fail(c, 400, "The request is not valid JSON.");
    }
    if (!deps.agent) return fail(c, 503, "The chat is not built yet.");
    return deps.agent(input, c);
  });

  app.get("*", (c) => {
    // The raw path, not a decoded one: "/assets/%2e%2e/x" matches no listed file.
    const file = deps.web.get(new URL(c.req.url).pathname);
    if (!file) return fail(c, 404, "Not found.");
    return c.body(file.body, 200, { "Content-Type": file.type });
  });

  app.notFound((c) => fail(c, 404, "Not found."));
  app.onError((_error, c) => fail(c, 500, "The server could not answer this request."));
  return app;
}

/** The body as text, or null when it passes limit bytes. It counts the bytes read; a
 * Content-Length header is checked too, but never trusted alone. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
