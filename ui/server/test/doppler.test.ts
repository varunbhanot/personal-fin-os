// S4: the Doppler download of config ui. fetch is an injected fake; no request leaves.
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { DOPPLER_DOWNLOAD_URL, loadSecrets } from "../src/doppler.js";
import { Secret } from "../src/secret.js";

const TOKEN = new Secret("dp.st.ui.FAKETOKEN123");
const KEY = "sk-ant-FAKEKEY-0000";
const NEON = "postgresql://finos_ui:FAKEPASS@ep-a-1.c-2.r.aws.neon.tech/neondb?sslmode=require";
const IDENTITY = { DOPPLER_PROJECT: "finos", DOPPLER_ENVIRONMENT: "ui", DOPPLER_CONFIG: "ui" };
const GOOD = { ...IDENTITY, ANTHROPIC_KEY: KEY, NEON_READONLY_URL: NEON };

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

describe("loadSecrets", () => {
  it("downloads with the bearer token, no redirect and a timeout", async () => {
    const fetch = fakeFetch(GOOD);

    const secrets = await loadSecrets({ token: TOKEN, fetch });

    expect(secrets.anthropicKey.reveal()).toBe(KEY);
    expect(secrets.neonUrl.reveal()).toBe(NEON);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(DOPPLER_DOWNLOAD_URL);
    expect(DOPPLER_DOWNLOAD_URL).toBe(
      "https://api.doppler.com/v3/configs/config/secrets/download?format=json",
    );
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer dp.st.ui.FAKETOKEN123");
    expect(init!.redirect).toBe("error");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.method ?? "GET").toBe("GET");
  });

  it.each([
    ["DOPPLER_PROJECT", "other"],
    ["DOPPLER_ENVIRONMENT", "prd"],
    ["DOPPLER_CONFIG", "ui_dev"],
    ["DOPPLER_CONFIG", undefined],
  ])("stops when %s is %s: config ui must be the root config", async (name, value) => {
    const body: Record<string, string | undefined> = { ...GOOD, [name]: value };

    const load = loadSecrets({ token: TOKEN, fetch: fakeFetch(body) });

    await expect(load).rejects.toThrow("config ui must be the root config of environment ui");
    await expect(load).rejects.not.toThrow(KEY);
  });

  it.each(["ANTHROPIC_KEY", "NEON_READONLY_URL"])("names a missing %s", async (name) => {
    const body: Record<string, string> = { ...GOOD };
    delete body[name];

    await expect(loadSecrets({ token: TOKEN, fetch: fakeFetch(body) })).rejects.toThrow(name);
  });

  it("stops on extra secrets and names them without a value", async () => {
    const body = { ...GOOD, PW_SBI: "FAKEPW1", GDRIVE_SA_JSON: "FAKESA", DOPPLER_ENCLAVE: "x" };

    const load = loadSecrets({ token: TOKEN, fetch: fakeFetch(body) });

    await expect(load).rejects.toThrow("GDRIVE_SA_JSON, PW_SBI");
    await expect(load).rejects.not.toThrow(/FAKEPW1|FAKESA|DOPPLER_ENCLAVE/);
  });

  it.each([401, 403])("names the Keychain item on HTTP %i and never echoes the body", async (s) => {
    const load = loadSecrets({ token: TOKEN, fetch: fakeFetch({ messages: ["FAKEBODY"] }, s) });

    await expect(load).rejects.toThrow(
      "The Doppler token in the Keychain item finos-ui is refused or expired",
    );
    await expect(load).rejects.not.toThrow("FAKEBODY");
  });

  it.each([301, 302, 307, 500])("does not follow or echo an HTTP %i", async (status) => {
    const load = loadSecrets({ token: TOKEN, fetch: fakeFetch("FAKEBODY", status) });

    await expect(load).rejects.toThrow(`HTTP ${status}`);
    await expect(load).rejects.not.toThrow("FAKEBODY");
  });

  it("gives a plain message when Doppler cannot be reached, a redirect included", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed: redirect mode is set to error dp.st.ui.FAKETOKEN123");
    });

    const load = loadSecrets({ token: TOKEN, fetch });

    await expect(load).rejects.toThrow("Doppler could not be reached");
    await expect(load).rejects.not.toThrow("FAKETOKEN");
  });

  it.each(['"not an object"', "[1]", "{bad json", '{"ANTHROPIC_KEY": 5}'])(
    "refuses a download that is not an object of strings: %s",
    async (body) => {
      await expect(loadSecrets({ token: TOKEN, fetch: fakeFetch(body) })).rejects.toThrow(
        "Doppler",
      );
    },
  );

  it("leaves no value in process.env, JSON or util.inspect", async () => {
    const before = JSON.stringify(process.env);

    const secrets = await loadSecrets({ token: TOKEN, fetch: fakeFetch(GOOD) });

    expect(JSON.stringify(process.env)).toBe(before);
    for (const shown of [JSON.stringify(secrets), inspect(secrets, { showHidden: true, depth: 9 })]) {
      expect(shown).not.toContain("FAKEKEY");
      expect(shown).not.toContain("FAKEPASS");
    }
    expect(secrets.names).toEqual(["ANTHROPIC_KEY", "NEON_READONLY_URL"]);
  });
});
