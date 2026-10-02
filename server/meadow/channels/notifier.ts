import { loadConfig } from "../config";
import { getDb } from "../core/db";
import { bus, type MeadowEvent } from "../core/events";
import { redact } from "../core/redact";
import { getProject } from "../projects";
import type { TelegramChannel } from "./telegram";
import type { InlineButton } from "./telegramApi";

type Outgoing = { text: string; buttons?: InlineButton[][]; photos?: Array<{ path: string; caption: string }>; urgent: boolean };

const URGENT = new Set(["phase_blocked", "approval_requested", "execution_finished"]);

export function inQuietHours(date = new Date()): boolean {
  const quiet = loadConfig().telegram.quietHours;
  if (!quiet.enabled) return false;
  const hour = date.getHours();
  return quiet.start > quiet.end ? hour >= quiet.start || hour < quiet.end : hour >= quiet.start && hour < quiet.end;
}

export function wantsEvent(event: MeadowEvent): boolean {
  const level = loadConfig().telegram.notificationLevel;
  if (["approval_requested", "phase_blocked"].includes(event.type)) return true;
  if (event.type === "execution_finished") return level !== "failures" || event.payload?.status !== "completed";
  if (level === "failures") return event.type === "error" && Boolean(event.executionId);
  if (level === "phases") return ["phase_passed", "plan_ready"].includes(event.type);
  return true;
}

/** Formats events into Telegram cards. Streams of small events collapse into one live-status message edited in place. */
export function formatEvent(event: MeadowEvent): Outgoing | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const pid = event.projectId ?? 0;
  switch (event.type) {
    case "phase_passed": {
      const checks = (p.checks as string[] | undefined) ?? [];
      const deps = (p.dependencyChanges as string[] | undefined) ?? [];
      const text = [
        event.title,
        `Checks: ${checks.map(check => `${check} ✓`).join(", ") || "none"}`,
        `Changed: ${p.files ?? 0} files (+${p.additions ?? 0} −${p.deletions ?? 0})`,
        `New dependencies: ${deps.length ? deps.join(", ") : "none"}`,
        "",
        event.detail.slice(0, 1200),
      ].join("\n");
      const photos = ((p.screenshotIds as number[] | undefined) ?? []).map(id => getDb().get<{ path: string; label: string }>("SELECT path, label FROM screenshots WHERE id = ?", id)).filter(Boolean).map(row => ({ path: row!.path, caption: `${event.title.split(":").pop()?.trim()} · ${row!.label}` }));
      const gate = loadConfig().harness.phaseGate === "ask";
      return { text, photos, urgent: false, buttons: [[...(gate ? [{ text: "Continue", callback_data: `continue:${pid}` }] : []), { text: "Retry", callback_data: `retry:${pid}` }, { text: "Pause", callback_data: `pause:${pid}` }, { text: "Add feature", callback_data: `addfeature:${pid}` }]] };
    }
    case "phase_blocked":
      return {
        text: `${event.title}\n${event.detail.slice(0, 1500)}`,
        urgent: true,
        buttons: [[{ text: "Retry with hint", callback_data: `retryhint:${pid}` }, { text: "Retry", callback_data: `retry:${pid}` }], [{ text: "Skip phase", callback_data: `skip:${pid}` }, { text: "Roll back", callback_data: `rollback:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]],
      };
    case "approval_requested": {
      const id = p.approvalId as number | undefined;
      if (p.budget) return { text: `⚠️ ${event.title}\n${event.detail}`, urgent: true, buttons: [[{ text: "Resume past cap", callback_data: `resume:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]] };
      if (!id) return null;
      const minutes = Math.round(Number(p.expiresInS ?? 0) / 60);
      return { text: `Approval needed (${p.risk ?? "medium"} risk): ${event.title}\n${event.detail}\n\nExpires in ${minutes} min and defaults to Deny.`, urgent: true, buttons: [[{ text: "Approve", callback_data: `approval:${id}:yes` }, { text: "Deny", callback_data: `approval:${id}:no` }]] };
    }
    case "execution_finished": {
      const status = p.status as string;
      if (status === "completed") return { text: `🎉 ${event.title}${pid ? ` for ${safeName(pid)}` : ""}. Every phase passed its checks. The code is on the main branch of the project folder.`, urgent: true, buttons: [[{ text: "Add feature", callback_data: `addfeature:${pid}` }]] };
      if (status === "failed") return { text: `Run failed: ${event.detail}`, urgent: true };
      return null;
    }
    case "plan_ready":
      return { text: `${event.title} (${event.detail}).`, urgent: false };
    default:
      return null;
  }
}

function safeName(projectId: number) {
  try {
    return getProject(projectId).name;
  } catch {
    return `project ${projectId}`;
  }
}

export class Notifier {
  private queue: Outgoing[] = [];
  private live = new Map<number, { messageId: number; lines: string[]; timer: NodeJS.Timeout | null }>();
  private unsubscribe: (() => void) | null = null;
  private quietTimer: NodeJS.Timeout | null = null;

  constructor(private channel: TelegramChannel) {}

  start() {
    this.unsubscribe = bus.onEvent(event => {
      if (!wantsEvent(event)) return;
      void this.dispatch(event).catch(error => console.warn("[meadow] notify failed", redact((error as Error).message)));
    });
    this.quietTimer = setInterval(() => void this.flushQuiet(), 60_000);
  }

  stop() {
    this.unsubscribe?.();
    if (this.quietTimer) clearInterval(this.quietTimer);
  }

  private async dispatch(event: MeadowEvent) {
    const chat = this.channel.ownerChat();
    if (!chat || !this.channel.api) return;
    const card = formatEvent(event);
    if (card) {
      if (!card.urgent && inQuietHours()) {
        this.queue.push(card);
        return;
      }
      await this.deliver(chat, card);
      if (event.type === "phase_passed" || event.type === "execution_finished") this.live.delete(event.projectId ?? 0);
      return;
    }
    if (loadConfig().telegram.notificationLevel === "all" && !inQuietHours()) this.batchLive(chat, event);
  }

  private async deliver(chat: number, card: Outgoing) {
    const api = this.channel.api!;
    await api.sendMessage(chat, redact(card.text), card.buttons);
    if (card.photos?.length) await api.sendPhotos(chat, card.photos).catch(error => console.warn("[meadow] photo send failed", (error as Error).message));
  }

  /** Collapse bursts into a single message per project, edited at most every few seconds. */
  private batchLive(chat: number, event: MeadowEvent) {
    const key = event.projectId ?? 0;
    const entry = this.live.get(key) ?? { messageId: 0, lines: [], timer: null };
    entry.lines.push(`${event.ts.slice(11, 19)} ${event.title}`);
    entry.lines = entry.lines.slice(-12);
    this.live.set(key, entry);
    if (entry.timer) return;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      const api = this.channel.api;
      if (!api) return;
      const text = redact(`Live status${key ? ` · ${safeName(key)}` : ""}\n${entry.lines.join("\n")}`);
      try {
        if (entry.messageId) await api.editMessage(chat, entry.messageId, text);
        else entry.messageId = (await api.sendMessage(chat, text)).message_id;
      } catch {
        entry.messageId = 0;
      }
    }, 3000);
  }

  private async flushQuiet() {
    if (inQuietHours() || !this.queue.length) return;
    const chat = this.channel.ownerChat();
    if (!chat || !this.channel.api) return;
    const pending = this.queue.splice(0);
    for (const card of pending) await this.deliver(chat, card).catch(() => undefined);
  }
}
