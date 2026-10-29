// The start of the laptop UI server (npm --prefix ui run ui), and ui-check, which runs the same
// checks and stops before it listens. Only the user runs either, on the macOS laptop; never in
// a cloud session (CLAUDE.md).
//
// Order: the Keychain token, the Doppler download, the connection string check, the role
// check, the schema gate, listen on 127.0.0.1, then open the one-time launch link. The server
// prints only "Started on port N"; the link goes to /usr/bin/open, never to stdout.
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ServerType, serve } from "@hono/node-server";
import { createAgent } from "./agent.js";
import { createAnthropic } from "./anthropic.js";
import { createApp, listWeb } from "./app.js";
import { parseBudget } from "./cost.js";
import { checkConnectionString, checkNeonHost, checkRole, createDb, type FetchFunction, schemaGate } from "./db.js";
import { type Fetch, loadSecrets } from "./doppler.js";
import { DbError, StartError } from "./errors.js";
import { type ExecFile, KEYCHAIN_ITEM, readToken } from "./keychain.js";
import { createRecord } from "./record.js";

const DEFAULT_PORT = 8765;

type Writer = { write(text: string): unknown };
type Signals = { once(event: "SIGINT" | "SIGTERM", handler: () => void): unknown };

export type StartDeps = {
  env: Record<string, string | undefined>;
  home: string;
  execFile: ExecFile; // for the Keychain reader only
  fetch: Fetch; // the Doppler download
  neonFetch: FetchFunction;
  anthropicFetch: Fetch; // the chat's model calls; the client in anthropic.ts locks it to one host
  openBrowser: (url: string) => Promise<void>;
  out: Writer;
  err: Writer;
  webDist: string;
  migrationsDir: string;
  signals: Signals;
};

export type Flags = { check: boolean; port: number };

/** FINOS_NEON_HOST (host only) and FINOS_AI_BUDGET_USD (default 100, more than 0). */
export function settings(env: Record<string, string | undefined>) {
  const host = (env.FINOS_NEON_HOST ?? "").trim();
  if (!host) {
    throw new StartError(
      "Set FINOS_NEON_HOST in the shell profile: the Neon host only, " +
        "e.g. ep-quiet-sky-123456.c-2.<region>.aws.neon.tech",
    );
  }
  return { neonHost: checkNeonHost(host), budgetUsd: parseBudget(env.FINOS_AI_BUDGET_USD) };
}

export async function start(flags: Flags, deps: StartDeps) {
  if (!flags.check) return serveUi(flags, deps);
  // ui-check: a failed check is a line on stderr and exit 1, as a check tool gives.
  try {
    return await serveUi(flags, deps);
  } catch (error) {
    if (!(error instanceof StartError)) throw error;
    deps.err.write(`${error.message}\n`);
    return { server: null, done: Promise.resolve(1) };
  }
}

async function serveUi(flags: Flags, deps: StartDeps) {
  const { neonHost, budgetUsd } = settings(deps.env);
  const say = (line: string) => {
    if (flags.check) deps.out.write(`${line}\n`);
  };
  // Before the Keychain prompt: without the web app there is nothing to serve.
  const web = flags.check ? new Map() : listWeb(deps.webDist);

  const token = await readToken({ execFile: deps.execFile, home: deps.home });
  say(`Keychain item ${KEYCHAIN_ITEM}: found`);
  say("Token: a service token of config ui");
  const secrets = await loadSecrets({ token, fetch: deps.fetch });
  say("Doppler config: project finos, environment ui, config ui");
  say(`Secrets: ${secrets.names.join(", ")}`);
  checkConnectionString(secrets.neonUrl, neonHost);
  say("NEON_READONLY_URL: role finos_ui, host and sslmode ok");
  const db = createDb({ url: secrets.neonUrl, fetchFunction: deps.neonFetch });
  await checkRole(db);
  say("Role: transactions refused");
  const version = await schemaGate(db, deps.migrationsDir);
  say(`Schema version: ${version}`);
  const record = createRecord(db);

  if (flags.check) {
    const { spent_this_month } = await record.meta();
    say(`FINOS_AI_BUDGET_USD: ${budgetUsd} in use, ${spent_this_month} spent this month`);
    return { server: null, done: Promise.resolve(0) };
  }

  // The key goes from its Secret into the client and nowhere else; the chat checks the shared
  // budget before each call and records each call's cost through the UI role.
  const chat = createAnthropic({ key: secrets.anthropicKey, fetch: deps.anthropicFetch });
  const agent = createAgent({ record, db, client: chat, budgetUsd });

  const launchToken = randomBytes(32).toString("base64url");
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => (finish = resolve));
  let server: ServerType | null = null;
  const stop = (code: number) => {
    server?.close();
    finish(code);
  };
  const app = createApp({
    port: flags.port,
    record,
    budgetUsd,
    launchToken,
    issuedAt: Date.now(),
    now: Date.now,
    web,
    agent,
    stop: (reason) => {
      deps.err.write(`${reason}\n`);
      stop(1);
    },
  });
  server = await listen(app.fetch, flags.port);
  deps.signals.once("SIGINT", () => stop(0));
  deps.signals.once("SIGTERM", () => stop(0));
  deps.out.write(`Started on port ${flags.port}\n`);
  try {
    await deps.openBrowser(`http://127.0.0.1:${flags.port}/auth?t=${launchToken}`);
  } catch {
    // Without the link nobody can sign in; a listening server would keep the process alive.
    await new Promise((resolve) => server!.close(resolve));
    finish(1);
    throw new StartError("The browser did not open the launch link. Start the UI server again.");
  }
  return { server, done };
}

function listen(fetch: (request: Request) => Response | Promise<Response>, port: number) {
  return new Promise<ServerType>((resolve, reject) => {
    // Without hostname, @hono/node-server listens on every interface.
    const server = serve({ fetch, port, hostname: "127.0.0.1" });
    server.once("listening", () => resolve(server));
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new StartError(
          error.code === "EADDRINUSE"
            ? `Port ${port} is in use. Stop the program that uses it, or start with --port N.`
            : `The UI server could not listen on 127.0.0.1:${port}.`,
        ),
      );
    });
  });
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { check: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") flags.check = true;
    else if (arg === "--port" && /^[0-9]{4,5}$/.test(argv[i + 1] ?? "")) flags.port = Number(argv[++i]);
    else throw new StartError("The UI server takes --check and --port N only.");
  }
  if (flags.port < 1024 || flags.port > 65535) throw new StartError("--port is 1024 to 65535.");
  return flags;
}

/** boot.ts calls this with the command's arguments; it returns the exit code. */
export async function run(argv: string[]): Promise<number> {
  const execFile = promisify(execFileCallback) as unknown as ExecFile;
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  try {
    const started = await start(parseFlags(argv), {
      env: process.env,
      home: homedir(),
      execFile,
      fetch: (url, init) => globalThis.fetch(url, init),
      neonFetch: (url, init) => globalThis.fetch(url, init),
      anthropicFetch: (url, init) => globalThis.fetch(url, init),
      openBrowser: async (url) => {
        await execFile("/usr/bin/open", [url], {
          env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
        });
      },
      out: process.stdout,
      err: process.stderr,
      // From ui/server/dist: the web build and the repository's migrations.
      webDist: here("../../web/dist"),
      migrationsDir: here("../../../src/finos/migrations"),
      signals: process,
    });
    return await started.done;
  } catch (error) {
    process.stderr.write(`${startFailure(error)}\n`);
    return 1;
  }
}

/**
 * The line for a failed start. Only our own fixed texts are shown in full. Any other error adds
 * its class name and its code (a SQLSTATE, or a Node code such as ENOENT) when they have a plain
 * shape: never its message, which can hold a path, a response body or part of a secret.
 */
export function startFailure(error: unknown): string {
  if (error instanceof StartError || error instanceof DbError) return error.message;
  const parts: string[] = [];
  const name = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  if (typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name)) parts.push(name);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) parts.push(`code ${code}`);
  return parts.length ? `The UI server could not start (${parts.join(", ")}).` : "The UI server could not start.";
}
