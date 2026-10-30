// Decimal strings, as Postgres numeric sends them and as Python's Decimal prints them. The
// arithmetic is on bigint at the larger scale of the two values, so the figures equal finos's to
// the paisa; no float is ever made.
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

type Fixed = { units: bigint; scale: number };

function parse(text: string): Fixed {
  const found = DECIMAL.exec(text);
  if (!found) throw new Error("not a decimal string");
  const fraction = found[3] ?? "";
  const units = BigInt(found[2]! + fraction);
  return { units: found[1] ? -units : units, scale: fraction.length };
}

function at(value: Fixed, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function show(units: bigint, scale: number): string {
  const sign = units < 0n ? "-" : "";
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  if (scale === 0) return sign + digits;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function add(a: string, b: string): string {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  return show(at(x, scale) + at(y, scale), scale);
}

export function sub(a: string, b: string): string {
  const y = parse(b);
  return add(a, show(-y.units, y.scale));
}

/** -1, 0 or 1 as a is less than, equal to or more than b. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const d = at(x, scale) - at(y, scale);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function isZero(a: string): boolean {
  return parse(a).units === 0n;
}

/** change as a percentage of |previous|, to 0.1 with half to even; null when previous is 0.
 * Python: (change * 100 / abs(previous)).quantize(Decimal("0.1"), ROUND_HALF_EVEN). */
export function pct(change: string | null, previous: string | null): string | null {
  if (change === null || previous === null) return null;
  const c = parse(change);
  const p = parse(previous);
  if (p.units === 0n) return null;
  // tenths = c * 100 * 10 / |p|, with both at their own scales.
  const numerator = c.units * 1000n * 10n ** BigInt(p.scale);
  const denominator = (p.units < 0n ? -p.units : p.units) * 10n ** BigInt(c.scale);
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let tenths = n / denominator;
  const twice = (n % denominator) * 2n;
  if (twice > denominator || (twice === denominator && tenths % 2n === 1n)) tenths += 1n;
  return show(negative && tenths !== 0n ? -tenths : tenths, 1);
}

/** a divided by a positive count, to 0.01 with half to even, as finos would round it.
 * Python: (a / n).quantize(Decimal("0.01"), ROUND_HALF_EVEN). */
export function divide(a: string, n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error("divide by a positive count");
  const x = parse(a);
  // hundredths = a * 100 / n, with a at its own scale.
  const numerator = x.units * 100n;
  const denominator = BigInt(n) * 10n ** BigInt(x.scale);
  const negative = numerator < 0n;
  const v = negative ? -numerator : numerator;
  let hundredths = v / denominator;
  const twice = (v % denominator) * 2n;
  if (twice > denominator || (twice === denominator && hundredths % 2n === 1n)) hundredths += 1n;
  return show(negative && hundredths !== 0n ? -hundredths : hundredths, 2);
}
