// @vitest-environment node
// E3.3.7: the palette works in light and dark, and at 360 px. theme.css holds the colours as
// variables (one block for light, one for prefers-color-scheme: dark); this test reads it and
// checks WCAG contrast: 4.5:1 for text, 3:1 for the chart and bar colours, and that the three
// series differ enough to tell apart without their names. Colour is never the only signal: the
// components also write arrows, signs, "Partial month" and a data table.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");

/** The `--name: #hex;` pairs of the first block that starts with the selector. */
function block(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return Object.fromEntries(
    [...source.slice(open + 1, close).matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]),
  );
}

const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
const LIGHT = block(css, ":root");
const DARK = block(dark, ":root");

const channel = (hex: string, at: number) => {
  const v = parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** Hue in degrees, 0 to 360. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

describe.each([["light", LIGHT], ["dark", DARK]] as const)("the %s palette", (_name, p) => {
  it("has contrast for text, muted text and the warning badge", () => {
    for (const [fg, bg] of [
      ["--text", "--bg"], ["--text", "--surface"], ["--muted", "--bg"], ["--muted", "--surface"],
      ["--warn-text", "--warn-bg"], ["--danger", "--surface"],
    ] as const) {
      expect(contrast(p[fg]!, p[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("has contrast of 3:1 for the series, the accent and the bars", () => {
    for (const name of ["--income", "--expenses", "--savings", "--investments", "--accent"]) {
      expect(contrast(p[name]!, p["--surface"]!), name).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(p["--bar-track"]!, p["--surface"]!), "track").toBeGreaterThanOrEqual(1.2);
    expect(contrast(p["--border"]!, p["--surface"]!), "border").toBeGreaterThanOrEqual(1.2);
  });

  it("keeps the series apart by hue (30 degrees; the bars also keep a fixed order and a legend)", () => {
    const names = ["--income", "--expenses", "--savings", "--investments"];
    for (const [i, a] of names.entries()) {
      for (const b of names.slice(i + 1)) {
        expect(hueGap(p[a]!, p[b]!), `hue ${a} ${b}`).toBeGreaterThanOrEqual(30);
      }
    }
  });
});

describe("theme.css", () => {
  it("defines the same variables in light and dark", () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
    expect(Object.keys(LIGHT).length).toBeGreaterThan(12);
    for (const name of Object.keys(LIGHT)) expect(DARK[name], name).not.toBe(LIGHT[name]);
  });

  it("asks the browser for both schemes", () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
  });

  it("lets wide tables scroll inside their box, so a 360 px screen never scrolls sideways", () => {
    expect(css).toMatch(/\.scroll-x\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 480px\)/);
    expect(css).toMatch(/min-width:\s*0/);
  });

  it("hides the chart's data table from the eye only", () => {
    expect(css).toMatch(/\.sr-only\s*\{[^}]*position:\s*absolute/);
  });
});
