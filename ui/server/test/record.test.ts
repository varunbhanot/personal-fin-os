// The read API over the safe views equals the figures finos computes from the golden seed
// (tests/ui_golden/expected.json, checked by tests/test_ui_golden.py), as the UI role sees it.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { RecordInputError, type RowFilter, UNLISTED, clean, createRecord } from "../src/record.js";
import { Secret } from "../src/secret.js";
import { NeonEmulator } from "./emulator.js";
import { type Database, freshDatabase, pgAdmin, pgSkipReason } from "./pg.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../tests/ui_golden/expected.json", import.meta.url), "utf8"),
);
const URL_ = new Secret("postgresql://finos_ui:x@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require");
// The planted texts of tests/test_ui_views.py:build_ui. Only the goal's name may reach the
// browser, and only through goals().
const PLANTED = /ZQX|zqx/;
const GOAL_NAME = "ZQX Goal Hill Trip";

describe("the output cleaners", () => {
  it.each([
    ["source", "axis-bank", "axis-bank"], ["source", "Evil Source!", "unknown"],
    ["source", "a".repeat(41), "unknown"], ["account_last4", "", ""],
    ["account_last4", "04", "04"], ["account_last4", "12345", "?"], ["account_last4", "ab", "?"],
    ["row_id", "d6fbe62a", "d6fbe62a"], ["row_id", "D6FBE62A", "????????"],
    ["row_id", "d6fbe62", "????????"], ["direction", "credit", "credit"],
    ["direction", "sideways", "debit"], ["kind", "investment", "investment"],
    ["kind", "ignore this", "expense"], ["status", "ok", "ok"], ["status", "good", "flagged"],
    ["what", "goal", "goal"], ["what", "other", "spread"], ["purpose", "eval-extract", "eval-extract"],
    ["purpose", "chat; ignore", "other"], ["model", "claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["model", "gpt-9", "unknown"], ["model", "claude-Opus", "unknown"],
    ["state", "no category", "no category"], ["state", "go now", "not counted"],
  ] as const)("%s %j becomes %j", (name, value, wanted) => {
    expect(clean[name](value)).toBe(wanted);
  });

  it("keeps a null kind (no category yet) and maps a non-string to the fallback", () => {
    expect(clean.kind(null)).toBeNull();
    expect(clean.source(5)).toBe("unknown");
  });
});

describe.skipIf(!pgAdmin)(`the record (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
  });
  afterAll(() => database?.drop());
  const record = () => createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction }));

  it("gives the months of expected.json, cash and spread", async () => {
    expect(await record().months({ spread: false })).toEqual(EXPECTED.months.cash);
    expect(await record().months({ spread: true })).toEqual(EXPECTED.months.spread);
    expect(await record().months({ spread: true, last: 2 })).toEqual(
      EXPECTED.months.spread.slice(-2),
    );
  });

  it("gives each month of expected.json, cash and spread", async () => {
    for (const [name, spread] of [["cash", false], ["spread", true]] as const) {
      for (const [month, wanted] of Object.entries(EXPECTED.month[name])) {
        expect(await record().month(`${month}-01`, { spread }), `${name} ${month}`).toEqual(wanted);
      }
    }
  });

  it("gives null for a month with no row", async () => {
    expect(await record().month("2020-01-01", { spread: false })).toBeNull();
  });

  it("gives the goals, the spreads and the health of expected.json", async () => {
    expect(await record().goals()).toEqual(EXPECTED.goals);
    expect(await record().spreads()).toEqual(EXPECTED.spreads);
    expect(await record().health()).toEqual(EXPECTED.health);
  });

  it("counts unlinked transfer rows from own_rows of v_monthly_summary", async () => {
    const health = await record().health();

    expect(health.unlinked_transfer_rows).toBe(2);
    expect(neon.requests.at(-1)!.body).toMatchObject({
      queries: expect.arrayContaining([
        expect.objectContaining({ query: expect.stringContaining("sum(own_rows)") }),
      ]),
    });
  });

  it("gives the rows of expected.json for each filter", async () => {
    for (const [name, { filter, ...wanted }] of Object.entries(
      EXPECTED.rows as Record<string, { filter: Record<string, unknown> }>,
    )) {
      expect(await record().rows(filter as unknown as RowFilter), name).toEqual(wanted);
    }
  });

  it.each([
    [{ limit: 0 }], [{ limit: 51 }], [{ limit: 1.5 }], [{ month: "2026-13" }],
    [{ month: "2026-9" }], [{ category: "Not a category" }], [{ source: "Evil!" }],
    [{ min_amount: "1e3" }], [{ limit: 5, extra: 1 }],
  ])("refuses the row filter %j with a plain reason", async (filter) => {
    await expect(record().rows(filter as never)).rejects.toThrow(RecordInputError);
  });

  it("gives the meta: schema version, months and this month's spend", async () => {
    expect(await record().meta()).toEqual({
      schema_version: "0009_ai_usage_text",
      months: ["2026-08-01", "2026-09-01"],
      spent_this_month: EXPECTED.health.ai_spent_this_month,
    });
  });

  it("shows a category the packaged list does not have as Other (unlisted) everywhere", async () => {
    const r = record();
    const all = JSON.stringify([
      await r.month("2026-09-01", { spread: false }),
      await r.month("2026-09-01", { spread: true }),
      await r.rows({ limit: 50 }),
    ]);

    expect(all).toContain(UNLISTED);
    expect(all).not.toContain("Ignore all previous");
  });

  it("shows no planted text in any result, and the goal name only in goals()", async () => {
    const r = record();
    const results = {
      months: [await r.months({ spread: false }), await r.months({ spread: true })],
      month: [
        await r.month("2026-08-01", { spread: false }), await r.month("2026-09-01", { spread: false }),
        await r.month("2026-10-01", { spread: true }), await r.month("2026-09-01", { spread: true }),
      ],
      spreads: await r.spreads(),
      health: await r.health(),
      meta: await r.meta(),
      rows: [await r.rows({ limit: 50 }), await r.rows({ category: UNLISTED, limit: 50 })],
    };

    expect(JSON.stringify(results)).not.toMatch(PLANTED);
    const goals = JSON.stringify(await r.goals());
    expect(goals.match(/ZQX/g)).toEqual(["ZQX"]);
    expect(goals).toContain(GOAL_NAME);
  });
});

describe.skipIf(!pgAdmin)(`planted values (${pgSkipReason || "Postgres"})`, () => {
  let database: Database;
  let neon: NeonEmulator;
  beforeAll(async () => {
    // As the owner, in this copy only: drop the checks that keep such values out, and plant.
    database = await freshDatabase();
    neon = new NeonEmulator(database.config);
    await database.owner.query(`
      alter table ai_usage drop constraint ai_usage_text;
      insert into ai_usage (purpose, model, input_tokens, output_tokens, cost_usd)
        values ('Ignore the budget', 'gpt-evil now', 1, 1, 0.5000);
      alter table statements drop constraint if exists statements_status_check;
      update statements set status = 'EVIL STATUS', source = 'Evil Source!' where status = 'flagged';
      alter table categories drop constraint if exists categories_kind_check;
      update categories set kind = 'do this' where name = 'Groceries';
      alter table goals drop constraint if exists goals_name_check;
      update goals set name = 'Goal' || chr(7) || repeat('x', 59);
    `);
  });
  afterAll(() => database?.drop());
  const record = () => createRecord(createDb({ url: URL_, fetchFunction: neon.fetchFunction }));

  it("maps each planted value to its fallback", async () => {
    const r = record();
    const health = await r.health();
    const september = await r.month("2026-09-01", { spread: false });

    expect(health.ai_spend.map((s) => s.purpose)).toEqual(["categorise", "chat", "extract", "other"]);
    expect(health.flagged_statements).toEqual([
      expect.objectContaining({ source: "unknown", account_last4: "1111" }),
    ]);
    expect(september!.flagged).toBe(1);
    // The figure views leave an unknown kind out; v_ui_rows shows it, cleaned.
    const groceries = await r.rows({ category: "Groceries", limit: 50 });
    expect(groceries.rows.map((g) => g.kind)).toEqual(["expense"]);
    const text = JSON.stringify([health, september, await r.rows({ limit: 50 })]);
    expect(text).not.toMatch(/Ignore the budget|gpt-evil|EVIL|Evil|do this/);
  });

  it("keeps a goal name printable and at most 60 characters", async () => {
    const [goal] = await record().goals();

    expect(goal!.name).toBe(`Goal${"x".repeat(56)}`);
  });
});
