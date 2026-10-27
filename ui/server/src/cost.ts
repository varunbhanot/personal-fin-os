// What a chat call costs, and the shared monthly limit (S5). This mirrors src/finos/ai.py: the
// price table, cost_usd and check_budget. A test parses the PRICES block of ai.py and fails when
// the two tables differ; tests/ui_golden/cost_vectors.json holds the same cost cases for both
// languages. The sum is exact integer arithmetic, rounded half to even to 1e-4 USD as Python's
// Decimal.quantize does for numeric(10, 4); no float is ever made.
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Db } from "./db.js";
import { compare } from "./decimal.js";
import { StartError } from "./errors.js";

// USD per million tokens: input, output, cache write (5 minute), cache read. Written as in ai.py.
export const PRICES: Readonly<Record<string, readonly [string, string, string, string]>> = {
  "claude-opus-5-5": ["4", "20", "5", "0.20"],
  "claude-opus-5": ["5", "25", "6.25", "0.50"],
  "claude-opus-4-8": ["5", "25", "6.25", "0.50"],
  "claude-sonnet-5-5": ["2", "10", "2.50", "0.20"],
  "claude-sonnet-5": ["2", "10", "2.50", "0.20"],
  "claude-haiku-5-5": ["0.10", "0.50", "0.125", "0.01"],
};

type Prices = readonly [bigint, bigint, bigint, bigint];

/** A price in USD per million tokens as milli-USD per million tokens: "0.125" is 125n. */
function milli(price: string): bigint {
  const [whole = "0", fraction = ""] = price.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0").slice(0, 3));
}

const MILLI = new Map<string, Prices>(
  Object.entries(PRICES).map(([model, p]) => [model, p.map(milli) as unknown as Prices]),
);
// The first entry with the highest output price, as max() over PRICES.values() in ai.py.
const MOST_EXPENSIVE = [...MILLI.entries()].reduce((best, entry) =>
  entry[1][1] > best[1][1] ? entry : best,
)[1];
const SNAPSHOT_DATE = /-\d{8}$/;
const MODEL_ID = /^claude-[a-z0-9-]{1,60}$/;

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

const tokens = (value: number | null | undefined) => BigInt(value ?? 0);

/** The cost as text with 4 decimals, as ai.cost_usd. An unknown model costs as the most
 * expensive known one, and onUnknown is called once for the call. */
export function costUsd(model: string, usage: TokenUsage, onUnknown?: () => void): string {
  const name = model.replace(SNAPSHOT_DATE, ""); // claude-opus-5-5-20261001 costs as claude-opus-5-5
  let prices = MILLI.get(name);
  if (!prices) {
    onUnknown?.();
    prices = MOST_EXPENSIVE;
  }
  const [input, output, write, read] = prices;
  // tokens x milli-USD per million = 1e-9 USD
  const nano =
    tokens(usage.input_tokens) * input + tokens(usage.output_tokens) * output +
    tokens(usage.cache_creation_input_tokens) * write + tokens(usage.cache_read_input_tokens) * read;
  const unit = 100_000n; // 1e-4 USD in 1e-9 USD
  let ten_thousandths = nano / unit;
  const twice = (nano % unit) * 2n;
  if (twice > unit || (twice === unit && ten_thousandths % 2n === 1n)) ten_thousandths += 1n;
  const digits = ten_thousandths.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** The model name for ai_usage: the served one if it is a plain model ID, else the requested
 * one, else claude-unknown (the 0009 check refuses anything else, and a paid call must still
 * be recorded). */
export function servedModel(served: string | undefined, requested: string): string {
  return [served, requested].find((m) => m !== undefined && MODEL_ID.test(m)) ?? "claude-unknown";
}

// --- the budget -----------------------------------------------------------------------------

const BUDGET = /^[0-9]{1,6}(\.[0-9]{1,4})?$/;

/** FINOS_AI_BUDGET_USD: default 100, more than 0. The text is kept, as the Python side prints it. */
export function parseBudget(raw: string | undefined): string {
  const budget = (raw ?? "100").trim();
  if (!BUDGET.test(budget) || /^0+(\.0+)?$/.test(budget)) {
    throw new StartError(
      "FINOS_AI_BUDGET_USD must be a number of dollars more than 0, the same as in the " +
        "cloud environment (default 100).",
    );
  }
  return budget;
}

/** This month's spend has reached the limit. The text is ai.check_budget's. */
export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

/** The spend could not be read, so no call is made (fail closed). */
export class BudgetCheckError extends Error {
  override name = "BudgetCheckError";
}

const SPENT =
  "select coalesce(sum(cost_usd), 0) as spent from v_ai_spend " +
  "where month = date_trunc('month', now())::date";

/** This month's spend (all purposes, as ai.spent_this_month), or an error. It refuses when the
 * database cannot answer. Python: ai.check_budget. */
export async function checkBudget(db: Pick<Db, "read">, budgetUsd: string): Promise<string> {
  let spent: string;
  try {
    const [rows] = await db.read([{ text: SPENT }]);
    spent = String(rows?.[0]?.spent);
    compare(spent, "0"); // throws when it is not a decimal
  } catch {
    throw new BudgetCheckError(
      "The AI spend this month could not be read, so the chat made no call. Try again.",
    );
  }
  if (compare(spent, budgetUsd) >= 0) {
    throw new BudgetExceeded(
      `AI spend this month is $${spent}, at the FINOS_AI_BUDGET_USD limit of $${budgetUsd}. ` +
        "Raise the limit or wait for next month.",
    );
  }
  return spent;
}

// --- the usage of one streamed call ---------------------------------------------------------

type Counts = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};
const FIELDS = [
  "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
] as const;

/** The usage of one call from its stream events. Each field takes the value of the latest
 * event that carries it: message_delta's usage is cumulative, so it replaces message_start's and
 * is never added to it. A call that ends without message_stop (abort, disconnect, error) records
 * max_tokens as its output, as an upper bound, so a disconnect cannot under-record. */
export class UsageAccumulator {
  model: string | undefined;
  started = false;
  complete = false;
  private readonly counts: Counts = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  };

  constructor(private readonly maxTokens: number) {}

  see(event: RawMessageStreamEvent): void {
    if (event.type === "message_start") {
      this.started = true;
      if (typeof event.message?.model === "string") this.model = event.message.model;
      this.take(event.message?.usage);
    } else if (event.type === "message_delta") {
      this.take(event.usage);
    } else if (event.type === "message_stop") {
      this.complete = true;
    }
  }

  private take(usage: unknown): void {
    if (typeof usage !== "object" || usage === null) return;
    for (const field of FIELDS) {
      const value = (usage as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) this.counts[field] = value;
    }
  }

  usage(): Counts {
    const output = this.complete ? this.counts.output_tokens : Math.max(this.counts.output_tokens, this.maxTokens);
    return { ...this.counts, output_tokens: output };
  }
}
