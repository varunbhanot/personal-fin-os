// @vitest-environment node
// S7: the browser renders typed data only, and keeps no chat or figures after the tab closes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sources = files(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const text = (path: string) => readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");

describe("the web sources", () => {
  it("find at least the app, the client and the components", () => {
    expect(sources.length).toBeGreaterThan(8);
  });

  it("never set HTML, evaluate text or write a script", () => {
    for (const path of sources) {
      expect(text(path), path).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });

  it("never use localStorage or IndexedDB; sessionStorage only in session.ts", () => {
    for (const path of sources) {
      expect(text(path), path).not.toMatch(/localStorage|indexedDB/);
      if (!path.endsWith("session.ts")) expect(text(path), path).not.toMatch(/sessionStorage/);
    }
  });

  it("never name a remote host", () => {
    for (const path of sources) {
      expect(text(path), path).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);
    }
  });

  it("set no inline style attribute in markup (React style props are written through the CSSOM)", () => {
    for (const path of sources) expect(text(path), path).not.toMatch(/setAttribute\(\s*["']style/);
    expect(readFileSync(new URL("../index.html", import.meta.url), "utf8")).not.toMatch(/\sstyle=|<style|<script(?![^>]*\ssrc=)/);
  });
});
