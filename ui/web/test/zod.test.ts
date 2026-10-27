// The CSP has no 'unsafe-eval' (S3). zod 4 probes Function("") when it makes a schema; src/zod.ts
// turns that off, and every file takes `z` from it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "../src/zod";

describe("src/zod.ts", () => {
  it("sets jitless, so no schema probes the Function constructor", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("makes and runs a schema without calling the Function constructor", () => {
    const probe = vi.fn();
    const Original = globalThis.Function;
    globalThis.Function = new Proxy(Original, {
      construct: (...args) => (probe(), Reflect.construct(...args)),
      apply: (...args) => (probe(), Reflect.apply(...args)),
    });
    try {
      const schema = z.object({ error: z.string().max(200) });
      expect(schema.safeParse({ error: "x" }).success).toBe(true);
    } finally {
      globalThis.Function = Original;
    }

    expect(probe).not.toHaveBeenCalled();
  });
});

describe("the web sources", () => {
  const SRC = join(import.meta.dirname, "../src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

  it("import zod only through src/zod.ts, and main.tsx loads it first", () => {
    for (const path of files(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith("src/zod.ts"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/from\s+["']zod(\/[a-z0-9]+)?["']/);
    }
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    expect(main.indexOf('import "./zod"')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('import "./zod"')).toBeLessThan(main.indexOf("./App"));
  });
});
