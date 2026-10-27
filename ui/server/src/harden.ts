// The first module boot.ts runs, and the only one it imports statically. It imports nothing,
// so no SDK or driver is evaluated before the environment is clean (S4).
//
// hardenEnv deletes every ANTHROPIC_* variable: the Anthropic SDK reads ANTHROPIC_API_KEY,
// ANTHROPIC_BASE_URL, ANTHROPIC_LOG and others, and the laptop's Claude Code sets some of them.
// It also refuses a start whose flags or variables could load code into this process or expose
// its TLS traffic, which carries the Doppler token, the Neon string and the Anthropic key. The
// ui scripts already clear NODE_OPTIONS and NODE_PATH; this is detection on top.

const REFUSED_FLAGS = [
  /^--require$/, /^-r$/, /^--import$/, /^--loader$/, /^--experimental-loader$/,
  /^--inspect(-.*)?$/, /^--use-env-proxy$/, /^--insecure-http-parser$/, /^--openssl-.*$/,
  /^--env-file(-if-exists)?$/,
];

export const FIXED_ERROR_LINE = "finos ui: an unexpected error stopped the server.";

type Env = Record<string, string | undefined>;

function refusedFlag(argument: string): string | null {
  if (/^-r./.test(argument)) return "-r"; // the module attached, as in -r./x.js
  const flag = argument.split("=", 1)[0]!;
  return REFUSED_FLAGS.some((pattern) => pattern.test(flag)) ? flag : null;
}

/** Clean env in place, or throw an Error that names the flag or variable (never its value). */
export function hardenEnv({ env, execArgv }: { env: Env; execArgv: readonly string[] }): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_")) delete env[name];
  }
  const options = (env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  const sources = [["NODE_OPTIONS", options], ["the node command", execArgv]] as const;
  for (const [where, list] of sources) {
    for (const argument of list) {
      const flag = refusedFlag(argument);
      if (flag) throw new Error(`The UI server does not start with ${flag} in ${where}.`);
    }
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("The UI server does not start with NODE_TLS_REJECT_UNAUTHORIZED=0. Unset it.");
  }
  for (const name of ["NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"]) {
    if (env[name] !== undefined) {
      throw new Error(`The UI server does not start with ${name} set. Unset it.`);
    }
  }
}

type ProcessLike = {
  on(event: "uncaughtException" | "unhandledRejection", handler: (error: unknown) => void): unknown;
  exit(code: number): unknown;
  stderr: { write(text: string): unknown };
};

/** One fixed line and exit 1 for any error nothing caught. Node's default would print the
 * error object, and an SDK or driver error can hold a header, a URL or a response body. */
export function installErrorHandlers(proc: ProcessLike): void {
  const stop = () => {
    proc.stderr.write(`${FIXED_ERROR_LINE}\n`);
    proc.exit(1);
  };
  proc.on("uncaughtException", stop);
  proc.on("unhandledRejection", stop);
}
