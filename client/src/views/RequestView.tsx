import { Bot, Camera, Loader2, Send, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorNote, PageHeader } from "../components/common";
import { screenshotUrl } from "../lib/api";
import { trpc } from "../lib/trpc";
import type { ChatReply } from "../lib/types";
import { AnimatePresence, motion, MotionButton } from "../components/animation/motion";

type Message = { id: number; from: "you" | "meadow"; text: string; buttons?: ChatReply["buttons"]; shots?: number[]; used?: boolean };

const STORAGE_KEY = "meadow-chat";
const EXAMPLES = [
  { kind: "New app", text: "Build a meeting-notes app that turns pasted notes into an action board with owners and due dates" },
  { kind: "Feature", text: "Add a dark mode toggle to my portfolio project" },
  { kind: "Bug", text: "The checkout page crashes when the cart is empty" },
];
const STEPS = [
  ["Ask", "Up to five short questions"],
  ["Plan", "SPEC.md + PLAN.md with real checks"],
  ["Approve", "Nothing runs until you say so"],
  ["Build", "Phase by phase, verified, on Telegram"],
] as const;

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
    if (messages.length) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
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
        eyebrow="00 / NEW REQUEST"
        title="Say what you want built."
        description="Plain language is fine. Meadow asks up to five short questions, writes a SPEC and a phased PLAN with real checks, and waits for your approval before touching code. Paste a full PLAN.md to skip straight to review."
        action={messages.length ? <MotionButton className="button secondary" onClick={() => { setMessages([]); chatAction.mutate({ action: "cancel" }); }}>Clear conversation</MotionButton> : undefined}
      />
      <section className="panel chat-panel">
        <div className="chat-list" ref={listRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-start">
              <ol className="chat-steps">
                {STEPS.map(([title, body], i) => (
                  <motion.li key={title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.06 * i, ease: [0.22, 1, 0.36, 1] }}>
                    <span>{String(i + 1).padStart(2, "0")}</span><strong>{title}</strong><em>{body}</em>
                  </motion.li>
                ))}
              </ol>
              <div className="chat-start-label">Start from an example, or type your own below</div>
              <div className="example-grid">
                {EXAMPLES.map((example, i) => (
                  <motion.button key={example.text} className="example-card" onClick={() => send(example.text)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }} whileTap={{ scale: 0.99 }} transition={{ duration: 0.4, delay: 0.24 + 0.08 * i, ease: [0.22, 1, 0.36, 1] }}>
                    <span className="example-kind">{String(i + 1).padStart(2, "0")} / {example.kind}</span>
                    <span className="example-text">{example.text}</span>
                    <span className="example-go">Send <Send size={12} /></span>
                  </motion.button>
                ))}
              </div>
              <span className="chat-start-foot">Paste a full PLAN.md to skip the questions. Commands like /status, /projects, /pause and /help work here too, same as Telegram.</span>
            </div>
          ) : null}
          {messages.map(message => (
            <motion.div key={message.id} className={`chat-message ${message.from}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
              <div className="chat-avatar">{message.from === "you" ? <User size={14} /> : <Bot size={14} />}</div>
              <div className="chat-bubble">
                <pre>{message.text}</pre>
                {message.shots?.length ? <div className="chat-shots">{message.shots.map(id => <a key={id} href={screenshotUrl(id)} target="_blank" rel="noreferrer"><img src={screenshotUrl(id)} alt="Screenshot" /></a>)}</div> : null}
                <AnimatePresence initial={false}>
                {message.buttons?.length && !message.used ? (
                  <motion.div className="chat-buttons" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
                    {message.buttons.map((row, i) => <div key={i} className="chat-button-row">{row.map(button => <button key={button.action} className="button secondary small" disabled={busy} onClick={() => press(message.id, button.label, button.action)}>{button.label}</button>)}</div>)}
                  </motion.div>
                ) : null}
                </AnimatePresence>
              </div>
            </motion.div>
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
          <MotionButton className="button primary" type="submit" disabled={busy || !draft.trim()}><Send size={15} /> Send</MotionButton>
        </form>
      </section>
    </>
  );
}
