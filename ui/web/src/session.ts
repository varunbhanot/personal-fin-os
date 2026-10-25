// The session value (S3). ui/server redirects to /#s=<value> after /auth. The page moves the
// value to sessionStorage (scoped to scheme, host and port: a listener on another 127.0.0.1
// port never sees it) and clears the hash at once. Nothing else is ever stored.
export const SESSION_KEY = "finos.session";
const VALUE = /^[A-Za-z0-9_-]{20,128}$/; // base64url of 32 random bytes is 43 characters

type Parts = {
  location: { hash: string };
  history: { replaceState: (state: unknown, unused: string, url: string) => void };
  storage: Pick<Storage, "getItem" | "setItem">;
};

/** The session value for this tab: the one in "#s=" (kept, hash cleared), else the stored one. */
export function startSession(parts: Partial<Parts> = {}): string | null {
  const location = parts.location ?? window.location;
  const history = parts.history ?? window.history;
  const storage = parts.storage ?? window.sessionStorage;
  const given = /^#s=(.*)$/.exec(location.hash);
  if (given) {
    history.replaceState(null, "", "#/dashboard");
    if (VALUE.test(given[1]!)) storage.setItem(SESSION_KEY, given[1]!);
  }
  const stored = storage.getItem(SESSION_KEY);
  return stored !== null && VALUE.test(stored) ? stored : null;
}
