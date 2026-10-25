// E3.2.1: the page takes the session value from "#s=" once, keeps it in sessionStorage (scoped
// to scheme, host and port), and clears the hash.
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_KEY, startSession } from "../src/session";

const VALUE = "abcDEF0123456789_-abcDEF0123456789_-abc"; // 39 base64url characters

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("startSession", () => {
  it("stores the value from the hash, clears the hash and returns the value", () => {
    window.location.hash = `#s=${VALUE}`;

    const session = startSession();

    expect(session).toBe(VALUE);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(VALUE);
    expect(window.location.hash).toBe("#/dashboard");
    expect(window.location.href).not.toContain(VALUE);
    expect(sessionStorage.length).toBe(1);
  });

  it("reads the hash once: a later start takes the stored value", () => {
    window.location.hash = `#s=${VALUE}`;
    startSession();

    expect(startSession()).toBe(VALUE);
    expect(window.location.hash).toBe("#/dashboard");
  });

  it("leaves another hash alone and returns the stored value, or null", () => {
    expect(startSession()).toBeNull();
    sessionStorage.setItem(SESSION_KEY, VALUE);
    window.location.hash = "#/chat";

    expect(startSession()).toBe(VALUE);
    expect(window.location.hash).toBe("#/chat");
  });

  it("clears a hash value of the wrong shape and does not store it", () => {
    window.location.hash = "#s=<script>alert(1)</script>";

    expect(startSession()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(window.location.hash).toBe("#/dashboard");
  });

  it("replaces an older value with the new one (a new server start)", () => {
    sessionStorage.setItem(SESSION_KEY, "old".repeat(14));
    window.location.hash = `#s=${VALUE}`;

    expect(startSession()).toBe(VALUE);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(VALUE);
  });

  it("works with injected parts and writes nothing to localStorage", () => {
    const calls: unknown[][] = [];
    const store = new Map<string, string>();
    const session = startSession({
      location: { hash: `#s=${VALUE}` },
      history: { replaceState: (...args: unknown[]) => void calls.push(args) },
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    });

    expect(session).toBe(VALUE);
    expect(calls).toEqual([[null, "", "#/dashboard"]]);
    expect(localStorage.length).toBe(0);
  });
});
