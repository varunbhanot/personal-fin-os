// Text for figures. The record sends decimal strings; they are grouped and rounded on the
// digits here, so a figure shown is the figure held (no float). toNumber is for chart axes
// and bar lengths only.
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DASH = "–";

/** The digits of value rounded to `places`, half away from zero: sign, whole digits, fraction. */
function round(value: string, places: number): { negative: boolean; whole: string; fraction: string } | null {
  const found = DECIMAL.exec(value);
  if (!found) return null;
  const fraction = found[3] ?? "";
  let units = BigInt(found[2]! + fraction.padEnd(places, "0").slice(0, places));
  if (fraction.length > places && fraction.charCodeAt(places) >= 53) units += 1n; // next digit 5-9
  const digits = units.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  return {
    negative: found[1] === "-" && units !== 0n,
    whole,
    fraction: digits.slice(digits.length - places),
  };
}

/** Indian grouping: the last three digits, then pairs (1,23,456). */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${whole.slice(-3)}`;
}

function show(value: string, places: number, symbol: string, group: (whole: string) => string): string {
  const parts = round(value, places);
  if (!parts) return DASH;
  const body = places ? `${group(parts.whole)}.${parts.fraction}` : group(parts.whole);
  return `${parts.negative ? "-" : ""}${symbol}${body}`;
}

/** "151200.50" as "₹1,51,200.50". A value that is not a decimal string shows as a dash. */
export function formatInr(value: string, places = 2): string {
  return show(value, places, "₹", groupIndian);
}

/** The AI spend is in US dollars: "1234.5" as "$1,234.50". */
export function formatUsd(value: string, places = 2): string {
  return show(value, places, "$", (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
}

/** The plus sign comes from the rounded value: a change below one paisa shows as "₹0.00". */
const signed = (text: string, value: string) => {
  const parts = round(value, 2);
  return parts && !parts.negative && /[1-9]/.test(parts.whole + parts.fraction) ? `+${text}` : text;
};

/** A change with its sign: "+₹74,655.75", "-₹500.00", "₹0.00"; null stays null. */
export function formatChange(change: string | null): string | null {
  return change === null ? null : signed(formatInr(change), change);
}

/** A percentage with its sign: "+14,931.2%", "-72.5%", "0.0%"; null stays null. */
export function formatPct(pct: string | null): string | null {
  if (pct === null) return null;
  const parts = round(pct, 1);
  if (!parts) return DASH;
  const body = `${parts.negative ? "-" : /[1-9]/.test(parts.whole + parts.fraction) ? "+" : ""}`;
  return `${body}${groupIndian(parts.whole)}.${parts.fraction}%`;
}

/** "2026-09-01" as "Sep 2026", with no Date, so no time zone; "?" for anything else. */
export function monthLabel(date: string): string {
  const found = /^([0-9]{4})-(0[1-9]|1[0-2])-[0-9]{2}$/.exec(date);
  return found ? `${MONTHS[Number(found[2]) - 1]} ${found[1]}` : "?";
}

/** "2026-09-01" as "2026-09", the value of the month picker. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** A number for a chart; 0 for a value that is not a decimal string. */
export function toNumber(value: string): number {
  return DECIMAL.test(value) ? Number(value) : 0;
}

/** A short amount for a chart axis: "₹1.5L", "₹2.5Cr", "-₹13.3k". Never used for a figure. */
export function formatInrCompact(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  const [value, unit] =
    abs >= 1e7 ? [abs / 1e7, "Cr"] : abs >= 1e5 ? [abs / 1e5, "L"] : abs >= 1e3 ? [abs / 1e3, "k"] : [abs, ""];
  return `${n < 0 && abs >= 0.05 ? "-" : ""}₹${trim(value)}${unit}`;
}

/** a - b on decimal strings, on bigint digits (no float): "75155.75" - "48489.08" = "26666.67". */
export function subtract(a: string, b: string): string {
  const x = DECIMAL.exec(a);
  const y = DECIMAL.exec(b);
  if (!x || !y) return "0";
  const scale = Math.max((x[3] ?? "").length, (y[3] ?? "").length);
  const units = (m: RegExpExecArray) =>
    (m[1] ? -1n : 1n) * BigInt(m[2]! + (m[3] ?? "").padEnd(scale, "0"));
  const d = units(x) - units(y);
  const digits = (d < 0n ? -d : d).toString().padStart(scale + 1, "0");
  const body = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return `${d < 0n ? "-" : ""}${body}`;
}
