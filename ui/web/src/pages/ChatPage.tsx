// E4.3: the chat page. The question goes to POST /agent through the agent client; the events
// become a list of items (chatState.ts) that are drawn as they arrive. The assistant's text is a
// plain text node: no Markdown, link, image or math. Nothing of the chat is stored: the list is
// in memory, and a closed tab forgets it (S7). The spend line shows what the server records.
import { useEffect, useRef, useState } from "react";
import type { Meta } from "../../../server/src/api-types";
import { type AgentClient, ChatError, UNREADABLE_CHAT } from "../agentClient";
import { type Api } from "../api";
import { type ChatItem, applyEvent, endOpenTools } from "../chatState";
import { ToolCall } from "../components/ToolCall";
import { formatUsd, monthOf } from "../format";

const MAX_QUESTION = 2_000;
const ENDED_EARLY = "The chat answer ended before it was complete.";

type Props = { api: Api; agent: AgentClient; newId?: () => string };

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

  return (
    <div className="chat">
      {meta && (
        <p className="muted spend">
          <span>AI spend this month: {formatUsd(meta.spent_this_month)} of {formatUsd(meta.budget_usd)} limit.</span>{" "}
          <span>The chat shares this limit with finos sync.</span>
        </p>
      )}
      <div className="log" ref={log} role="log" aria-label="Chat" aria-live="polite">
        {items.length === 0 && <p className="empty">Ask a question about your record.</p>}
        {items.map((item) => {
          switch (item.kind) {
            case "user":
              return <p key={item.id} className="bubble user">{item.text}</p>;
            case "assistant":
              return item.text === "" ? null : <p key={item.id} className="bubble assistant">{item.text}</p>;
            case "tool":
              return <ToolCall key={item.id} item={item} />;
            case "error":
              return <p key={item.id} className="error" role="alert">{item.text}</p>;
          }
        })}
      </div>
      {items.length === 0 && (
        <div className="suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" disabled={running} onClick={() => void send(s)}>{s}</button>
          ))}
        </div>
      )}
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
          <button type="button" onClick={() => stop.current?.abort()}>Stop</button>
        ) : null}
        <button type="submit" disabled={running || draft.trim() === ""}>Send</button>
      </form>
    </div>
  );
}
