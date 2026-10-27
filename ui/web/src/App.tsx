// The shell: two tabs, chosen by the URL hash (#/dashboard, #/chat). No router library.
import { useEffect, useState } from "react";
import type { AgentClient } from "./agentClient";
import type { Api } from "./api";
import { SESSION_ENDED } from "./api";
import { ChatPage } from "./pages/ChatPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AlertTriangle, BrandMark, LayoutDashboard, MessageSquare } from "./components/Icons";

export type Route = "dashboard" | "chat";

/** The tab for a URL hash; anything unknown, "#s=…" included, is the dashboard. */
export function routeOf(hash: string): Route {
  return hash === "#/chat" ? "chat" : "dashboard";
}

const TABS: [Route, string, typeof LayoutDashboard][] = [
  ["dashboard", "Dashboard", LayoutDashboard],
  ["chat", "Chat", MessageSquare],
];

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
    <div className="app">
      <header className="topnav">
        <div className="container topnav-inner">
          <h1 className="brand">
            <BrandMark />
            <span className="brand-word">finos</span>
          </h1>
          <nav className="nav" aria-label="Pages">
            {TABS.map(([name, label, TabIcon]) => (
              <a
                key={name} href={`#/${name}`} aria-current={route === name ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  window.history.pushState(null, "", `#/${name}`);
                  setRoute(name);
                }}
              >
                <TabIcon size={18} />
                <span>{label}</span>
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="container main">
        {api === null || agent === undefined ? (
          <section className="panel empty-state is-error">
            <span className="empty-state-icon"><AlertTriangle size={28} /></span>
            <p className="error" role="alert">{SESSION_ENDED}</p>
          </section>
        ) : (
          <>
            {route === "dashboard" && (
              <div className="page">
                <DashboardPage api={api} />
              </div>
            )}
            {chatOpened && (
              <div className="page" hidden={route !== "chat"}>
                <ChatPage api={api} agent={agent} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
