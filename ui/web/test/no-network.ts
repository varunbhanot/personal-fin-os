// S8, the Vitest setup file of the web tree: no test reaches the real network (fetch, an
// XMLHttpRequest of jsdom or any socket that is not loopback). In a cloud session the proxy would
// attach the finos/prd Doppler token or the owner's Neon-Connection-String to any real request,
// also one from a jsdom test. A test passes its own fake explicitly (createApi({ fetch })). A
// refused call rejects, and fails the test after it ends even when the code under test catches
// the error.
import { Socket } from "node:net";
import { afterEach, beforeEach } from "vitest";

export const NETWORK_REFUSED = "real network call in a test";

const violations: string[] = [];

function refuse(what: string) {
  // A rejected promise, as a failed fetch gives.
  return function refuse(): Promise<never> {
    violations.push(what);
    return Promise.reject(new Error(`${NETWORK_REFUSED} (${what})`));
  };
}

/** The refused calls of this test so far, cleared. The guard's own proof test uses it. */
export function takeViolations(): string[] {
  return violations.splice(0);
}

function guard() {
  globalThis.fetch = refuse("fetch") as unknown as typeof fetch;
}

// Below fetch: node:net, node:tls, node:http(s), undici and pg all open a socket through
// net.Socket.prototype.connect. Only loopback and unix sockets (the throwaway Postgres) pass,
// and never the port of a loopback proxy: the cloud proxy listens on 127.0.0.1.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const PROXY_PORTS = new Set(
  ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].flatMap((name) => {
    try {
      const url = new URL(process.env[name] ?? "");
      return [Number(url.port || (url.protocol === "https:" ? 443 : 80))];
    } catch {
      return [];
    }
  }),
);
const connect = Socket.prototype.connect;
Socket.prototype.connect = function guardedConnect(this: Socket, ...args: unknown[]) {
  // net.connect passes its normalized [options, callback]; a direct call passes the parts.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = (typeof first === "object" && first !== null ? first : {}) as {
    path?: string; host?: string;
  };
  const isPath = typeof first === "string" || typeof options.path === "string";
  const host = typeof first === "number" ? args[1] : options.host;
  const port = Number(typeof first === "number" ? first : (options as { port?: unknown }).port);
  const loopback = host === undefined || (typeof host === "string" && LOOPBACK.has(host));
  if (isPath || (loopback && !PROXY_PORTS.has(port))) {
    return (connect as (...a: unknown[]) => Socket).apply(this, args);
  }
  const what = loopback ? "socket to a proxy port" : `socket to ${String(host)}`;
  violations.push(what);
  // Fail as a refused connection does: an "error" event, never a real connection.
  process.nextTick(() => this.destroy(new Error(`${NETWORK_REFUSED} (${what})`)));
  return this;
} as typeof Socket.prototype.connect;

guard();
// A test that stubs fetch itself gets the guard back for the next test.
beforeEach(guard);
afterEach(() => {
  guard();
  const found = takeViolations();
  if (found.length) throw new Error(`${NETWORK_REFUSED}: ${found.join(", ")}`);
});
