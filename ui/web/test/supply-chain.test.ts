// @vitest-environment node
// S9 and E3.1: the web tree is pinned, comes only from the npm registry, and runs no install
// script that is not on the allow-list. It is the tree that a laptop installs with
// `npm ci --ignore-scripts`; it never holds the secrets, but it runs as the user.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));
const lock = JSON.parse(read("../package-lock.json"));
const root = JSON.parse(read("../../package.json"));

// The pins table of .claude/plans/bi-ui.plan.md. A change here is a change to the plan.
const RUNTIME = {
  "@ag-ui/core": "1.0.2",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "react-is": "19.3.0",
  recharts: "3.10.1",
  zod: "3.25.76",
};
const DEV = [
  "@testing-library/dom", "@testing-library/react", "@testing-library/user-event", "@types/node",
  "@types/react", "@types/react-dom", "@vitejs/plugin-react", "jsdom", "typescript", "vite", "vitest",
];
const NEVER = ["@ag-ui/client", "@ag-ui/encoder", "@ag-ui/proto", "keytar", "zod-to-json-schema"];
// The plan lists esbuild; vite 8 builds with rolldown, so only fsevents (an optional macOS file
// watcher under vite, dev only) has an install script. ignore-scripts keeps it from running.
const INSTALL_SCRIPT_ALLOWED = new Set(["node_modules/esbuild", "node_modules/fsevents"]);

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
    expect(pkg.devDependencies["@testing-library/dom"]).toMatch(/^10\./);
    expect(pkg.devDependencies.vite).toBe("8.3.4");
    expect(pkg.devDependencies.vitest).toBe("5.0.3");
    expect(pkg.devDependencies.typescript).toBe("6.0.3");
    expect(pkg.devDependencies["@vitejs/plugin-react"]).toBe("6.1.2");
    expect(pkg.devDependencies["@testing-library/react"]).toBe("16.3.3");
  });

  it("takes jsdom 28.1.0, the newest whose engines accept the Node 22.12 floor", () => {
    // jsdom 30.1.2 (the plan's first pin) needs Node 22.22.2 or later: it fails `npm ci` under
    // engine-strict on a laptop with an older 22.x, and in the cloud container (22.22.0).
    expect(pkg.devDependencies.jsdom).toBe("28.1.0");
    expect(lock.packages["node_modules/jsdom"].engines.node).toContain("^22.12.0");
  });

  it("has no CopilotKit, AG-UI client, encoder or protobuf package (option B)", () => {
    for (const name of NEVER) expect(pkg.dependencies[name], name).toBeUndefined();
    expect(Object.keys(pkg.dependencies).filter((n) => n.startsWith("@copilotkit/"))).toEqual([]);
    const locked = Object.keys(lock.packages as Record<string, unknown>);
    expect(locked.filter((p) => /node_modules\/@copilotkit\//.test(p))).toEqual([]);
    expect(locked.filter((p) => /node_modules\/@ag-ui\/(client|encoder|proto)$/.test(p))).toEqual([]);
  });

  it("asks for a Node that vitest supports", () => {
    expect(pkg.engines.node).toBe("^22.12.0 || ^24.0.0 || >=26.0.0");
  });

  it("checks signatures, the audit, the types, the tests, one copy of zod and the build", () => {
    expect(pkg.scripts.check).toBe(
      "npm audit signatures && node scripts/audit.mjs && tsc --noEmit && " +
        "vitest run && npm ls zod @ag-ui/core && vite build",
    );
    expect(pkg.scripts.build).toBe("vite build");
    expect(pkg.scripts.test).toBe("vitest run");
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
    expect(packages.length).toBeGreaterThan(40);
    for (const [path, entry] of packages) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\/[^?#]+\.tgz$/);
      expect(entry.integrity, path).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    }
  });

  it("has an install script only on the allow-list, and only in an optional dev package", () => {
    const scripted = packages.filter(([, e]) => e.hasInstallScript === true).map(([p]) => p);
    for (const path of scripted) {
      expect(INSTALL_SCRIPT_ALLOWED.has(path), path).toBe(true);
      expect(lock.packages[path].dev && lock.packages[path].optional, path).toBe(true);
    }
  });

  it("holds the pinned versions, and one copy of zod and @ag-ui/core", () => {
    for (const [name, version] of Object.entries(RUNTIME)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
    const copies = (name: string) =>
      packages.filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
    expect(copies("zod")).toHaveLength(1);
    expect(copies("@ag-ui/core")).toHaveLength(1);
  });
});

describe("vite.config.ts", () => {
  const config = read("../vite.config.ts").replace(/^\s*\/\/.*$/gm, "");

  it("has no dev proxy and no server host", () => {
    expect(config).not.toMatch(/proxy/);
    expect(config).not.toMatch(/\bhost\b/);
    expect(config).not.toMatch(/\bserver\b\s*:/);
  });
});

describe("vitest.config.ts", () => {
  it("runs the network guard first, in jsdom", () => {
    const config = read("../vitest.config.ts");

    expect(config).toContain('setupFiles: ["test/no-network.ts", "test/setup.ts"]');
    expect(config).toContain('environment: "jsdom"');
  });
});

describe("audit-allow.json", () => {
  it("names zod's advisory with a reason and an end date, and nothing else", () => {
    const allowed = JSON.parse(read("../audit-allow.json"));

    expect(allowed.map((a: { id: string }) => a.id)).toEqual(["GHSA-mrhx-c7xc-m3w5"]);
    expect(allowed[0].reason).toBeTruthy();
    expect(allowed[0].until).toBe("2026-10-26");
  });
});

describe("ui/package.json", () => {
  it("runs the web check next to the server check in a cloud session", () => {
    expect(root.scripts.check).toBe("npm --prefix server run check && npm --prefix web run check");
  });

  it("keeps the laptop's check:server free of the web tree", () => {
    expect(root.scripts["check:server"]).toBe("npm --prefix server run check");
  });
});

describe("the audit gate fails closed", () => {
  const lib = new URL("../scripts/audit-lib.mjs", import.meta.url).href;
  const load = async () => (await import(/* @vite-ignore */ lib)) as { advisoryIds: (raw: unknown) => Set<string> };
  const report = (extra: object) => JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, ...extra });

  it("reads advisory ids from a version 2 report", async () => {
    const { advisoryIds } = await load();
    expect([...advisoryIds(report({ vulnerabilities: { zod: { via: [{ url: "https://github.com/advisories/GHSA-aaaa" }, "other"] } } }))])
      .toEqual(["GHSA-aaaa"]);
    expect(advisoryIds(report({})).size).toBe(0);
  });

  it.each([
    ["empty output", ""],
    ["undefined output", undefined],
    ["output that is not JSON", "npm ERR! network"],
    ["a JSON null", "null"],
    ["an error key", JSON.stringify({ error: { code: "ENOTFOUND" } })],
    ["an error key beside a valid shape", report({ error: { code: "E" } })],
    ["no version", JSON.stringify({ vulnerabilities: {} })],
    ["version 1", JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} })],
    ["no vulnerabilities", JSON.stringify({ auditReportVersion: 2 })],
    ["vulnerabilities as an array", JSON.stringify({ auditReportVersion: 2, vulnerabilities: [] })],
  ])("throws for %s", async (_name, raw) => {
    const { advisoryIds } = await load();
    expect(() => advisoryIds(raw)).toThrow();
  });
});
