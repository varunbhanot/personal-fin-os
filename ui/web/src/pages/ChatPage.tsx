// E4.3: the chat page. The question goes to POST /agent through the agent client; the events
// become a list of items (chatState.ts) that are drawn as they arrive. The assistant's text is a
// plain text node: no Markdown, link, image or math. Nothing of the chat is stored: the list is
// in memory, and a closed tab forgets it (S7). The spend line shows what the server records.
import { useEffect, useRef, useState } from "react";
import type { Meta } from "../../../server/src/api-types";
import { type AgentClient, ChatError, UNREADABLE_CHAT } from "../agentClient";
import { type Api } from "../api";
import { type ChatItem, applyEvent, endOpenTools } from "../chatState";
import { AlertTriangle, BarChart, Coins, MessageSquare, Send, Sparkles, Square } from "../components/Icons";
import { ToolCall } from "../components/ToolCall";
import { formatUsd, monthOf } from "../format";
import "../styles/chat.css";

const MAX_QUESTION = 2_000;
const ENDED_EARLY = "The chat answer ended before it was complete.";

type Props = { api: Api; agent: AgentClient; newId?: () => string };

/** The share of the limit in use, 0 to 1, for the decorative meter only (the text says the figures). */
function share(meta: Meta): number {
  const spent = Number(meta.spent_this_month);
  const budget = Number(meta.budget_usd);
  if (!Number.isFinite(spent) || !Number.isFinite(budget) || budget <= 0) return 0;
  return Math.min(1, Math.max(0, spent / budget));
}

export function ChatPage({ api, agent, newId = () => crypto.randomUUID() }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const stop = useRef<AbortController | null>(null);
  const thread = useRef<string | null>(null);
  const log = useRef<HTMLDivElement | null>(null);

  const loadMeta = () => {
    api.meta().then(setMeta, () => undefined); // the spend line is a hint: a failure leaves it out
  };
  useEffect(loadMeta, [api]);
  useEffect(() => () => stop.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [items]);

  const month = meta && meta.months.length > 0 ? monthOf(meta.months[meta.months.length - 1]!) : null;
  const suggestions = ["How did last month compare?", ...(month ? [`Show spending by category for ${month}`] : [])];

  async function send(raw: string) {
    const question = raw.trim();
    if (running || question === "" || question.length > MAX_QUESTION) return;
    thread.current ??= newId();
    const abort = new AbortController();
    stop.current = abort;
    setRunning(true);
    setDraft("");
    setItems((old) => [...old, { kind: "user", id: newId(), text: question }]);
    const problem = (text: string) =>
      setItems((old) => [...old, { kind: "error", id: `error-${old.length}`, text }]);
    let finished = false;
    try {
      for await (const event of agent.run({ text: question, threadId: thread.current, runId: newId() }, abort.signal)) {
        if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") finished = true;
        setItems((old) => applyEvent(old, event));
      }
      if (!finished) problem(ENDED_EARLY);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        problem(error instanceof ChatError ? error.message : UNREADABLE_CHAT);
      }
    } finally {
      stop.current = null;
      setItems(endOpenTools); // a call with no result will get none now: stop its skeleton
      setRunning(false);
      loadMeta();
    }
  }

  const used = meta ? share(meta) : 0;

  return (
    <div className="chat chat-card">
      <header className="chat-head">
        <div className="chat-title">
          <span className="icon-chip" aria-hidden="true"><Sparkles size={18} /></span>
          <div className="chat-title-text">
            <p className="eyebrow">AI analyst</p>
            <h2>Ask your record</h2>
          </div>
        </div>
        {meta && (
          <div className={`chat-spend${used >= 0.9 ? " is-high" : ""}`}>
            <p className="muted spend">
              <Coins size={16} className="spend-icon" />
              <span className="spend-figure">AI spend this month: {formatUsd(meta.spent_this_month)} of {formatUsd(meta.budget_usd)} limit.</span>{" "}
              <span className="spend-note">The chat shares this limit with finos sync.</span>
            </p>
            <span className="spend-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${used})` }} />
            </span>
          </div>
        )}
      </header>
      <div className="log" ref={log} role="log" aria-label="Chat" aria-live="polite">
        {items.length === 0 && (
          <div className="empty-state chat-empty">
            <span className="empty-state-icon" aria-hidden="true"><MessageSquare size={26} /></span>
            <p className="empty">Ask a question about your record.</p>
            <p className="muted chat-empty-hint">Answers come from your statements, as figures, charts and tables.</p>
            <div className="suggestions">
              {suggestions.map((s, i) => (
                <button key={s} type="button" className="chip" disabled={running} onClick={() => void send(s)}>
                  {i === 0 ? <Sparkles size={16} /> : <BarChart size={16} />}
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="msg msg-user">
                  <p className="bubble user">{item.text}</p>
                </div>
              );
            case "assistant":
              return item.text === "" ? null : (
                <div key={item.id} className="msg msg-assistant">
                  <span className="msg-avatar" aria-hidden="true"><Sparkles size={14} /></span>
                  <p className="bubble assistant">{item.text}</p>
                </div>
              );
            case "tool":
              return (
                <div key={item.id} className="msg msg-tool">
                  <ToolCall item={item} />
                </div>
              );
            case "error":
              return (
                <div key={item.id} className="msg chat-error">
                  <AlertTriangle size={18} className="chat-error-icon" />
                  <p className="error" role="alert">{item.text}</p>
                </div>
              );
          }
        })}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="question" className="sr-only">Your question</label>
        <input
          id="question" type="text" value={draft} maxLength={MAX_QUESTION} autoComplete="off"
          placeholder="Ask about a month, a category or your goals" aria-label="Your question"
          onChange={(event) => setDraft(event.target.value)}
        />
        {running ? (
          <button type="button" className="btn btn-ghost" onClick={() => stop.current?.abort()}>
            <Square size={16} />
            <span>Stop</span>
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={running || draft.trim() === ""}>
          <Send size={16} />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}
