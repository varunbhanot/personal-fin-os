// A fresh copy of the golden database (migrations + tests/ui_golden/seed.sql) for one test
// file, and the owner's pg client for planting rows. Skips on the laptop (no Postgres).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { TEMPLATE, connection } from "./global-setup.js";

export const pgAdmin = inject("pgAdmin");
export const pgSkipReason = inject("pgSkipReason");

export type Database = { config: pg.ClientConfig; owner: pg.Client; drop: () => Promise<void> };

export async function freshDatabase(): Promise<Database> {
  if (!pgAdmin) throw new Error(pgSkipReason);
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client(connection(pgAdmin));
  await admin.connect();
  await admin.query(`create database ${name} template ${TEMPLATE}`);
  await admin.end();
  const config = connection(pgAdmin, name);
  const owner = new pg.Client(config);
  await owner.connect();
  return {
    config,
    owner,
    drop: async () => {
      await owner.end();
      const again = new pg.Client(connection(pgAdmin!));
      await again.connect();
      await again.query(`drop database ${name} with (force)`);
      await again.end();
    },
  };
}
