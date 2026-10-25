// The shell: two tabs by URL hash, and a plain message when the page has no session.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentClient } from "../src/agentClient";
import { createApi } from "../src/api";
import { App, routeOf } from "../src/App";
import { SESSION, goldenFetch } from "./fixtures";

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("routeOf", () => {
  it.each([
    ["", "dashboard"], ["#/dashboard", "dashboard"], ["#/chat", "chat"], ["#/other", "dashboard"],
    ["#s=abc", "dashboard"],
  ] as const)("%j is %s", (hash, route) => {
    expect(routeOf(hash)).toBe(route);
  });
});

describe("App", () => {
  it("shows the dashboard first, and switches tabs by hash", async () => {
    const api = createApi({ fetch: goldenFetch().fetch, session: SESSION });
    render(<App api={api} agent={createAgentClient({ fetch: goldenFetch().fetch, session: SESSION })} />);

    expect(await screen.findByRole("heading", { name: "Sep 2026" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");

    await userEvent.click(screen.getByRole("link", { name: "Chat" }));

    expect(window.location.hash).toBe("#/chat");
    expect(screen.getByRole("link", { name: "Chat" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("textbox", { name: "Your question" })).toBeTruthy();
    expect(screen.queryByText("The chat page is not built yet.")).toBeNull();
  });

  it("opens on the chat tab for #/chat and keeps the chat when the tab is left", async () => {
    window.history.replaceState(null, "", "/#/chat");
    const fetch = goldenFetch().fetch;
    render(<App api={createApi({ fetch, session: SESSION })} agent={createAgentClient({ fetch, session: SESSION })} />);

    await userEvent.type(await screen.findByRole("textbox", { name: "Your question" }), "draft");
    await userEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(window.location.hash).toBe("#/dashboard");
    expect(await screen.findByRole("heading", { name: "Sep 2026" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Chat" }));

    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveProperty("value", "draft");
  });

  it("tells the user to restart the server when there is no session", () => {
    render(<App api={null} />);

    expect(screen.getByRole("alert").textContent).toBe("Session ended. Stop the UI server and start it again.");
    expect(screen.queryByRole("group", { name: "Income" })).toBeNull();
  });
});
