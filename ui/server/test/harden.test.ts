// S4: the process that holds the secrets refuses code injection flags and sheds ANTHROPIC_*.
// Inputs are fakes: the test never reads the worker's own process.execArgv.
import { describe, expect, it, vi } from "vitest";
import { FIXED_ERROR_LINE, hardenEnv, installErrorHandlers } from "../src/harden.js";

const clean = () => ({ HOME: "/Users/me", PATH: "/usr/bin" }) as Record<string, string | undefined>;

describe("hardenEnv", () => {
  it("removes every ANTHROPIC_ variable and keeps the rest", () => {
    const env = {
      ...clean(),
      ANTHROPIC_API_KEY: "sk-fake",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "https://evil.example",
      ANTHROPIC_LOG: "debug",
      ANTHROPIC_CUSTOM_HEADERS: "x: y",
    };

    hardenEnv({ env, execArgv: [] });

    expect(env).toEqual(clean());
  });

  it.each([
    "--require", "-r", "--import", "--loader", "--experimental-loader", "--inspect",
    "--inspect-brk", "--inspect-port", "--inspect-wait", "--use-env-proxy",
    "--insecure-http-parser", "--openssl-legacy-provider", "--openssl-config",
    "--env-file", "--env-file-if-exists",
  ])("refuses %s in NODE_OPTIONS and in execArgv, naming the flag", (flag) => {
    const fromOptions = () =>
      hardenEnv({ env: { ...clean(), NODE_OPTIONS: `--max-old-space-size=99 ${flag}=/tmp/x.js` }, execArgv: [] });
    const fromArgv = () => hardenEnv({ env: clean(), execArgv: [flag, "/tmp/x.js"] });

    expect(fromOptions).toThrow(flag);
    expect(fromArgv).toThrow(flag);
    expect(fromOptions).not.toThrow("/tmp/x.js");
  });

  it("refuses -r with its module attached, naming only -r", () => {
    const fromOptions = () => hardenEnv({ env: { ...clean(), NODE_OPTIONS: "-r./tmp/x.js" }, execArgv: [] });
    const fromArgv = () => hardenEnv({ env: clean(), execArgv: ["-rx"] });

    expect(fromOptions).toThrow("with -r in NODE_OPTIONS");
    expect(fromOptions).not.toThrow("x.js");
    expect(fromArgv).toThrow("with -r in the node command");
  });

  it.each([
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["NODE_EXTRA_CA_CERTS", "/tmp/ca.pem"],
    ["NODE_USE_ENV_PROXY", "1"],
  ])("refuses %s, naming the variable and not its value", (name, value) => {
    const run = () => hardenEnv({ env: { ...clean(), [name]: value }, execArgv: [] });

    expect(run).toThrow(name);
    if (value !== "0") expect(run).not.toThrow(value);
  });

  it("accepts a plain start, and NODE_TLS_REJECT_UNAUTHORIZED=1", () => {
    expect(() =>
      hardenEnv({ env: { ...clean(), NODE_TLS_REJECT_UNAUTHORIZED: "1" }, execArgv: [] }),
    ).not.toThrow();
  });
});

describe("the process-wide error handlers", () => {
  function fakeProcess() {
    const handlers = new Map<string, (error: unknown) => void>();
    return {
      handlers,
      on: (event: string, handler: (error: unknown) => void) => handlers.set(event, handler),
      exit: vi.fn(),
      stderr: { write: vi.fn() },
    };
  }

  it.each(["uncaughtException", "unhandledRejection"])(
    "write one fixed line for %s and exit 1, never the error",
    (event) => {
      const proc = fakeProcess();
      installErrorHandlers(proc);
      const error = Object.assign(new Error("key sk-ant-FAKE in postgresql://u:pw@h/db"), {
        cause: "dp.st.ui.FAKE",
        headers: { authorization: "Bearer dp.st.ui.FAKE" },
      });

      proc.handlers.get(event)!(error);

      expect(proc.stderr.write.mock.calls).toEqual([[`${FIXED_ERROR_LINE}\n`]]);
      expect(proc.exit).toHaveBeenCalledWith(1);
    },
  );
});
