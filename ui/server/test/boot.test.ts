// S4 boot order: ESM evaluates static imports first, so the SDKs must be reachable from
// boot.ts only through a dynamic import() that runs after hardenEnv().
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const SECRET_SDKS = ["@anthropic-ai/sdk", "@neondatabase/serverless"];

/** The specifiers a module imports statically (import … from, export … from, import "x"). */
export function staticImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  const patterns = [
    /^\s*import\s+(?!\()(?:type\s+)?[^"';]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*export\s+(?:type\s+)?[^"';]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (!/^\s*(import|export)\s+type\s/.test(match[0])) found.push(match[1]!);
    }
  }
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const path = resolve(dirname(from), specifier.replace(/\.js$/, ".ts"));
  return existsSync(path) ? path : null;
}

/** Every module and package reachable from entry through static imports only. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      const local = resolveLocal(file, specifier);
      if (local) todo.push(local);
      else seen.add(specifier);
    }
  }
  return seen;
}

describe("the boot order", () => {
  it("finds static imports and ignores dynamic ones and types", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "@anthropic-ai/sdk";',
      'export { c } from "./c.js";',
      'import "./d.js";',
      'const m = await import("./main.js");',
      "// import { x } from \"./comment.js\";",
    ].join("\n");

    expect(staticImports(source).sort()).toEqual(["./a.js", "./c.js", "./d.js"]);
  });

  it("boot.ts imports harden.ts only", () => {
    const boot = join(SRC, "boot.ts");

    expect(staticImports(readFileSync(boot, "utf8"))).toEqual(["./harden.js"]);
    expect(readFileSync(boot, "utf8")).toMatch(/hardenEnv\([\s\S]*await import\("\.\/main\.js"\)/);
  });

  it("harden.ts imports nothing", () => {
    expect(staticImports(readFileSync(join(SRC, "harden.ts"), "utf8"))).toEqual([]);
  });

  it("reaches no SDK, and no module that imports one, without a dynamic import", () => {
    const found = reachable(join(SRC, "boot.ts"));

    for (const sdk of SECRET_SDKS) expect(found.has(sdk), sdk).toBe(false);
    expect([...found].filter((f) => !f.startsWith("/"))).toEqual([]);
  });

  it("would see an SDK that main.ts imports, were boot.ts to import main.ts statically", () => {
    const found = reachable(join(SRC, "main.ts"));

    expect(SECRET_SDKS.some((sdk) => found.has(sdk))).toBe(true);
  });

  it("covers every source file in the scan", () => {
    expect(readdirSync(SRC).filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(5);
  });
});
