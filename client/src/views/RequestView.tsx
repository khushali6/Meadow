import { Bot, Camera, Loader2, Send, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorNote, PageHeader } from "../components/common";
import { screenshotUrl } from "../lib/api";
import { trpc } from "../lib/trpc";
import type { ChatReply } from "../lib/types";

type Message = { id: number; from: "you" | "meadow"; text: string; buttons?: ChatReply["buttons"]; shots?: number[]; used?: boolean };

const STORAGE_KEY = "meadow-chat";
const EXAMPLES = [
  "Build a habit tracker web app with streaks and a weekly view",
  "Add a dark mode toggle to my portfolio project",
  "The checkout page crashes when the cart is empty",
];

function loadMessages(): Message[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function RequestView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  const chat = trpc.chat.useMutation();
  const chatAction = trpc.chatAction.useMutation();
  const shot = trpc.shot.useMutation();
  const busy = chat.isPending || chatAction.isPending || shot.isPending;

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-80)));
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const push = (message: Omit<Message, "id">) => setMessages(list => [...list, { ...message, id: Date.now() + Math.random() }]);

  const receive = async (reply: ChatReply) => {
    push({ from: "meadow", text: reply.text, buttons: reply.buttons });
    utils.overview.invalidate();
    utils.project.invalidate();
    if (reply.shot) {
      const result = await shot.mutateAsync(reply.shot).catch(error => ({ error: String(error.message ?? error) }));
      if ("error" in result) push({ from: "meadow", text: `Screenshot failed: ${result.error}` });
      else push({ from: "meadow", text: result.shots.length ? `Captured ${result.shots.length} screenshot${result.shots.length === 1 ? "" : "s"}.` : result.skipped.join("\n") || "Nothing was captured.", shots: result.shots.map(item => item.id) });
    }
  };

  const send = async (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    setDraft("");
    push({ from: "you", text: value });
    try {
      await receive(await chat.mutateAsync({ text: value }));
    } catch {
      // The error is shown under the composer.
    }
  };

  const press = async (messageId: number, label: string, action: string) => {
    setMessages(list => list.map(message => (message.id === messageId ? { ...message, used: true } : message)));
    push({ from: "you", text: label });
    try {
      await receive(await chatAction.mutateAsync({ action }));
      if (action.startsWith("approve:")) onNavigate("/");
    } catch {
      // Shown below.
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="New request"
        title="Say what you want built."
        description="Plain language is fine. Meadow asks up to five short questions, writes a SPEC and a phased PLAN with real checks, and waits for your approval before touching code. Paste a full PLAN.md to skip straight to review."
        action={messages.length ? <button className="button secondary" onClick={() => { setMessages([]); chatAction.mutate({ action: "cancel" }); }}>Clear conversation</button> : undefined}
      />
      <section className="panel chat-panel">
        <div className="chat-list" ref={listRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-empty">
              <Bot size={22} />
              <strong>Try one of these, or type your own</strong>
              <div className="example-list">{EXAMPLES.map(example => <button key={example} className="example-chip" onClick={() => send(example)}>{example}</button>)}</div>
              <span>Commands like /status, /projects, /pause and /help work here too, same as Telegram.</span>
            </div>
          ) : null}
          {messages.map(message => (
            <div key={message.id} className={`chat-message ${message.from}`}>
              <div className="chat-avatar">{message.from === "you" ? <User size={14} /> : <Bot size={14} />}</div>
              <div className="chat-bubble">
                <pre>{message.text}</pre>
                {message.shots?.length ? <div className="chat-shots">{message.shots.map(id => <a key={id} href={screenshotUrl(id)} target="_blank" rel="noreferrer"><img src={screenshotUrl(id)} alt="Screenshot" /></a>)}</div> : null}
                {message.buttons?.length && !message.used ? (
                  <div className="chat-buttons">
                    {message.buttons.map((row, i) => <div key={i} className="chat-button-row">{row.map(button => <button key={button.action} className="button secondary small" disabled={busy} onClick={() => press(message.id, button.label, button.action)}>{button.label}</button>)}</div>)}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {busy ? <div className="chat-message meadow"><div className="chat-avatar"><Bot size={14} /></div><div className="chat-bubble thinking">{shot.isPending ? <><Camera size={14} /> Taking screenshots…</> : <><Loader2 size={14} className="spin-slow" /> Thinking…</>}</div></div> : null}
        </div>
        <ErrorNote error={chat.error ?? chatAction.error} />
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(draft); }}>
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(draft); } }}
            placeholder="Describe a new app, a feature, or a bug…"
            rows={3}
            aria-label="Message"
          />
          <button className="button primary" type="submit" disabled={busy || !draft.trim()}><Send size={15} /> Send</button>
        </form>
      </section>
    </>
  );
}
