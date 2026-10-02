import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { homePath } from "../config";
import { getDb, now } from "./db";
import { redact } from "./redact";

export const EVENT_TYPES = [
  "session_started", "thinking", "message", "tool_call", "file_edit", "command_run", "usage", "error", "done",
  "phase_started", "check_result", "phase_passed", "phase_blocked", "approval_requested", "approval_decided",
  "screenshot", "execution_started", "execution_finished", "plan_ready", "control", "guard",
  "atlas_trace", "atlas_ingest",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type MeadowEvent = {
  id: number;
  projectId: number | null;
  executionId: number | null;
  runId: number | null;
  phaseId: number | null;
  ts: string;
  type: EventType;
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
};

export type EventInput = Omit<MeadowEvent, "id" | "ts" | "projectId" | "executionId" | "runId" | "phaseId"> & {
  projectId?: number | null;
  executionId?: number | null;
  runId?: number | null;
  phaseId?: number | null;
};

type EventRow = { id: number; project_id: number | null; execution_id: number | null; run_id: number | null; phase_id: number | null; ts: string; type: EventType; title: string; detail: string; payload_json: string | null };

export const rowToEvent = (row: EventRow): MeadowEvent => ({
  id: row.id,
  projectId: row.project_id,
  executionId: row.execution_id,
  runId: row.run_id,
  phaseId: row.phase_id,
  ts: row.ts,
  type: row.type,
  title: row.title,
  detail: row.detail,
  payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
});

class EventBus extends EventEmitter {
  emitEvent(input: EventInput): MeadowEvent {
    const ts = now();
    const title = redact(input.title).slice(0, 300);
    const detail = redact(input.detail ?? "").slice(0, 4000);
    const payload = input.payload ? JSON.parse(redact(JSON.stringify(input.payload))) : undefined;
    const id = getDb().insert("events", {
      project_id: input.projectId ?? null,
      execution_id: input.executionId ?? null,
      run_id: input.runId ?? null,
      phase_id: input.phaseId ?? null,
      ts,
      type: input.type,
      title,
      detail,
      payload_json: payload ? JSON.stringify(payload) : null,
    });
    const event: MeadowEvent = { id, ts, type: input.type, title, detail, payload, projectId: input.projectId ?? null, executionId: input.executionId ?? null, runId: input.runId ?? null, phaseId: input.phaseId ?? null };
    appendJsonl(event);
    this.emit("event", event);
    return event;
  }

  onEvent(listener: (event: MeadowEvent) => void) {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

function appendJsonl(event: MeadowEvent) {
  if (process.env.MEADOW_NO_JSONL) return;
  try {
    const file = homePath("logs", "events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // JSONL is a secondary log; the database is the source of truth.
  }
}

export const bus = new EventBus();
bus.setMaxListeners(50);

/**
 * The MCP server runs in its own process and writes events straight to the database.
 * The daemon replays those rows on its bus so the dashboard stream and Telegram see them.
 */
export function startForeignEventRelay(intervalMs = 1500): () => void {
  const local = new Set<number>();
  const track = bus.onEvent(event => {
    local.add(event.id);
    if (local.size > 5000) local.delete(local.values().next().value!);
  });
  let last = getDb().get<{ id: number | null }>("SELECT MAX(id) id FROM events")?.id ?? 0;
  const timer = setInterval(() => {
    try {
      for (const event of eventsAfter(last, undefined, 500)) {
        last = Math.max(last, event.id);
        if (!local.has(event.id)) bus.emit("event", event);
      }
    } catch {
      // The database may be briefly locked by the other process; try again next tick.
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    track();
  };
}

export function eventsAfter(afterId: number, projectId?: number, limit = 500): MeadowEvent[] {
  const rows = projectId
    ? getDb().all<EventRow>("SELECT * FROM events WHERE id > ? AND project_id = ? ORDER BY id LIMIT ?", afterId, projectId, limit)
    : getDb().all<EventRow>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?", afterId, limit);
  return rows.map(rowToEvent);
}

export function recentEvents(projectId: number, limit = 300): MeadowEvent[] {
  return getDb().all<EventRow>("SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit).reverse().map(rowToEvent);
}
