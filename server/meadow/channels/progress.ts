import type { MeadowEvent } from "../core/events";

export type Stage = "starting" | "engine" | "verifying" | "fixing" | "passed" | "blocked" | "paused" | "stopped";

export type PhaseProgress = {
  projectName: string;
  engine: string;
  phaseNumber: number;
  total: number;
  phaseName: string;
  stage: Stage;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  endedAt: number | null;
  files: number;
  checks: Array<{ label: string; passed: boolean }>;
  activity: string[];
};

const STAGE_LABEL: Record<Stage, string> = {
  starting: "⏳ Preparing the phase branch",
  engine: "🛠 Engine is working",
  verifying: "🧪 Running checks",
  fixing: "🔧 Fixing failed checks",
  passed: "✅ Phase passed",
  blocked: "⛔ Blocked, needs you",
  paused: "⏸ Paused",
  stopped: "⏹ Stopped",
};

const FINAL: Stage[] = ["passed", "blocked", "paused", "stopped"];
const ACTIVITY_LINES = 8;

export const isFinal = (stage: Stage) => FINAL.includes(stage);

export function localTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(11, 19) : date.toLocaleTimeString("en-GB", { hour12: false });
}

export function startProgress(event: MeadowEvent, info: { projectName: string; engine: string; maxAttempts: number }): PhaseProgress {
  const payload = (event.payload ?? {}) as { phaseNumber?: number; total?: number };
  return {
    projectName: info.projectName,
    engine: info.engine,
    phaseNumber: payload.phaseNumber ?? 1,
    total: payload.total ?? 1,
    phaseName: event.title.split(": ").slice(1).join(": ") || event.title,
    stage: "starting",
    attempt: 0,
    maxAttempts: info.maxAttempts,
    startedAt: Date.parse(event.ts) || Date.now(),
    endedAt: null,
    files: 0,
    checks: [],
    activity: [`${localTime(event.ts)} ▶️ ${event.detail || "Phase started"}`],
  };
}

/** Fold one harness event into the card. Returns false when the event changes nothing visible. */
export function applyEvent(progress: PhaseProgress, event: MeadowEvent): boolean {
  const at = localTime(event.ts);
  const note = (line: string) => {
    progress.activity.push(`${at} ${line}`);
    progress.activity = progress.activity.slice(-ACTIVITY_LINES);
  };
  const fromEngine = event.runId !== null;
  switch (event.type) {
    case "session_started":
      if (progress.stage !== "fixing") progress.stage = "engine";
      progress.attempt = Math.max(progress.attempt, 1);
      note(`🤖 ${event.title}`);
      return true;
    case "thinking":
      if (progress.stage === "starting") progress.stage = "engine";
      return false;
    case "message": {
      const fix = event.title.match(/fix attempt (\d+)/i);
      if (!fromEngine && fix) {
        progress.stage = "fixing";
        progress.attempt = Number(fix[1]);
        note(`🔁 ${event.title}`);
        return true;
      }
      note(`💬 ${event.title.slice(0, 140)}`);
      return true;
    }
    case "tool_call":
      note(`🔎 ${event.title.slice(0, 120)}`);
      return true;
    case "file_edit":
      progress.files += 1;
      note(`✏️ ${event.title.slice(0, 120)}`);
      return true;
    case "command_run":
      note(`$ ${event.title.slice(0, 120)}`);
      return true;
    case "check_result": {
      if (progress.stage !== "verifying") {
        progress.stage = "verifying";
        progress.checks = [];
      }
      const label = event.title.replace(/^[✓✗]\s*/, "");
      const passed = Boolean((event.payload as { passed?: boolean } | undefined)?.passed);
      progress.checks = [...progress.checks.filter(check => check.label !== label), { label, passed }];
      return true;
    }
    case "guard":
      note(`🛡 ${event.title}: ${event.detail.slice(0, 120)}`);
      return true;
    case "error":
      note(`⚠️ ${event.title.slice(0, 140)}`);
      return true;
    case "screenshot":
      note(`📸 ${event.title}`);
      return true;
    case "phase_passed":
      progress.stage = "passed";
      progress.endedAt = Date.parse(event.ts) || Date.now();
      return true;
    case "phase_blocked":
      progress.stage = "blocked";
      progress.endedAt = Date.parse(event.ts) || Date.now();
      note(`⛔ ${event.title}`);
      return true;
    case "control": {
      const status = (event.payload as { status?: string } | undefined)?.status;
      if (status === "paused" || status === "waiting") progress.stage = "paused";
      else if (status === "stopped") progress.stage = "stopped";
      else return false;
      progress.endedAt = Date.parse(event.ts) || Date.now();
      return true;
    }
    case "execution_finished":
      if (!isFinal(progress.stage)) {
        progress.stage = (event.payload as { status?: string } | undefined)?.status === "completed" ? "passed" : "stopped";
        progress.endedAt = Date.parse(event.ts) || Date.now();
      }
      return true;
    default:
      return false;
  }
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bar(done: number, total: number, width = 10) {
  const filled = total ? Math.round((done / total) * width) : 0;
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function renderProgress(progress: PhaseProgress, now = Date.now()): string {
  const done = progress.phaseNumber - 1 + (progress.stage === "passed" ? 1 : 0);
  const attempt = progress.attempt ? ` · attempt ${progress.attempt} of ${progress.maxAttempts}` : "";
  const lines = [
    `${isFinal(progress.stage) ? STAGE_LABEL[progress.stage].split(" ")[0] : "⚙️"} ${progress.projectName} · Phase ${progress.phaseNumber} of ${progress.total}`,
    progress.phaseName,
    `${bar(done, progress.total)} ${done} of ${progress.total} phases done`,
    "",
    `Now: ${STAGE_LABEL[progress.stage]}${isFinal(progress.stage) ? "" : attempt}`,
    `Engine: ${progress.engine}`,
    `Elapsed: ${duration((progress.endedAt ?? now) - progress.startedAt)}${progress.files ? ` · ${progress.files} file edit${progress.files === 1 ? "" : "s"}` : ""}`,
  ];
  if (progress.checks.length) lines.push("", "Checks", ...progress.checks.map(check => `${check.passed ? "✓" : "✗"} ${check.label}`));
  if (progress.activity.length) lines.push("", "Recent", ...progress.activity);
  return lines.join("\n");
}
