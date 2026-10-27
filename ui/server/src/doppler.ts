// The Doppler download of config ui, the root config of the environment ui in project finos
// (S4). It holds exactly ANTHROPIC_KEY and NEON_READONLY_URL. The two values go into Secret
// objects and nowhere else: never process.env, a file or a log.
//
// The proof that this is the root config is the download's own DOPPLER_PROJECT,
// DOPPLER_ENVIRONMENT and DOPPLER_CONFIG; the token prefix (keychain.ts) is a first filter. Any
// other secret name stops the start: a branch config of prd would bring the statement
// passwords and the Google key.
import { StartError } from "./errors.js";
import { KEYCHAIN_ITEM } from "./keychain.js";
import { Secret } from "./secret.js";

export const DOPPLER_DOWNLOAD_URL =
  "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
const IDENTITY = { DOPPLER_PROJECT: "finos", DOPPLER_ENVIRONMENT: "ui", DOPPLER_CONFIG: "ui" };
const NAMES = ["ANTHROPIC_KEY", "NEON_READONLY_URL"] as const;
const TIMEOUT_MS = 15_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type UiSecrets = {
  readonly anthropicKey: Secret;
  readonly neonUrl: Secret;
  readonly names: string[];
};

export async function loadSecrets({ token, fetch }: { token: Secret; fetch: Fetch }) {
  let response: Response;
  try {
    // The only request that carries the token. redirect: "error", so no other host gets it.
    response = await fetch(DOPPLER_DOWNLOAD_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.reveal()}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StartError("Doppler could not be reached. Check the network and start again.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new StartError(
      `The Doppler token in the Keychain item ${KEYCHAIN_ITEM} is refused or expired ` +
        `(HTTP ${response.status}). Make a new read-only service token in config ui.`,
    );
  }
  if (response.status !== 200) {
    throw new StartError(`Doppler answered HTTP ${response.status}. Try again shortly.`);
  }
  let values: Record<string, string>;
  try {
    values = strings(await response.json());
  } catch {
    throw new StartError("The Doppler download is not an object of secret values.");
  }

  for (const [name, wanted] of Object.entries(IDENTITY)) {
    if (values[name] !== wanted) {
      throw new StartError(
        "Doppler config ui must be the root config of environment ui in project finos. " +
          "Make the environment ui and use its root config, not a branch of prd.",
      );
    }
  }
  const extra = Object.keys(values)
    .filter((n) => !n.startsWith("DOPPLER_") && !(NAMES as readonly string[]).includes(n))
    .sort();
  if (extra.length) {
    throw new StartError(
      `Doppler config ui holds secrets the UI must not have: ${extra.join(", ")}. ` +
        `Delete them; config ui holds only ${NAMES.join(" and ")}.`,
    );
  }
  const missing = NAMES.filter((n) => !values[n]);
  if (missing.length) {
    throw new StartError(`Doppler config ui has no ${missing.join(" and no ")}. Add it.`);
  }
  return {
    anthropicKey: new Secret(values.ANTHROPIC_KEY!),
    neonUrl: new Secret(values.NEON_READONLY_URL!),
    names: [...NAMES],
  } satisfies UiSecrets;
}

function strings(data: unknown): Record<string, string> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error();
  const entries = Object.entries(data);
  if (!entries.every(([, v]) => typeof v === "string")) throw new Error();
  return Object.fromEntries(entries) as Record<string, string>;
}
