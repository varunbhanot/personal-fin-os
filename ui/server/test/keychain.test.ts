// S4: the only Keychain reader. execFile is a fake: no test runs /usr/bin/security.
import { readFileSync, readdirSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { checkTokenShape, readToken } from "../src/keychain.js";

const TOKEN = "dp.st.ui.AbC123xyz";
const SRC = new URL("../src/", import.meta.url).pathname;

function fakeExecFile(result: { stdout?: string; error?: Error }) {
  return vi.fn(async (_file: string, _args: readonly string[], _options: object) => {
    if (result.error) throw result.error;
    return { stdout: result.stdout ?? "" };
  });
}

describe("readToken", () => {
  it("runs /usr/bin/security with no shell, an empty environment and the login keychain", async () => {
    const execFile = fakeExecFile({ stdout: `${TOKEN}\n` });

    const token = await readToken({ execFile, home: "/Users/me" });

    expect(token.reveal()).toBe(TOKEN);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe("/usr/bin/security");
    expect(args).toEqual([
      "find-generic-password", "-s", "finos-ui", "-a", "doppler", "-w",
      "/Users/me/Library/Keychains/login.keychain-db",
    ]);
    expect(options).toMatchObject({ env: {}, encoding: "utf8" });
    expect((options as { timeout: number }).timeout).toBeGreaterThan(0);
    expect((options as { maxBuffer: number }).maxBuffer).toBeLessThanOrEqual(4096);
    expect(options).not.toHaveProperty("shell");
  });

  it("names the item and shows no output when the read fails", async () => {
    const error = Object.assign(new Error("security: SecKeychainSearch dp.st.ui.LEAK"), {
      stdout: "dp.st.ui.LEAK", stderr: "dp.st.ui.LEAK",
    });

    const read = readToken({ execFile: fakeExecFile({ error }), home: "/Users/me" });

    await expect(read).rejects.toThrow(/^Keychain item finos-ui not readable/);
    await expect(read).rejects.not.toThrow("LEAK");
  });

  it("refuses a token of the wrong shape without its value", async () => {
    const read = readToken({ execFile: fakeExecFile({ stdout: "dp.st.prd.LEAK\n" }), home: "/h" });

    await expect(read).rejects.toThrow("finos-ui");
    await expect(read).rejects.not.toThrow("LEAK");
  });
});

describe("checkTokenShape", () => {
  it("accepts a service token of the root config ui", () => {
    expect(checkTokenShape(TOKEN).reveal()).toBe(TOKEN);
  });

  it.each([
    "dp.st.prd.AbC123", "dp.st.ui_dev.AbC123", "dp.st.ui_prd.AbC123", "dp.pt.AbC123",
    "dp.ct.AbC123", "dp.sa.AbC123", "", "dp.st.ui.", "dp.st.ui.AbC 123", "dp.st.ui.AbC\t123",
    " dp.st.ui.AbC123", "dp.st.ui.AbC123 ", "dp.st.ui.AbC123\n", "dp.st.ui.Ab-C",
  ])("refuses %j and never shows it", (value) => {
    expect(() => checkTokenShape(value)).toThrow("Keychain item finos-ui");
    // "dp.st.ui." itself is in the message, which says what the token must start with.
    if (value.trim().length > 9) expect(() => checkTokenShape(value)).not.toThrow(value.trim());
  });
});

describe("the token", () => {
  it("never shows its value in JSON, inspect or a string", () => {
    const token = checkTokenShape(TOKEN);

    expect(JSON.stringify({ token })).not.toContain("AbC123");
    expect(inspect(token, { showHidden: true, depth: 9 })).not.toContain("AbC123");
    expect(`${token}`).not.toContain("AbC123");
  });
});

describe("the source", () => {
  const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const text = (f: string) => readFileSync(SRC + f, "utf8");

  it("never stores a Keychain item or passes a value after -w", () => {
    for (const file of sources) {
      expect(text(file), file).not.toContain("add-generic-password");
      for (const match of text(file).matchAll(/"-w",\s*([^\]\n]*)/g)) {
        expect(match[1], file).toMatch(/^loginKeychain\(/);
      }
    }
  });

  it("reads the Keychain in keychain.ts only", () => {
    for (const file of sources.filter((f) => f !== "keychain.ts")) {
      expect(text(file), file).not.toMatch(/\/usr\/bin\/security|find-generic-password/);
    }
  });
});
