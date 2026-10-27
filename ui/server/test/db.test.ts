// The Neon client and the start checks, on the emulator over the golden database.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkConnectionString, checkNeonHost, checkRole, createDb, latestMigration, schemaGate,
} from "../src/db.js";
import { DbError, StartError } from "../src/errors.js";
import { Secret } from "../src/secret.js";
import { NeonEmulator } from "./emulator.js";
import { MIGRATIONS } from "./global-setup.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const HOST = "ep-quiet-sky-123456.c-2.ap-south-1.aws.neon.tech";
const POOLER = "ep-quiet-sky-123456-pooler.c-2.ap-south-1.aws.neon.tech";
const GOOD = `postgresql://finos_ui:FAKEPASS@${HOST}/neondb?sslmode=require`;
const url = (text: string) => new Secret(text);

describe("checkNeonHost", () => {
  it("accepts an endpoint host and refuses a connection string or another host", () => {
    expect(checkNeonHost(HOST)).toBe(HOST);
    expect(checkNeonHost("ep-a-1.ap-south-1.aws.neon.tech")).toBe("ep-a-1.ap-south-1.aws.neon.tech");
    for (const bad of [GOOD, "evil.example", `${HOST}.evil.example`, "", "ep-a.neon.tech"]) {
      expect(() => checkNeonHost(bad), bad).toThrow("FINOS_NEON_HOST");
      if (bad) expect(() => checkNeonHost(bad)).not.toThrow("FAKEPASS");
    }
  });
});

describe("checkConnectionString", () => {
  it("accepts finos_ui on the host or its pooler with sslmode=require", () => {
    expect(() => checkConnectionString(url(GOOD), HOST)).not.toThrow();
    expect(() => checkConnectionString(url(GOOD.replace(HOST, POOLER)), HOST)).not.toThrow();
    expect(() => checkConnectionString(url(GOOD.replace("postgresql:", "postgres:")), HOST))
      .not.toThrow();
  });

  it.each([
    ["the owner", GOOD.replace("finos_ui:", "neondb_owner:"), "neondb_owner"],
    ["another user", GOOD.replace("finos_ui:", "someone:"), "finos_ui"],
    ["another host", GOOD.replace(HOST, "ep-other-1.c-2.ap-south-1.aws.neon.tech"), "host"],
    ["a look-alike host", GOOD.replace(HOST, `${HOST}.evil.example`), "host"],
    ["no sslmode", GOOD.replace("?sslmode=require", ""), "sslmode=require"],
    ["two sslmodes", `${GOOD}&sslmode=require`, "sslmode=require"],
    ["sslmode=prefer", GOOD.replace("require", "prefer"), "sslmode=require"],
    ["http", GOOD.replace("postgresql:", "http:"), "postgresql://"],
    ["https", GOOD.replace("postgresql:", "https:"), "postgresql://"],
    ["not a URL", "FAKEPASS", "postgresql://"],
  ])("refuses %s without showing the string", (_name, text, named) => {
    const check = () => checkConnectionString(url(text), HOST);

    expect(check).toThrow(StartError);
    expect(check).toThrow(named);
    expect(check).not.toThrow("FAKEPASS");
  });
});

describe("latestMigration", () => {
  it("is the largest migration file name without .sql", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const f of ["0001_a.sql", "0010_b.sql", "0002_c.sql", "notes.txt"]) {
      writeFileSync(join(dir, f), "");
    }

    expect(latestMigration(dir)).toBe("0010_b");
    expect(latestMigration(MIGRATIONS)).toBe("0009_ai_usage_text");
  });

  it("stops with a plain message when the folder has no migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "notes.txt"), "");

    expect(() => latestMigration(dir)).toThrow(StartError);
    expect(() => latestMigration(dir)).toThrow("No migration file");
  });
});

describe.skipIf(!pgAdmin)(`the database (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());
  const db = () => createDb({ url: url(GOOD), fetchFunction: neon.fetchFunction });

  it("reads in one read-only batch with a statement timeout and no redirects", async () => {
    const [rows] = await db().read([{ text: "select 1::int as one" }]);

    expect(rows).toEqual([{ one: 1 }]);
    const seen = neon.requests.at(-1)!;
    expect(seen.url).toBe("https://api.c-2.ap-south-1.aws.neon.tech/sql");
    expect(seen.headers.get("neon-batch-read-only")).toBe("true");
    // The driver adds its own application_name.
    expect(seen.headers.get("neon-connection-string")!.startsWith(GOOD)).toBe(true);
    expect(seen.init.redirect).toBe("error");
    expect(seen.init.signal).toBeInstanceOf(AbortSignal); // its own timeout: a hung request ends
    expect((seen.body as { queries: { query: string }[] }).queries[0]!.query).toBe(
      "set local statement_timeout = '5s'",
    );
  });

  it("keeps dates as YYYY-MM-DD, numeric and bigint as strings", async () => {
    const [rows] = await db().read([
      {
        text:
          "select $1::date as d, 12.50::numeric(12,2) as n, 9007199254740993::bigint as b, " +
          "true as t, null::text as x",
        params: ["2026-09-01"],
      },
    ]);

    expect(rows).toEqual([
      { d: "2026-09-01", n: "12.50", b: "9007199254740993", t: true, x: null },
    ]);
  });

  it("refuses a write in a read, and keeps only the SQLSTATE code of an error", async () => {
    const write = db().read([{ text: "insert into ai_usage (purpose, model) values ('chat', 'claude-x')" }]);

    await expect(write).rejects.toThrow(DbError);
    await expect(write).rejects.toMatchObject({ code: "25006" });
    await expect(write).rejects.not.toThrow("insert");
  });

  it("reads the grants that the allow-list snapshot holds", async () => {
    const snapshot = JSON.parse(
      readFileSync(new URL("../../../tests/ui_grants.snapshot.json", import.meta.url), "utf8"),
    );
    const [tables, columns] = await db().read([
      {
        text:
          "select table_name::text as t, privilege_type::text as p " +
          "from information_schema.role_table_grants where table_schema = 'public' " +
          "and grantee in ('finos_ui_access', 'PUBLIC') order by 1, 2",
      },
      {
        text:
          "select table_name::text as t, privilege_type::text as p, column_name::text as c " +
          "from information_schema.role_column_grants where table_schema = 'public' " +
          "and grantee = 'finos_ui_access' and table_name in ('ai_usage', 'schema_migrations') " +
          "order by 1, 2, 3",
      },
    ]);

    const byTable: Record<string, string[]> = {};
    for (const r of tables!) (byTable[r.t as string] ??= []).push(r.p as string);
    expect(byTable).toEqual(snapshot.tables.finos_ui_access);
    const byColumn: Record<string, Record<string, string[]>> = {};
    for (const r of columns!) ((byColumn[r.t as string] ??= {})[r.p as string] ??= []).push(r.c as string);
    expect(byColumn).toEqual(snapshot.columns.finos_ui_access);
  });

  it("passes the role check when transactions are refused", async () => {
    await expect(checkRole(db())).resolves.toBeUndefined();
  });

  it("refuses to start when the role can read transactions (the owner)", async () => {
    const owner = new NeonEmulator(database.config, null);
    const asOwner = createDb({ url: url(GOOD), fetchFunction: owner.fetchFunction });

    await expect(checkRole(asOwner)).rejects.toThrow(StartError);
    await expect(checkRole(asOwner)).rejects.toThrow("can read transactions");
  });

  it("passes the schema gate at the latest migration and stops on an older database", async () => {
    await expect(schemaGate(db(), MIGRATIONS)).resolves.toBe("0009_ai_usage_text");

    const ahead = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(ahead, "0010_next.sql"), "");
    const gate = schemaGate(db(), ahead);
    await expect(gate).rejects.toThrow(
      "Run any finos command in a cloud session to migrate first",
    );
    await expect(gate).rejects.toThrow("0009_ai_usage_text");
  });
});
