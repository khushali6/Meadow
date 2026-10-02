import { ChevronDown, ChevronUp, Compass, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc";
import { ErrorNote } from "./common";
import { MotionButton } from "./animation/motion";

/** Where the whole plan stands and what to do next, plus the brief every engine prompt receives. */
export function StatusPanel({ projectId, onNavigate, onAction }: { projectId: number; onNavigate: (path: string) => void; onAction: (action: "start" | "resume") => void }) {
  const utils = trpc.useUtils();
  const status = trpc.projectStatus.useQuery({ projectId }, { refetchInterval: 15_000 });
  const [focus, setFocus] = useState("");
  const [showBrief, setShowBrief] = useState(false);
  const planNext = trpc.planNext.useMutation({ onSuccess: () => { utils.projectStatus.invalidate(); utils.project.invalidate(); utils.planHistory.invalidate(); onNavigate("/plans"); } });
  const reembed = trpc.reembed.useMutation({ onSuccess: () => utils.projectStatus.invalidate() });
  if (!status.data) return null;
  const { brief, suggestions, canPlanNext, blocked } = status.data;
  const done = brief.counts.passed;

  const run = (action: string) => {
    if (action === "approve_plan") onNavigate("/plans");
    else if (action === "review_approvals") onNavigate("/approvals");
    else if (action === "describe") onNavigate("/request");
    else if (action === "reembed") reembed.mutate({ projectId });
    else if (action === "start" || action === "resume") onAction(action);
    else if (action === "plan_next") planNext.mutate({ projectId, request: focus.trim() || undefined });
  };

  return (
    <section className="status-panel" aria-label="Project status">
      <div className="status-panel-head">
        <div>
          <span className="panel-kicker"><Compass size={12} /> Project status · plan v{brief.planVersion ?? "—"}</span>
          <h2>{done}/{brief.counts.total} phases passed{blocked.length ? ` · ${blocked.length} blocked` : ""}{status.data.nextPhase ? ` · next: ${status.data.nextPhase.name}` : ""}</h2>
        </div>
        <button className="icon-button" onClick={() => setShowBrief(value => !value)} aria-expanded={showBrief} aria-label="Show the agent brief">{showBrief ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
      </div>
      <div className="status-roadmap" aria-label="Roadmap">
        {brief.roadmap.map(item => <span key={item.key} className={`roadmap-cell ${item.status}`} title={`${item.n}. ${item.name} — ${item.status}`} />)}
      </div>
      {suggestions.length ? (
        <div className="status-suggestions">
          {suggestions.map(item => (
            <div key={item.id} className="suggestion">
              <div><strong>{item.label}</strong><span>{item.detail}</span></div>
              {item.action === "retry" ? null : (
                <MotionButton className={`button ${item.action === "plan_next" ? "primary" : "secondary"}`} disabled={(item.action === "plan_next" && (!canPlanNext || planNext.isPending)) || (item.action === "reembed" && reembed.isPending)} onClick={() => run(item.action)}>
                  {item.action === "plan_next" ? (planNext.isPending ? <Loader2 size={14} className="spin-slow" /> : <Sparkles size={14} />) : null}
                  {item.action === "plan_next" ? (planNext.isPending ? "Planning…" : "Draft next phases") : "Go"}
                </MotionButton>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {suggestions.some(item => item.action === "plan_next") ? (
        <input className="hint-input" placeholder="Optional focus for the next phases, e.g. 'add auth and a settings page'" value={focus} onChange={event => setFocus(event.target.value)} maxLength={2000} />
      ) : null}
      {suggestions.some(item => item.action === "plan_next") && !canPlanNext ? <div className="fix-hint">Planning needs a configured agent model (Runtime settings → Agent model).</div> : null}
      <ErrorNote error={planNext.error ?? reembed.error} />
      {showBrief ? (
        <div className="status-brief">
          <span className="panel-kicker">Brief sent with every phase prompt (compressed to fit)</span>
          <pre>{status.data.briefText}</pre>
        </div>
      ) : null}
    </section>
  );
}
