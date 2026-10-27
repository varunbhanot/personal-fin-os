// The only reader of the macOS Keychain (S4). The item finos-ui (account doppler) in the
// login keychain holds one read-only Doppler service token for the root config ui. The user
// makes it fresh with an empty trusted-app list (-T ""), so every read shows a prompt.
//
// /usr/bin/security runs through execFile: an absolute path, no shell, an empty environment,
// and no token in its arguments. Naming the login keychain stops an item of the same name in a
// keychain earlier in the search list from being used.
import { StartError } from "./errors.js";
import { Secret } from "./secret.js";

export const KEYCHAIN_ITEM = "finos-ui";
const ACCOUNT = "doppler";
const SECURITY = "/usr/bin/security";
// A service token of the root config ui: dp.st.ui.<letters and digits>. Refuses dp.st.prd.,
// a branch config (dp.st.ui_dev.), personal (dp.pt.) and CLI (dp.ct.) tokens.
const TOKEN_SHAPE = /^dp\.st\.ui\.[A-Za-z0-9]+$/;

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export function loginKeychain(home: string): string {
  return `${home}/Library/Keychains/login.keychain-db`;
}

export async function readToken({ execFile, home }: { execFile: ExecFile; home: string }) {
  let stdout: string;
  try {
    // The timeout leaves the user time to answer the Keychain prompt.
    ({ stdout } = await execFile(
      SECURITY,
      ["find-generic-password", "-s", KEYCHAIN_ITEM, "-a", ACCOUNT, "-w", loginKeychain(home)],
      { env: {}, encoding: "utf8", timeout: 120_000, maxBuffer: 4096 },
    ));
  } catch {
    throw new StartError(
      `Keychain item ${KEYCHAIN_ITEM} not readable. Make it again (setup guide, Part 8), ` +
        'and choose "Allow" at the prompt.',
    );
  }
  return checkTokenShape(stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout);
}

export function checkTokenShape(value: string): Secret {
  if (!TOKEN_SHAPE.test(value)) {
    throw new StartError(
      `Keychain item ${KEYCHAIN_ITEM} does not hold a service token of Doppler config ui ` +
        "(it must start with dp.st.ui.). Make a read-only service token in config ui.",
    );
  }
  return new Secret(value);
}
