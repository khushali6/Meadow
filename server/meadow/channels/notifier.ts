import { loadConfig } from "../config";
import { getDb } from "../core/db";
import { bus, type MeadowEvent } from "../core/events";
import { redact } from "../core/redact";
import { getProject } from "../projects";
import { engineLabel } from "../engines/registry";
import { applyEvent, isFinal, renderProgress, startProgress, type PhaseProgress } from "./progress";
import { isTransient, type InlineButton, type TelegramApi } from "./telegramApi";

type Outgoing = { text: string; buttons?: InlineButton[][]; photos?: Array<{ path: string; caption: string }>; urgent: boolean; silent?: boolean };

export function inQuietHours(date = new Date()): boolean {
  const quiet = loadConfig().telegram.quietHours;
  if (!quiet.enabled) return false;
  const hour = date.getHours();
  return quiet.start > quiet.end ? hour >= quiet.start || hour < quiet.end : hour >= quiet.start && hour < quiet.end;
}

/** Event types that feed the live progress card. */
const PROGRESS_TYPES = new Set(["phase_started", "session_started", "thinking", "message", "tool_call", "file_edit", "command_run", "check_result", "guard", "error", "screenshot", "phase_passed", "phase_blocked", "control", "execution_finished"]);

export function wantsEvent(event: MeadowEvent): boolean {
  const level = loadConfig().telegram.notificationLevel;
  if (["approval_requested", "phase_blocked"].includes(event.type)) return true;
  if (event.type === "setup" && typeof event.payload?.service === "string") return true;
  if (event.type === "plan_ready" && event.payload?.status === "draft") return true;
  if (event.type === "execution_finished") return level !== "failures" || event.payload?.status !== "completed";
  if (level === "failures") return event.type === "error" && Boolean(event.executionId) && event.runId === null;
  if (level === "phases") return ["phase_started", "phase_passed", "plan_ready", "execution_started"].includes(event.type) || (event.type === "check_result" && Boolean(event.payload?.e2eCase)) || (event.type === "control" && ["paused", "waiting"].includes(String(event.payload?.status)));
  return true;
}

const isFixNotice = (event: MeadowEvent) => event.type === "message" && event.runId === null && /fix attempt/i.test(event.title);

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
      const photos = photosFor(p.screenshotIds, event.title.split(":").pop()?.trim() ?? "");
      const gate = loadConfig().harness.phaseGate === "ask";
      return { text, photos, urgent: false, buttons: [[...(gate ? [{ text: "Continue", callback_data: `continue:${pid}` }] : []), { text: "Retry", callback_data: `retry:${pid}` }, { text: "Pause", callback_data: `pause:${pid}` }, { text: "Add feature", callback_data: `addfeature:${pid}` }]] };
    }
    case "check_result": {
      if (!p.e2eCase) return null;
      const photos = photosFor(p.screenshotIds, `Test ${p.index}/${p.total}`);
      return { text: `✅ ${event.title}${event.detail ? `\n${event.detail}` : ""}`, photos, urgent: false, silent: true };
    }
    case "phase_blocked":
      return {
        text: `${event.title}\n${event.detail.slice(0, 1500)}`,
        photos: photosFor(p.screenshotIds, "Failing test"),
        urgent: true,
        buttons: [[{ text: "Retry with hint", callback_data: `retryhint:${pid}` }, { text: "Retry", callback_data: `retry:${pid}` }], [{ text: "Skip phase", callback_data: `skip:${pid}` }, { text: "Roll back", callback_data: `rollback:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]],
      };
    case "approval_requested": {
      const id = p.approvalId as number | undefined;
      if (p.budget) return { text: `⚠️ ${event.title}\n${event.detail}`, urgent: true, buttons: [[{ text: "Resume past cap", callback_data: `resume:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]] };
      if (!id) return null;
      const minutes = Math.round(Number(p.expiresInS ?? 0) / 60);
      if (p.question) {
        const options = ((p.options as string[] | undefined) ?? []).slice(0, 6);
        return {
          text: `❓ The coding engine${pid ? ` on ${safeName(pid)}` : ""} needs your decision:\n${event.title}${event.detail && !event.detail.startsWith("Options:") ? `\n\n${event.detail.replace(/\n*Options:.*$/s, "")}` : ""}\n\n${options.length ? "Tap an option or reply" : "Reply"} with your answer. If nobody answers within ${minutes} min, it picks the safest option and tells you which.`,
          urgent: true,
          buttons: [...options.map((option, index) => [{ text: option.slice(0, 60), callback_data: `reply:${id}:${index}` }]), [{ text: "Let it decide", callback_data: `approval:${id}:no` }]],
        };
      }
      if (p.remember) return { text: `Approval needed (${p.risk ?? "high"} risk): ${event.title}\n${event.detail}\n\nExpires in ${minutes} min and defaults to Deny.`, urgent: true, buttons: [[{ text: "Approve once", callback_data: `approval:${id}:yes` }, { text: "Deny", callback_data: `approval:${id}:no` }], [{ text: "Always allow this kind for this project", callback_data: `approval:${id}:always` }]] };
      return { text: `Approval needed (${p.risk ?? "medium"} risk): ${event.title}\n${event.detail}\n\nExpires in ${minutes} min and defaults to Deny.`, urgent: true, buttons: [[{ text: "Approve", callback_data: `approval:${id}:yes` }, { text: "Deny", callback_data: `approval:${id}:no` }]] };
    }
    case "execution_finished": {
      const status = p.status as string;
      if (status === "completed") {
        const photos = photosFor(p.screenshotIds, "Finished app");
        const folder = projectPath(pid);
        const e2e = p.e2e as { passed: number; total: number } | undefined;
        const lines = [
          `🎉 ${event.title}${pid ? ` for ${safeName(pid)}` : ""}. Every phase passed its checks. The code is on the main branch of ${folder ?? "the project folder"}.`,
          e2e ? `\n${e2e.passed}/${e2e.total} end-to-end test cases passed in a real browser. Each case's screenshots were sent above.` : "",
          p.runHow ? `\nRun it yourself:\n${folder ? `cd ${folder}\n` : ""}${p.runHow}` : "",
          photos.length ? `\nScreenshots of the running app (desktop and mobile) follow.` : "",
          event.detail ? `\n${event.detail}` : "",
        ];
        return { text: lines.filter(Boolean).join("\n"), photos, urgent: true, buttons: [[{ text: "Add feature", callback_data: `addfeature:${pid}` }, { text: "Screenshot again", callback_data: `shot:${pid}` }]] };
      }
      if (status === "failed") return { text: `Run failed: ${event.detail}`, urgent: true };
      return null;
    }
    case "plan_ready": {
      const planId = p.planId as number | undefined;
      if (p.status === "draft" && planId) {
        if (p.channel === "telegram") return null;
        return {
          text: `📝 ${event.title}${pid ? ` for ${safeName(pid)}` : ""}\n\n${event.detail.slice(0, 3000)}\n\nNothing runs until you approve.`,
          urgent: true,
          buttons: [[{ text: "Approve and start", callback_data: `approve:${planId}` }], [{ text: "Edit", callback_data: `edit:${planId}` }, { text: "Improve checks", callback_data: `improve:${planId}` }]],
        };
      }
      return { text: `${event.title} (${event.detail}).`, urgent: false };
    }
    case "execution_started":
      return { text: `🚀 ${event.title}${pid ? ` for ${safeName(pid)}` : ""}\n${event.detail}\n\nI'll post a live progress card for each phase and message you when checks pass, fail or need a decision.`, urgent: false, buttons: [[{ text: "Pause", callback_data: `pause:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]] };
    case "phase_started":
      return loadConfig().telegram.notificationLevel === "phases" ? { text: `▶️ ${event.title}`, urgent: false, silent: true } : null;
    case "message":
      return isFixNotice(event) ? { text: `🔁 ${event.title}\n${event.detail}`, urgent: false, silent: true } : null;
    case "setup": {
      const service = typeof p.service === "string" ? p.service : null;
      if (!service) return null;
      if (p.needsLogin) return { text: `🔌 ${event.title}\n${event.detail.slice(0, 800)}`, urgent: true, buttons: [[{ text: `Sign in to ${service}`, callback_data: `svclogin:${service}` }], ...(pid ? [[{ text: "Build without it", callback_data: `resume:${pid}` }]] : [])] };
      return { text: `${p.ok ? "✅" : "⚠️"} ${event.title}\n${event.detail.slice(0, 800)}`, urgent: !p.ok };
    }
    case "guard":
      return { text: `🛡 ${event.title}\n${event.detail.slice(0, 800)}`, urgent: false, silent: true };
    case "control": {
      const status = p.status as string | undefined;
      if (status === "paused" || status === "waiting") return { text: `⏸ ${event.title}${event.detail ? `\n${event.detail}` : ""}`, urgent: false, buttons: [[{ text: "Resume", callback_data: `resume:${pid}` }, { text: "Stop", callback_data: `stop:${pid}` }]] };
      return null;
    }
    case "error":
      return event.runId === null && event.executionId ? { text: `⚠️ ${event.title}\n${event.detail.slice(0, 800)}`, urgent: false, silent: true } : null;
    default:
      return null;
  }
}

function photosFor(ids: unknown, caption: string): Array<{ path: string; caption: string }> {
  return ((ids as number[] | undefined) ?? [])
    .map(id => getDb().get<{ path: string; label: string }>("SELECT path, label FROM screenshots WHERE id = ?", id))
    .filter((row): row is { path: string; label: string } => Boolean(row))
    .map(row => ({ path: row.path, caption: `${caption} · ${row.label}` }));
}

function projectPath(projectId: number): string | null {
  try {
    return getProject(projectId).path;
  } catch {
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

type Target = { ownerChat(): number | null; api: Pick<TelegramApi, "sendMessage" | "editMessage" | "sendPhotos"> | null };

type LiveCard = { progress: PhaseProgress; messageId: number; chain: Promise<void>; timer: NodeJS.Timeout | null; lastText: string; lastEdit: number };

const RENDER_DEBOUNCE_MS = 2500;
const OFFLINE_LIMIT = 100;
const HEARTBEAT_MS = 30_000;

export class Notifier {
  private queue: Outgoing[] = [];
  private offline: Outgoing[] = [];
  private outbox: Promise<void> = Promise.resolve();
  private cards = new Map<number, LiveCard>();
  private unsubscribe: (() => void) | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private channel: Target) {}

  start() {
    this.unsubscribe = bus.onEvent(event => {
      void this.dispatch(event).catch(error => console.warn("[meadow] notify failed", redact((error as Error).message)));
    });
    this.quietTimer = setInterval(() => void this.flushQuiet(), 60_000);
    this.heartbeat = setInterval(() => {
      this.beat();
      void this.flushOffline();
    }, HEARTBEAT_MS);
  }

  stop() {
    this.unsubscribe?.();
    if (this.quietTimer) clearInterval(this.quietTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const card of this.cards.values()) if (card.timer) clearTimeout(card.timer);
    this.cards.clear();
  }

  /** Resolves once every queued card render has been sent (used by tests and shutdown). */
  async idle() {
    await Promise.all([this.outbox, ...Array.from(this.cards.values()).map(card => card.chain)]);
  }

  async dispatch(event: MeadowEvent) {
    const chat = this.channel.ownerChat();
    if (!chat || !this.channel.api) return;
    if (loadConfig().telegram.notificationLevel === "all" && PROGRESS_TYPES.has(event.type)) this.track(chat, event);
    if (!wantsEvent(event)) return;
    const card = formatEvent(event);
    if (!card) return;
    if (!card.urgent && inQuietHours()) {
      this.queue.push(card);
      return;
    }
    await this.deliver(chat, card);
  }

  /**
   * Cards go out one at a time so a card's photos arrive before the next card. A card that still can't be sent
   * after the API's retries (Telegram or the network is down) waits in the offline queue, oldest dropped first.
   */
  private deliver(chat: number, card: Outgoing): Promise<void> {
    const send = async () => {
      const api = this.channel.api;
      if (!api) return;
      try {
        await api.sendMessage(chat, redact(card.text), card.buttons, { silent: card.silent });
      } catch (error) {
        if (!isTransient(error)) throw error;
        this.offline.push(card);
        if (this.offline.length > OFFLINE_LIMIT) this.offline.splice(0, this.offline.length - OFFLINE_LIMIT);
        return;
      }
      if (card.photos?.length) await api.sendPhotos(chat, card.photos).catch(error => console.warn("[meadow] photo send failed", (error as Error).message));
    };
    const next = this.outbox.then(send);
    this.outbox = next.catch(() => undefined);
    return next;
  }

  /** Re-sends cards queued while offline, in order, once Telegram answers again. */
  async flushOffline() {
    const chat = this.channel.ownerChat();
    if (!chat || !this.channel.api || !this.offline.length) return;
    const pending = this.offline.splice(0);
    for (const card of pending) await this.deliver(chat, card).catch(() => undefined);
  }

  offlineCount() {
    return this.offline.length;
  }

  /** One progress card per running phase, created on phase start and edited in place as events arrive. */
  private track(chat: number, event: MeadowEvent) {
    const key = event.projectId ?? 0;
    if (event.type === "phase_started") {
      const previous = this.cards.get(key);
      if (previous?.timer) clearTimeout(previous.timer);
      const card: LiveCard = { progress: startProgress(event, { projectName: safeName(key), engine: engineFor(event.executionId), maxAttempts: loadConfig().harness.maxAttempts }), messageId: 0, chain: Promise.resolve(), timer: null, lastText: "", lastEdit: 0 };
      this.cards.set(key, card);
      if (!inQuietHours()) this.render(chat, card);
      return;
    }
    const card = this.cards.get(key);
    if (!card || !applyEvent(card.progress, event)) return;
    if (inQuietHours()) return;
    if (isFinal(card.progress.stage)) {
      if (card.timer) clearTimeout(card.timer);
      card.timer = null;
      this.render(chat, card);
      this.cards.delete(key);
      return;
    }
    if (!card.timer) card.timer = setTimeout(() => {
      card.timer = null;
      this.render(chat, card);
    }, RENDER_DEBOUNCE_MS);
  }

  private render(chat: number, card: LiveCard) {
    card.chain = card.chain.then(async () => {
      const api = this.channel.api;
      if (!api) return;
      const text = redact(renderProgress(card.progress));
      if (text === card.lastText) return;
      try {
        if (card.messageId) await api.editMessage(chat, card.messageId, text);
        else card.messageId = (await api.sendMessage(chat, text, undefined, { silent: card.progress.stage !== "starting" })).message_id;
        card.lastText = text;
        card.lastEdit = Date.now();
      } catch (error) {
        console.warn("[meadow] progress card update failed", redact((error as Error).message));
        if (!isTransient(error) && /not found|can't be edited|message to edit/i.test((error as Error).message)) card.messageId = 0;
      }
    });
  }

  /** Keep elapsed time fresh while an engine step runs silently for a long time. */
  private beat() {
    const chat = this.channel.ownerChat();
    if (!chat || inQuietHours()) return;
    for (const card of this.cards.values()) {
      if (!isFinal(card.progress.stage) && !card.timer && Date.now() - card.lastEdit >= HEARTBEAT_MS - 1000) this.render(chat, card);
    }
  }

  private async flushQuiet() {
    if (inQuietHours() || !this.queue.length) return;
    const chat = this.channel.ownerChat();
    if (!chat || !this.channel.api) return;
    const pending = this.queue.splice(0);
    for (const card of pending) await this.deliver(chat, card).catch(() => undefined);
  }
}

function engineFor(executionId: number | null) {
  if (!executionId) return "engine";
  const row = getDb().get<{ engine: string }>("SELECT engine FROM executions WHERE id = ?", executionId);
  return row ? engineLabel(row.engine) : "engine";
}
