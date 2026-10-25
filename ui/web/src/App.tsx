// The shell: two tabs, chosen by the URL hash (#/dashboard, #/chat). No router library.
import { useEffect, useState } from "react";
import type { AgentClient } from "./agentClient";
import type { Api } from "./api";
import { SESSION_ENDED } from "./api";
import { ChatPage } from "./pages/ChatPage";
import { DashboardPage } from "./pages/DashboardPage";

export type Route = "dashboard" | "chat";

/** The tab for a URL hash; anything unknown, "#s=…" included, is the dashboard. */
export function routeOf(hash: string): Route {
  return hash === "#/chat" ? "chat" : "dashboard";
}

const TABS: [Route, string][] = [["dashboard", "Dashboard"], ["chat", "Chat"]];

export function App({ api, agent }: { api: Api | null; agent?: AgentClient }) {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  // The chat stays mounted once opened, hidden when another tab shows: a tab switch must not
  // lose the conversation or stop a run that is in progress.
  const [chatOpened, setChatOpened] = useState(route === "chat");
  useEffect(() => {
    if (route === "chat") setChatOpened(true);
  }, [route]);
  useEffect(() => {
    const sync = () => setRoute(routeOf(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>finos</h1>
        <nav aria-label="Pages">
          {TABS.map(([name, label]) => (
            <a
              key={name} href={`#/${name}`} aria-current={route === name ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                window.history.pushState(null, "", `#/${name}`);
                setRoute(name);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {api === null || agent === undefined ? (
          <p className="error" role="alert">{SESSION_ENDED}</p>
        ) : (
          <>
            {route === "dashboard" && <DashboardPage api={api} />}
            {chatOpened && (
              <div hidden={route !== "chat"}>
                <ChatPage api={api} agent={agent} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
