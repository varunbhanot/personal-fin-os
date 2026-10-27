// E3.2.4: the shapes of the /api answers are in src/api-types.ts, which ui/web imports as well.
// The annotations below are the check (tsc -p tsconfig.test.json fails when record.ts returns a
// different shape); the assertions show that the golden figures have the same shape at run time.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Goal, Health, Meta, MonthView, Spreads, Summary } from "../src/api-types.js";
import { createDb } from "../src/db.js";
import { createRecord } from "../src/record.js";
import { Secret } from "../src/secret.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8"),
);
const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");

describe.skipIf(!pgAdmin)(`the shared API types (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());
  const record = () => createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction }));

  it("types each record answer with the shared shapes, equal to the golden figures", async () => {
    const months: Summary[] = await record().months({ spread: false });
    const month: MonthView | null = await record().month("2026-09-01", { spread: false });
    const goals: Goal[] = await record().goals();
    const spreads: Spreads = await record().spreads();
    const health: Health = await record().health();
    const meta: Omit<Meta, "budget_usd"> = await record().meta();

    expect(months).toEqual(EXPECTED.months.cash);
    expect(month).toEqual(EXPECTED.month.cash["2026-09"]);
    expect(goals).toEqual(EXPECTED.goals);
    expect(spreads).toEqual(EXPECTED.spreads);
    expect(health).toEqual(EXPECTED.health);
    expect(Object.keys(meta).sort()).toEqual(["months", "schema_version", "spent_this_month"]);
  });
});
