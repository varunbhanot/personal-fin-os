// Start-up: move the session value out of the URL, then draw the app. No other state is kept.
import "./zod"; // first: it must run before any schema is made
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createAgentClient } from "./agentClient";
import { createApi } from "./api";
import { startSession } from "./session";
import "./theme.css";

const session = startSession();
const fetch = window.fetch.bind(window);
const api = session ? createApi({ fetch, session }) : null;
const agent = session ? createAgentClient({ fetch, session }) : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={api} agent={agent} />
  </StrictMode>,
);
