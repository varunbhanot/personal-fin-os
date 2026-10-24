// S9: the server tree is pinned, comes only from the npm registry, and runs no install script.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));
const lock = JSON.parse(read("../package-lock.json"));
const root = JSON.parse(read("../../package.json"));

// The pins table of .claude/plans/bi-ui.plan.md. A change here is a change to the plan.
const RUNTIME = {
  "@ag-ui/core": "1.0.2",
  "@anthropic-ai/sdk": "0.133.0",
  "@hono/node-server": "2.1.4",
  "@neondatabase/serverless": "1.2.0",
  hono: "4.13.13",
  zod: "3.25.76",
};
const DEV = ["@types/node", "@types/pg", "pg", "typescript", "vitest"];
const NEVER = [
  "react", "@ag-ui/client", "@ag-ui/encoder", "@ag-ui/proto", "tsx", "keytar",
  "@napi-rs/keyring", "zod-to-json-schema", "fastify",
];
// fsevents is an optional macOS file watcher under vitest (dev only). ignore-scripts keeps its
// install script from running.
const INSTALL_SCRIPT_ALLOWED = new Set(["node_modules/fsevents"]);

describe("package.json", () => {
  it("has exactly the pinned runtime packages and the dev tools", () => {
    expect(pkg.dependencies).toEqual(RUNTIME);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(DEV);
  });

  it("pins every version exactly", () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.devDependencies["@types/node"]).toMatch(/^24\./);
  });

  it("never depends on the browser tree, an AG-UI client or a run-time TypeScript loader", () => {
    for (const name of NEVER) expect(pkg.dependencies[name], name).toBeUndefined();
    expect(Object.keys(pkg.dependencies).filter((n) => n.startsWith("@copilotkit/"))).toEqual([]);
  });

  it("asks for a Node that vitest supports", () => {
    expect(pkg.engines.node).toBe("^22.12.0 || ^24.0.0 || >=26.0.0");
  });

  it("checks signatures, the audit, the types, the tests and one zod in its check script", () => {
    expect(pkg.scripts.check).toBe(
      "npm audit signatures && node scripts/audit.mjs && tsc --noEmit && " +
        "tsc --noEmit -p tsconfig.test.json && vitest run && npm ls zod @ag-ui/core",
    );
    expect(pkg.scripts.build).toBe("tsc");
  });

  it("keeps save-exact, ignore-scripts, engine-strict and the two-week date in .npmrc", () => {
    expect(read("../.npmrc").trim().split("\n").sort()).toEqual([
      "before=2026-10-10", "engine-strict=true", "ignore-scripts=true", "save-exact=true",
    ]);
  });
});

describe("package-lock.json", () => {
  const packages = Object.entries(lock.packages as Record<string, Record<string, unknown>>)
    .filter(([path]) => path !== "");

  it("resolves every package from registry.npmjs.org with a sha512 integrity", () => {
    expect(packages.length).toBeGreaterThan(10);
    for (const [path, entry] of packages) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\/[^?#]+\.tgz$/);
      expect(entry.integrity, path).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    }
  });

  it("has no install script outside the allow-list", () => {
    const scripted = packages.filter(([, e]) => e.hasInstallScript === true).map(([p]) => p);
    for (const path of scripted) {
      expect(INSTALL_SCRIPT_ALLOWED.has(path), path).toBe(true);
      expect(lock.packages[path].dev && lock.packages[path].optional, path).toBe(true);
    }
  });

  it("holds the pinned versions", () => {
    for (const [name, version] of Object.entries(RUNTIME)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });
});

describe("ui/package.json", () => {
  it("holds scripts only", () => {
    expect(Object.keys(root).sort()).toEqual(["name", "private", "scripts"]);
  });

  it("runs the server check alone for the laptop, and both checks in a cloud session", () => {
    expect(root.scripts["check:server"]).toBe("npm --prefix server run check");
    expect(root.scripts.check).toContain("npm --prefix server run check");
  });
});
