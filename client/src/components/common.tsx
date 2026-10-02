import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, CircleDot, Clock3, Loader2, PauseCircle, SkipForward, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { motion, SwapText } from "./animation/motion";

export const relativeTime = (date: string | null | undefined) => {
  if (!date) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const clockTime = (date: string) => new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

const STATUS: Record<string, { label: string; tone: string; icon: LucideIcon }> = {
  passed: { label: "Passed", tone: "passed", icon: CheckCircle2 },
  completed: { label: "Completed", tone: "passed", icon: CheckCircle2 },
  ready: { label: "Ready", tone: "passed", icon: CheckCircle2 },
  running: { label: "Running", tone: "running", icon: Loader2 },
  preparing: { label: "Preparing", tone: "running", icon: Loader2 },
  verifying: { label: "Verifying", tone: "running", icon: Loader2 },
  fixing: { label: "Fixing", tone: "running", icon: Loader2 },
  pending: { label: "Queued", tone: "queued", icon: Clock3 },
  draft: { label: "Plan draft", tone: "queued", icon: Clock3 },
  new: { label: "New", tone: "queued", icon: CircleDot },
  waiting: { label: "Waiting", tone: "paused", icon: PauseCircle },
  paused: { label: "Paused", tone: "paused", icon: PauseCircle },
  interrupted: { label: "Interrupted", tone: "paused", icon: AlertTriangle },
  blocked: { label: "Blocked", tone: "blocked", icon: XCircle },
  stopped: { label: "Stopped", tone: "stopped", icon: XCircle },
  failed: { label: "Failed", tone: "blocked", icon: XCircle },
  skipped: { label: "Skipped", tone: "queued", icon: SkipForward },
};

/** Status is always icon plus text, never colour alone. */
export function StatusTag({ status }: { status: string }) {
  const info = STATUS[status] ?? { label: status, tone: "queued", icon: CircleDot };
  const Icon = info.icon;
  return (
    <span className={`status-tag ${info.tone}`}>
      <Icon size={12} aria-hidden className={info.tone === "running" ? "spin-slow" : undefined} />
      <SwapText value={info.label} />
    </span>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon size={22} />
      <strong>{title}</strong>
      <span>{body}</span>
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked} aria-label={label}>
      <motion.span layout transition={{ type: "spring", stiffness: 600, damping: 36 }} />
    </button>
  );
}

export function Metric({ icon: Icon, label, value, trend }: { icon: LucideIcon; label: string; value: string | number; trend: string }) {
  return (
    <div className="metric-card">
      <div className="metric-icon"><Icon size={16} /></div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{trend}</small>
    </div>
  );
}

export function ErrorNote({ error }: { error: { message: string } | null | undefined }) {
  if (!error) return null;
  return <div className="inline-error" role="alert"><AlertTriangle size={14} /> {error.message}</div>;
}
