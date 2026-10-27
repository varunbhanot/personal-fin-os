// E5.1: the scripts of ui/package.json. The laptop runs `ui` and `ui-check` from the compiled
// dist/boot.js with no preload; `build` builds the web app first, then the server, each from its
// lock file; nothing runs `npm install`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const scripts: Record<string, string> = JSON.parse(read("../../package.json")).scripts;

const CLEAN_NODE = "env -u NODE_OPTIONS -u NODE_PATH node server/dist/boot.js";

describe("ui/package.json scripts", () => {
  it("has the scripts of the plan, and no others", () => {
    expect(Object.keys(scripts).sort()).toEqual(
      ["build", "check", "check:server", "e2e", "fake", "ui", "ui-check"].sort(),
    );
  });

  it("runs ui and ui-check from dist/boot.js with NODE_OPTIONS and NODE_PATH cleared", () => {
    expect(scripts.ui).toBe(CLEAN_NODE);
    expect(scripts["ui-check"]).toBe(`${CLEAN_NODE} --check`);
  });

  it("gives no script a preload, an import hook, an inspector or an env file", () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(
        /--require|\s-r\s|--import|--loader|--inspect|--env-file|--use-env-proxy/,
      );
    }
  });

  it("builds the web app before the server, each after `npm ci --ignore-scripts`", () => {
    const steps = scripts.build!.split("&&").map((s) => s.trim());
    expect(steps).toEqual([
      "npm --prefix web ci --ignore-scripts",
      "npm --prefix web run build",
      "npm --prefix server ci --ignore-scripts",
      "npm --prefix server run build",
    ]);
  });

  it("never runs npm install, npx, tsx or a dev server", () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/npm (install|i|add|update)\b|\bnpx\b|\btsx\b|ts-node/);
      expect(command, name).not.toMatch(/--dev|--no-browser|--print-url|vite (dev|serve)/);
    }
  });

  it("makes fake from the compiled dist/fake.js, with the same clean start as ui", () => {
    expect(scripts.fake).toBe(
      "npm --prefix server run build && env -u NODE_OPTIONS -u NODE_PATH node server/dist/fake.js",
    );
  });

  it("makes e2e build both trees, then run the smoke test (Playwright needs NODE_PATH)", () => {
    expect(scripts.e2e).toBe(
      "npm --prefix web run build && npm --prefix server run build && node e2e/smoke.mjs",
    );
  });

  it("keeps the two checks as before", () => {
    expect(scripts["check:server"]).toBe("npm --prefix server run check");
    expect(scripts.check).toBe("npm --prefix server run check && npm --prefix web run check");
  });

  it("does not put the web tree, the fake or the e2e in the laptop's check:server", () => {
    expect(scripts["check:server"]).not.toMatch(/web|fake|e2e/);
  });
});
