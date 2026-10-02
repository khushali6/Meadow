import crypto from "node:crypto";
import path from "node:path";
import { getDb, now } from "./db";
import { redact } from "./redact";

/**
 * READ: no side effects. LOW_WRITE: reversible writes outside the code (notes, issues).
 * HIGH_WRITE: runs commands or changes code on a branch. DESTRUCTIVE: can lose work.
 */
export type RiskLevel = "READ" | "LOW_WRITE" | "HIGH_WRITE" | "DESTRUCTIVE";
export const RISK_LEVELS: RiskLevel[] = ["READ", "LOW_WRITE", "HIGH_WRITE", "DESTRUCTIVE"];

export type RiskPolicy = { approval: "none" | "medium" | "high"; allowFromMcp: boolean };
export const RISK_POLICY: Record<RiskLevel, RiskPolicy> = {
  READ: { approval: "none", allowFromMcp: true },
  LOW_WRITE: { approval: "medium", allowFromMcp: true },
  HIGH_WRITE: { approval: "high", allowFromMcp: true },
  DESTRUCTIVE: { approval: "high", allowFromMcp: false },
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}

/** A fingerprint of the arguments. The arguments themselves are never stored, so secrets in them can't leak through the log. */
export const argsHash = (args: unknown) => crypto.createHash("sha256").update(JSON.stringify(stable(args ?? {}))).digest("hex").slice(0, 16);

export type AuditEntry = {
  projectId: number | null;
  agent: string;
  user: string;
  tool: string;
  risk: RiskLevel;
  args: unknown;
  approval: "not_required" | "pending" | "approved" | "denied" | "expired" | "refused";
  result: "ok" | "error" | "pending" | "refused";
  durationMs: number;
  detail?: string;
};

export function audit(entry: AuditEntry): number {
  return getDb().insert("audit_log", {
    ts: now(),
    project_id: entry.projectId,
    agent: entry.agent.slice(0, 40),
    user: entry.user.slice(0, 40),
    tool: entry.tool.slice(0, 120),
    risk: entry.risk,
    args_hash: argsHash(entry.args),
    approval: entry.approval,
    result: entry.result,
    duration_ms: Math.max(0, Math.round(entry.durationMs)),
    detail: redact(entry.detail ?? "").slice(0, 300),
  });
}

export type AuditRow = { id: number; ts: string; project_id: number | null; agent: string; user: string; tool: string; risk: RiskLevel; args_hash: string; approval: string; result: string; duration_ms: number; detail: string };

export function auditLog(projectId: number | null, limit = 200): AuditRow[] {
  return projectId === null
    ? getDb().all<AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", limit)
    : getDb().all<AuditRow>("SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit);
}

/** Relative paths inside the project only: no absolute paths, no `..`, no NUL, no Meadow internals. */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  const normal = path.posix.normalize(value.replace(/\\/g, "/"));
  return !normal.startsWith("../") && normal !== ".." && !normal.startsWith(".meadow/") && !normal.startsWith(".git/") && !/(^|\/)\.env(\.|$)/.test(normal);
}
