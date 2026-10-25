// The client of the dashboard API (/api/*). It sends the second factor X-Finos-Session; the
// cookie goes along because the page is on the same origin. Errors become plain text for the
// page: the server's {error} when it is a short string, else a fixed text. A raw body, a
// network error's message and a stack never reach the screen.
import type { Goal, Health, Meta, MonthView, Spreads, Summary } from "../../server/src/api-types";
import { z } from "./zod";

export const SESSION_ENDED = "Session ended. Stop the UI server and start it again.";
const NO_ANSWER = "The UI server did not answer. Is it still running?";
const UNREADABLE = "The server answer could not be read.";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const ErrorBody = z.object({ error: z.string().min(1).max(200) });

type Deps = { fetch: typeof globalThis.fetch; session: string };

export function createApi({ fetch, session }: Deps) {
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        headers: { "X-Finos-Session": session, Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(NO_ANSWER, 0);
    }
    if (response.status === 401 || response.status === 403) throw new ApiError(SESSION_ENDED, response.status);
    if (!response.ok) {
      const body = await response.json().then((v: unknown) => ErrorBody.safeParse(v), () => null);
      const text = body?.success ? body.data.error : `The server could not answer (status ${response.status}).`;
      throw new ApiError(text, response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(UNREADABLE, response.status);
    }
  }

  const flag = (spread: boolean) => (spread ? "1" : "0");
  return {
    meta: (signal?: AbortSignal) => get<Meta>("/api/meta", signal),
    summary: ({ spread, months }: { spread: boolean; months: number }, signal?: AbortSignal) =>
      get<Summary[]>(`/api/summary?spread=${flag(spread)}&months=${months}`, signal),
    /** `month` is "YYYY-MM", as the picker holds it. */
    month: (month: string, { spread }: { spread: boolean }, signal?: AbortSignal) => {
      if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return Promise.reject(new ApiError("Write the month as YYYY-MM.", 0));
      }
      return get<MonthView>(`/api/month/${month}?spread=${flag(spread)}`, signal);
    },
    goals: (signal?: AbortSignal) => get<Goal[]>("/api/goals", signal),
    spreads: (signal?: AbortSignal) => get<Spreads>("/api/spreads", signal),
    health: (signal?: AbortSignal) => get<Health>("/api/health", signal),
  };
}

export type Api = ReturnType<typeof createApi>;
