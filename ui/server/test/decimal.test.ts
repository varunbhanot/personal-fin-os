// Decimal strings as Python's Decimal gives them: no floats anywhere.
import { describe, expect, it } from "vitest";
import { add, compare, pct, sub } from "../src/decimal.js";

describe("decimal strings", () => {
  it("adds and subtracts at the larger scale, as Decimal does", () => {
    expect(add("0", "2.0000")).toBe("2.0000");
    expect(add("0.2500", "0.1")).toBe("0.3500");
    expect(sub("3456.75", "0")).toBe("3456.75");
    expect(sub("0", "500.00")).toBe("-500.00");
    expect(sub("-500.00", "-500.00")).toBe("0.00");
    expect(sub("0.05", "0.10")).toBe("-0.05");
    expect(add("99999999999999999.99", "0.01")).toBe("100000000000000000.00");
  });

  it("gives a percentage of |previous| to 0.1, half to even, and null for 0", () => {
    expect(pct("74655.75", "500.00")).toBe("14931.2"); // 14931.15
    expect(pct("1000.00", "500.00")).toBe("200.0");
    expect(pct("-0.25", "1")).toBe("-25.0");
    expect(pct("1", "-8")).toBe("12.5");
    expect(pct("0.0025", "1")).toBe("0.2"); // 0.25, down to even
    expect(pct("0.0035", "1")).toBe("0.4"); // 0.35, up to even
    expect(pct("-0.0001", "1000")).toBe("0.0"); // never -0.0
    expect(pct("5", "0")).toBeNull();
    expect(pct("5", "0.00")).toBeNull();
    expect(pct(null, "5")).toBeNull();
    expect(pct("5", null)).toBeNull();
  });

  it("compares at the larger scale", () => {
    expect(compare("100.0000", "100")).toBe(0);
    expect(compare("99.9999", "100")).toBe(-1);
    expect(compare("100.0001", "100")).toBe(1);
    expect(compare("-1", "0.5")).toBe(-1);
    expect(compare("250.50", "250.5")).toBe(0);
    expect(() => compare("lots", "1")).toThrow();
  });

  it("refuses a value that is not a decimal string", () => {
    for (const bad of ["1e5", "NaN", "", "1.2.3", " 1", "0x10"]) {
      expect(() => add(bad, "1"), bad).toThrow();
    }
  });
});
