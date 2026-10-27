// E3.2.2: decimal strings become numbers for charts only; text shows Indian grouping, made from
// the string (no float), so a figure shown is the figure the record holds.
import { describe, expect, it } from "vitest";
import {
  formatChange, formatInr, formatInrCompact, formatPct, formatUsd, monthLabel, monthOf, subtract, toNumber,
} from "../src/format";

describe("formatInr", () => {
  it.each([
    ["0", "₹0.00"], ["500.00", "₹500.00"], ["1234", "₹1,234.00"], ["123456", "₹1,23,456.00"],
    ["151200.50", "₹1,51,200.50"], ["1234567.8", "₹12,34,567.80"], ["12345678.9", "₹1,23,45,678.90"],
    ["-500.00", "-₹500.00"], ["-1234567.89", "-₹12,34,567.89"], ["0.5", "₹0.50"], ["-0", "₹0.00"],
    ["-0.00", "₹0.00"], ["999999999999.99", "₹9,99,99,99,99,999.99"],
  ])("shows %s as %s", (value, wanted) => {
    expect(formatInr(value)).toBe(wanted);
  });

  it("rounds to the places asked, half away from zero, on the digits", () => {
    expect(formatInr("0.005")).toBe("₹0.01");
    expect(formatInr("0.004")).toBe("₹0.00");
    expect(formatInr("-0.005")).toBe("-₹0.01");
    expect(formatInr("99999.995")).toBe("₹1,00,000.00");
    expect(formatInr("1234.5678", 0)).toBe("₹1,235");
    expect(formatInr("1234.5678", 4)).toBe("₹1,234.5678");
  });

  it("does not drift as a float would", () => {
    expect(formatInr("9007199254740993.01")).toBe("₹9,00,71,99,25,47,40,993.01");
  });

  it("shows a value that is not a decimal as a dash, never a throw", () => {
    expect(formatInr("abc")).toBe("–");
    expect(formatInr("")).toBe("–");
    expect(formatInr("1e5")).toBe("–");
  });
});

describe("formatUsd", () => {
  it("groups by thousands and keeps cents", () => {
    expect(formatUsd("2.3500")).toBe("$2.35");
    expect(formatUsd("1234567.891")).toBe("$1,234,567.89");
    expect(formatUsd("0.1000", 4)).toBe("$0.1000");
    expect(formatUsd("100")).toBe("$100.00");
    expect(formatUsd("x")).toBe("–");
  });
});

describe("formatPct and formatChange", () => {
  it("writes a signed percentage, or nothing for null", () => {
    expect(formatPct("14931.2")).toBe("+14,931.2%");
    expect(formatPct("-72.5")).toBe("-72.5%");
    expect(formatPct("0.0")).toBe("0.0%");
    expect(formatPct(null)).toBeNull();
  });

  it("writes a signed change", () => {
    expect(formatChange("74655.75")).toBe("+₹74,655.75");
    expect(formatChange("-500.00")).toBe("-₹500.00");
    expect(formatChange("0")).toBe("₹0.00");
    expect(formatChange(null)).toBeNull();
  });

  it("decides the plus sign from the rounded value", () => {
    expect(formatChange("0.001")).toBe("₹0.00");
    expect(formatChange("0.004")).toBe("₹0.00");
    expect(formatChange("0.005")).toBe("+₹0.01");
    expect(formatChange("-0.001")).toBe("₹0.00");
  });
});

describe("months and numbers", () => {
  it("names a month without a time zone", () => {
    expect(monthLabel("2026-09-01")).toBe("Sep 2026");
    expect(monthLabel("2026-01-01")).toBe("Jan 2026");
    expect(monthLabel("2026-12-01")).toBe("Dec 2026");
    expect(monthLabel("junk")).toBe("?");
  });

  it("cuts the picker value from a month date", () => {
    expect(monthOf("2026-09-01")).toBe("2026-09");
  });

  it("makes numbers for charts from decimal strings", () => {
    expect(toNumber("151200.50")).toBe(151200.5);
    expect(toNumber("-500.00")).toBe(-500);
    expect(toNumber("junk")).toBe(0);
  });
});

describe("formatInrCompact", () => {
  it.each([
    [0, "₹0"], [950, "₹950"], [1500, "₹1.5k"], [151200.5, "₹1.5L"], [25_000_000, "₹2.5Cr"],
    [-13333.33, "-₹13.3k"], [-0.01, "₹0"],
  ])("shows %s as %s", (n, wanted) => {
    expect(formatInrCompact(n)).toBe(wanted);
  });
});

describe("subtract", () => {
  it.each([
    ["75155.75", "48489.08", "26666.67"], ["48489.08", "75155.75", "-26666.67"], ["5", "5.00", "0.00"],
    ["0", "500.00", "-500.00"], ["-500.00", "-500.00", "0.00"], ["1", "0.5", "0.5"],
    ["9007199254740993.01", "0.01", "9007199254740993.00"],
  ])("%s - %s = %s", (a, b, wanted) => {
    expect(subtract(a, b)).toBe(wanted);
  });
});
