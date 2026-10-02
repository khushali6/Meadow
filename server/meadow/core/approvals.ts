import { loadConfig } from "../config";
import { getDb, now } from "./db";
import { bus } from "./events";

export type ApprovalRow = { id: number; project_id: number | null; run_id: number | null; kind: string; title: string; detail: string; risk: string; status: "pending" | "approved" | "denied" | "expired"; requested_at: string; expires_at: string; decided_at: string | null; decided_by: string | null };

const waiters = new Map<number, (approved: boolean) => void>();
const timers = new Map<number, NodeJS.Timeout>();

/** Ask the owner to approve a risky action. Resolves false on deny or expiry (expiry always means deny). */
export function requestApproval(input: { projectId: number | null; runId?: number | null; kind: string; title: string; detail: string; risk?: "medium" | "high"; expiryS?: number }): { id: number; decision: Promise<boolean> } {
  const expiryS = input.expiryS ?? loadConfig().approvals.expiryS;
  const id = getDb().insert("approvals", {
    project_id: input.projectId,
    run_id: input.runId ?? null,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    risk: input.risk ?? "medium",
    status: "pending",
    requested_at: now(),
    expires_at: new Date(Date.now() + expiryS * 1000).toISOString(),
  });
  const decision = new Promise<boolean>(resolve => waiters.set(id, resolve));
  timers.set(id, setTimeout(() => decide(id, "expired", "timeout"), expiryS * 1000));
  bus.emitEvent({ type: "approval_requested", projectId: input.projectId, runId: input.runId ?? null, title: input.title, detail: input.detail, payload: { approvalId: id, risk: input.risk ?? "medium", expiresInS: expiryS } });
  return { id, decision };
}

export function decide(id: number, status: "approved" | "denied" | "expired", by: string): ApprovalRow {
  const row = getDb().get<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id);
  if (!row) throw new Error("Approval not found");
  if (row.status !== "pending") return row;
  getDb().update("approvals", id, { status, decided_at: now(), decided_by: by });
  clearTimeout(timers.get(id));
  timers.delete(id);
  waiters.get(id)?.(status === "approved");
  waiters.delete(id);
  bus.emitEvent({ type: "approval_decided", projectId: row.project_id, runId: row.run_id, title: `${row.title}: ${status}`, detail: `Decided by ${by}`, payload: { approvalId: id, status } });
  return { ...row, status };
}

/** Approvals left pending by a previous daemon process can no longer be honoured; expire them. */
export function expireOrphanedApprovals() {
  getDb().run("UPDATE approvals SET status = 'expired', decided_at = ?, decided_by = 'restart' WHERE status = 'pending'", now());
}

export function listApprovals(limit = 100): ApprovalRow[] {
  return getDb().all<ApprovalRow>("SELECT * FROM approvals ORDER BY id DESC LIMIT ?", limit);
}
