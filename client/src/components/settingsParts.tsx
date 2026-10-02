import { CheckCircle2, KeyRound, MessageCircle, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorNote, Toggle } from "./common";
import { trpc } from "../lib/trpc";
import type { Overview, Settings } from "../lib/types";
import { MotionButton } from "./animation/motion";

export const HEALTH_LABELS: Record<string, string> = { database: "Database", memory: "Memory", codeatlas: "CodeAtlas", llm: "Agent model", mcp: "MCP servers", telegram: "Telegram" };

export type Patch = Parameters<ReturnType<typeof trpc.updateSettings.useMutation>["mutate"]>[0];

export function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="panel settings-section">
      <div className="settings-section-head"><div><h2>{title}</h2><p>{description}</p></div></div>
      {children}
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="setting-control"><div><strong>{label}</strong>{hint ? <span>{hint}</span> : null}</div><div className="setting-inline">{children}</div></div>;
}

export function NumberInput({ value, onCommit, min, step = 1, suffix }: { value: number; onCommit: (value: number) => void; min?: number; step?: number; suffix?: string }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <span className="number-input">
      <input type="number" value={draft} min={min} step={step} onChange={event => setDraft(event.target.value)} onBlur={() => { const parsed = Number(draft); if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed); else setDraft(String(value)); }} />
      {suffix ? <em>{suffix}</em> : null}
    </span>
  );
}

export type SecretName = Parameters<ReturnType<typeof trpc.setSecret.useMutation>["mutate"]>[0]["name"];

export function SecretField({ name, present, label, placeholder }: { name: SecretName; present: boolean; label: string; placeholder: string }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState("");
  const save = trpc.setSecret.useMutation({ onSuccess: () => { setValue(""); utils.settings.invalidate(); utils.llmStatus.invalidate(); utils.llm.providers.invalidate(); utils.overview.invalidate(); utils.doctor.invalidate(); utils.atlas.status.invalidate(); } });
  return (
    <div className="secret-field">
      <Row label={label} hint={present ? "Stored in ~/.meadow/secrets.env (owner-only file). Never shown again." : "Not set"}>
        <span className={`status-tag ${present ? "passed" : "blocked"}`}>{present ? <CheckCircle2 size={10} /> : <XCircle size={10} />}{present ? "Set" : "Missing"}</span>
      </Row>
      <form className="search-row" onSubmit={event => { event.preventDefault(); save.mutate({ name, value }); }}>
        <input type="password" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder} aria-label={label} />
        <MotionButton className="button secondary" disabled={value.trim().length < 8 || save.isPending}><KeyRound size={14} /> {present ? "Replace" : "Save"}</MotionButton>
      </form>
      <ErrorNote error={save.error} />
    </div>
  );
}

export type TelegramStatus = NonNullable<Overview>["telegram"];

export function TelegramConnect({ tg, config, hasOwnToken, patch }: { tg: TelegramStatus | undefined; config: Settings["config"]; hasOwnToken: boolean; patch: (value: Patch) => void }) {
  const utils = trpc.useUtils();
  const [link, setLink] = useState<{ link: string; bot: string; expiresAt: string } | null>(null);
  const [advanced, setAdvanced] = useState(config.telegram.mode === "own");
  const refresh = () => { void utils.overview.invalidate(); void utils.settings.invalidate(); };
  const connect = trpc.connectTelegram.useMutation({ onSuccess: data => { setLink(data); refresh(); } });
  const disconnect = trpc.disconnectTelegram.useMutation({ onSuccess: () => { setLink(null); refresh(); } });
  const pair = trpc.pairTelegram.useMutation();
  const own = tg?.mode === "own";
  const waiting = Boolean(link) && !tg?.paired;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void utils.overview.invalidate(), 2000);
    return () => clearInterval(timer);
  }, [waiting, utils]);
  useEffect(() => {
    if (link && tg?.paired) {
      setLink(null);
      toast.success(`Telegram connected${tg.bot ? ` to @${tg.bot}` : ""}`);
    }
  }, [link, tg?.paired, tg?.bot]);

  const startConnect = () => {
    const tab = window.open("about:blank", "_blank");
    connect.mutate(undefined, {
      onSuccess: data => {
        if (!tab) return;
        tab.opener = null;
        tab.location.href = data.link;
      },
      onError: () => tab?.close(),
    });
  };

  const reconnecting = tg?.connection.state === "reconnecting";
  const state = reconnecting ? "Reconnecting…" : tg?.paired ? "Connected" : tg?.running ? "Waiting for you in Telegram" : tg?.configured ? "Not running" : "Not connected";
  return (
    <>
      <Row label="Status" hint={reconnecting && tg?.connection.nextRetryAt ? `Network trouble; retrying at ${new Date(tg.connection.nextRetryAt).toLocaleTimeString()}. No need to pair again.` : tg?.lastError ?? (tg?.bot ? `@${tg.bot}${own ? " (your bot)" : ""}` : undefined)}>
        <span className={`status-tag ${tg?.paired && tg.running ? "passed" : "queued"}`}><MessageCircle size={10} />{state}</span>
      </Row>
      {!own ? (
        tg?.paired ? (
          <Row label="Meadow bot" hint="Messages from your account reach only this computer.">
            <MotionButton className="button secondary" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</MotionButton>
          </Row>
        ) : tg?.hostedAvailable ? (
          <Row label="Connect" hint="Opens Telegram. Tap Start and you're connected; no bot or token to set up.">
            <MotionButton className="button" onClick={startConnect} disabled={connect.isPending}>{connect.isPending ? "Opening Telegram…" : link ? "New link" : "Connect Telegram"}</MotionButton>
          </Row>
        ) : (
          <Row label="Meadow bot" hint="This build has no hosted bot configured. Set the relay URL under Advanced, or use your own bot.">
            <span className="status-tag queued"><span />Unavailable</span>
          </Row>
        )
      ) : (
        <Row label="Your bot" hint={tg?.paired ? "Paired with your account." : "Send the pairing code to your bot within 15 minutes."}>
          {tg?.paired ? <MotionButton className="button secondary" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Unpair</MotionButton> : <MotionButton className="button secondary" onClick={() => pair.mutate()} disabled={pair.isPending || !hasOwnToken}>New pairing code</MotionButton>}
        </Row>
      )}
      <ErrorNote error={connect.error ?? disconnect.error ?? pair.error} />
      {waiting && link ? (
        <div className="pair-code">
          <span>Telegram should have opened. Tap <strong>Start</strong> in the chat with @{link.bot}. This page updates by itself.</span>
          <a className="inline-link" href={link.link} target="_blank" rel="noopener noreferrer">Didn't open? Open @{link.bot}</a>
          <em>Link works once, until {new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</em>
        </div>
      ) : null}
      {own && pair.data ? <div className="pair-code"><span>Send this to {pair.data.bot ? `@${pair.data.bot}` : "your bot"}:</span><code>/pair {pair.data.code}</code></div> : null}
      <Row label="Advanced" hint="Run your own bot, or point to a self-hosted relay.">
        <Toggle checked={advanced} onChange={setAdvanced} label="Show advanced" />
      </Row>
      {advanced ? (
        <>
          <Row label="Bot" hint={own ? "Using your own bot token." : "Using the Meadow bot."}>
            <select value={own ? "own" : "hosted"} onChange={event => patch({ telegram: { mode: event.target.value as "own" | "hosted" } })}>
              <option value="hosted">Meadow bot (one click)</option>
              <option value="own">My own bot (token from @BotFather)</option>
            </select>
          </Row>
          {own ? <SecretField name="TELEGRAM_BOT_TOKEN" present={hasOwnToken} label="Bot token" placeholder="123456:ABC… from @BotFather" /> : null}
          {!own ? (
            <Row label="Relay URL" hint="Leave empty to use the built-in Meadow bot. Must be HTTPS (or http://localhost).">
              <input className="text-input" placeholder="https://relay.example.com" defaultValue={config.telegram.relayUrl} onBlur={event => {
                const value = event.target.value.trim();
                if (value !== config.telegram.relayUrl) patch({ telegram: { relayUrl: value } });
              }} />
            </Row>
          ) : null}
        </>
      ) : null}
    </>
  );
}

