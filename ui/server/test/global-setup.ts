// A throwaway Postgres 16 for the database tests, as tests/conftest.py starts one: initdb and
// pg_ctl from /usr/lib/postgresql/16/bin, run as postgres when the container runs as root, on a
// socket only. It holds one template database with every migration and the golden seed; each
// test file copies it (test/pg.ts). FINOS_TEST_DATABASE_URL names an existing server instead.
// With neither (the macOS laptop), the database tests skip.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";

const PG_BIN = "/usr/lib/postgresql/16/bin";
const REPO = new URL("../../../", import.meta.url).pathname;
export const MIGRATIONS = join(REPO, "src/finos/migrations");
export const SEED = join(REPO, "tests/ui_golden/seed.sql");
export const TEMPLATE = "finos_ui_golden";

declare module "vitest" {
  export interface ProvidedContext {
    // A libpq-style URL of the admin database, or null when no Postgres is available.
    pgAdmin: string | null;
    pgSkipReason: string;
  }
}

export default async function setup(project: TestProject) {
  let admin = process.env.FINOS_TEST_DATABASE_URL ?? null;
  let stop = () => {};
  if (!admin) {
    if (!existsSync(join(PG_BIN, "initdb"))) {
      project.provide("pgAdmin", null);
      project.provide("pgSkipReason", "Postgres 16 is not installed; set FINOS_TEST_DATABASE_URL");
      return;
    }
    ({ admin, stop } = startPostgres());
  }
  try {
    await makeTemplate(admin);
  } catch (error) {
    stop();
    throw error;
  }
  project.provide("pgAdmin", admin);
  project.provide("pgSkipReason", "");
  return stop;
}

function startPostgres(): { admin: string; stop: () => void } {
  const base = mkdtempSync(join(tmpdir(), "finos-ui-pg-"));
  chmodSync(base, 0o755);
  const asPostgres = process.getuid?.() === 0 ? ["runuser", "-u", "postgres", "--"] : [];
  const run = (...args: string[]) => {
    const [file, ...rest] = [...asPostgres, ...args] as [string, ...string[]];
    execFileSync(file, rest, { stdio: "pipe" });
  };
  if (asPostgres.length) execFileSync("chown", ["postgres", base]);
  const data = join(base, "data");
  const sock = join(base, "sock");
  run("mkdir", sock);
  run(join(PG_BIN, "initdb"), "-D", data, "-A", "trust", "-U", "postgres", "--no-sync");
  run(
    join(PG_BIN, "pg_ctl"), "-D", data, "-w", "-l", join(base, "log"),
    "-o", `-k ${sock} -c listen_addresses='' -c fsync=off`, "start",
  );
  return {
    admin: `postgresql://postgres@localhost/postgres?host=${sock}`,
    stop: () => {
      try {
        run(join(PG_BIN, "pg_ctl"), "-D", data, "-m", "immediate", "stop");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  };
}

async function makeTemplate(admin: string) {
  const server = new pg.Client(connection(admin));
  await server.connect();
  try {
    await server.query(`drop database if exists ${TEMPLATE} with (force)`);
    await server.query(`create database ${TEMPLATE}`);
  } finally {
    await server.end();
  }
  const db = new pg.Client(connection(admin, TEMPLATE));
  await db.connect();
  try {
    // As finos migrate does: each file once, in name order, recorded without ".sql".
    await db.query(
      "create table if not exists schema_migrations (" +
        "version text primary key, applied_at timestamptz not null default now())",
    );
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      await db.query(`begin;\n${readFileSync(join(MIGRATIONS, file), "utf8")}\n;commit;`);
      await db.query("insert into schema_migrations (version) values ($1)", [
        file.replace(/\.sql$/, ""),
      ]);
    }
    await db.query(readFileSync(SEED, "utf8"));
  } finally {
    await db.end();
  }
}

/** pg client options for a URL such as postgresql://postgres@localhost/postgres?host=/sock. */
export function connection(url: string, database?: string): pg.ClientConfig {
  const parsed = new URL(url);
  return {
    host: parsed.searchParams.get("host") ?? parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    user: decodeURIComponent(parsed.username) || "postgres",
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: database ?? (parsed.pathname.slice(1) || "postgres"),
  };
}
