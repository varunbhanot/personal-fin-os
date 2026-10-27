// The Neon client of the UI and its start checks. The role in NEON_READONLY_URL is finos_ui, a
// member of finos_ui_access (migration 0008): it reads only the safe views, so "never select a
// narration" is a grant. The server never runs DDL; migrations run from finos in the cloud.
//
// @neondatabase/serverless speaks the protocol of finos's NeonHttpDb: POST
// https://api.<region domain>/sql with Neon-Connection-String. Reads run in one read-only batch
// with a statement timeout. numeric, bigint and date stay strings, so no float or time zone
// drift; redirect: "error", so no other host ever gets the connection string.
import { readdirSync } from "node:fs";
import { neon, neonConfig } from "@neondatabase/serverless";
import { DbError, StartError } from "./errors.js";
import type { Secret } from "./secret.js";

export type Query = { text: string; params?: unknown[] };
export type Row = Record<string, unknown>;

/** One chat call for ai_usage: the columns that migration 0008 lets the UI role insert. */
export type UsageRow = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: string; // numeric(10, 4) as text
};

export interface Db {
  /** The queries in one read-only transaction; one list of rows per query. */
  read(queries: Query[]): Promise<Row[][]>;
  /** The one write of the UI: a chat call's cost, purpose "chat". It uses no RETURNING. */
  insertUsage(row: UsageRow): Promise<void>;
}

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

// ep-<name>[.c-<cell>].<region>.<cloud>.neon.tech, as finos.config checks FINOS_NEON_HOST.
const NEON_ENDPOINT = /^ep-[a-z0-9-]+(\.c-[0-9]+)?\.[a-z0-9-]+\.[a-z0-9-]+\.neon\.tech$/;
const UI_LOGIN = "finos_ui";
const PERMISSION_DENIED = "42501";
const REQUEST_MS = 15_000; // one request to Neon, then it fails
const INSERT_USAGE =
  "insert into ai_usage (purpose, model, input_tokens, output_tokens, cache_read_tokens, " +
  "cache_write_tokens, cost_usd) values ($1, $2, $3, $4, $5, $6, $7)";

// Booleans and int2/int4 become JS values; every other type stays the text Postgres sent.
const BOOL = 16;
const INTS = new Set([21, 23]);
const TYPES = {
  getTypeParser: (oid: number) =>
    oid === BOOL ? (v: string) => v === "t" : INTS.has(oid) ? Number : (v: string) => v,
};

export function checkNeonHost(host: string): string {
  if (host.includes("@") || host.includes("://")) {
    throw new StartError(
      "FINOS_NEON_HOST looks like a connection string. Set it to the host only, " +
        "e.g. ep-quiet-sky-123456.c-2.<region>.aws.neon.tech",
    );
  }
  if (!NEON_ENDPOINT.test(host)) {
    throw new StartError(
      "FINOS_NEON_HOST should be a Neon endpoint host such as " +
        "ep-quiet-sky-123456.c-2.<region>.aws.neon.tech",
    );
  }
  return host;
}

/** The rules for NEON_READONLY_URL. No message holds any part of the string. */
export function checkConnectionString(url: Secret, neonHost: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url.reveal());
  } catch {
    parsed = new URL("invalid:");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new StartError("NEON_READONLY_URL in Doppler config ui must be a postgresql:// URL.");
  }
  if (parsed.username === "neondb_owner") {
    throw new StartError(
      "NEON_READONLY_URL in Doppler config ui uses the owner role neondb_owner. " +
        `Use the read-only role ${UI_LOGIN}.`,
    );
  }
  if (parsed.username !== UI_LOGIN) {
    throw new StartError(`NEON_READONLY_URL in Doppler config ui must use the role ${UI_LOGIN}.`);
  }
  const [first, ...rest] = neonHost.split(".");
  const pooler = [`${first}-pooler`, ...rest].join(".");
  if (parsed.hostname !== neonHost && parsed.hostname !== pooler) {
    throw new StartError(
      "NEON_READONLY_URL in Doppler config ui must use the host in FINOS_NEON_HOST " +
        "(or its -pooler host).",
    );
  }
  const modes = parsed.searchParams.getAll("sslmode");
  if (modes.length !== 1 || modes[0] !== "require") {
    throw new StartError(
      "NEON_READONLY_URL in Doppler config ui must hold sslmode=require exactly once.",
    );
  }
}

export function createDb({ url, fetchFunction }: { url: Secret; fetchFunction: FetchFunction }) {
  const sql = neon(url.reveal(), { fetchOptions: { redirect: "error" } });
  // A fresh timeout for each request, so a hung request cannot hold the chat busy. The
  // redirect rule is given again: these options replace the client's fetchOptions.
  const fetchOptions = () => ({ redirect: "error", signal: AbortSignal.timeout(REQUEST_MS) });
  return {
    async read(queries: Query[]): Promise<Row[][]> {
      const batch = [
        sql.query("set local statement_timeout = '5s'", []),
        ...queries.map((q) => sql.query(q.text, q.params ?? [], { types: TYPES })),
      ];
      // The driver reads the fetch function from neonConfig when the request starts (before
      // its first await), so setting it here applies to this request only.
      neonConfig.fetchFunction = fetchFunction;
      try {
        const results = (await sql.transaction(batch, { readOnly: true, fetchOptions: fetchOptions() })) as Row[][];
        return results.slice(1);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        throw new DbError(typeof code === "string" ? code : "");
      }
    },

    async insertUsage(row: UsageRow): Promise<void> {
      neonConfig.fetchFunction = fetchFunction;
      try {
        // One statement, not a batch: it is not read only. Every value is a parameter.
        await sql.query(INSERT_USAGE, [
          "chat", row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens,
          row.cache_write_tokens, row.cost_usd,
        ], { fetchOptions: fetchOptions() });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        throw new DbError(typeof code === "string" ? code : "");
      }
    },
  } satisfies Db;
}

/** The UI's role must not read transactions: else it is not finos_ui (S1). */
export async function checkRole(db: Db): Promise<void> {
  try {
    await db.read([{ text: "select 1 from transactions limit 1" }]);
  } catch (error) {
    if (error instanceof DbError && error.code === PERMISSION_DENIED) return;
    throw error;
  }
  throw new StartError(
    `The role in NEON_READONLY_URL can read transactions. Use the role ${UI_LOGIN}, made in ` +
      "psql as the setup guide says (not in the Neon Console).",
  );
}

/** The largest migration file name without .sql, as finos migrate records it. */
export function latestMigration(dir: string): string {
  const last = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().at(-1);
  if (last === undefined) {
    throw new StartError("No migration file in src/finos/migrations. Check out the repository again.");
  }
  return last.replace(/\.sql$/, "");
}

/** The database's schema version; it stops when the database is older than this checkout. */
export async function schemaGate(db: Db, migrationsDir: string): Promise<string> {
  const [rows] = await db.read([{ text: "select max(version) as v from schema_migrations" }]);
  const found = String(rows![0]?.v ?? "");
  const version = /^[0-9]{4}_[a-z0-9_]{1,60}$/.test(found) ? found : "unknown";
  const wanted = latestMigration(migrationsDir);
  if (version === "unknown" || version < wanted) {
    throw new StartError(
      `The database is at migration ${version}; this UI needs ${wanted}. ` +
        "Run any finos command in a cloud session to migrate first.",
    );
  }
  return version;
}
