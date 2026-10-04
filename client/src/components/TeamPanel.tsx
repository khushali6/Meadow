import { GitMerge } from "lucide-react";
import { useMemo } from "react";
import { relativeTime, StatusTag } from "./common";
import { AnimatePresence, motion, UI_EASE } from "./animation/motion";
import { ActivityDot } from "./animation/technical";
import { trpc } from "../lib/trpc";
import type { Event, Phase } from "../lib/types";

const ROLE_ORDER = ["backend", "ui", "qa", "builder"] as const;
const ROLE_COPY: Record<string, { label: string; owns: string }> = {
  backend: { label: "Backend agent", owns: "API, data, validation" },
  ui: { label: "UI agent", owns: "Screens, design system, motion" },
  qa: { label: "QA agent", owns: "Real user flows, browser tests" },
  builder: { label: "Builder agent", owns: "Everything else in the plan" },
};
const WORKING = new Set(["preparing", "running", "fixing", "verifying"]);

/** The supervisor and the specialist agents on this project, driven by the real phase state and supervisor events. */
export function TeamPanel({ phases, events, active }: { phases: Phase[]; events: Event[]; active: boolean }) {
  const status = trpc.teamStatus.useQuery(undefined, { refetchInterval: 30_000 });
  const notes = useMemo(() => events.filter(event => event.type === "supervisor"), [events]);
  const lanes = ROLE_ORDER.map(role => ({ role, phases: phases.filter(phase => (phase.agent ?? "builder") === role) })).filter(lane => lane.phases.length);
  const supervisor = status.data?.supervisor;
  const lastNote = notes[notes.length - 1];
  const escalations = notes.filter(note => note.payload?.action === "escalate").length;
  const parallelGroups = [...new Set(phases.map(phase => phase.parallelGroup).filter(Boolean))];
  const supervisorState = !supervisor ? "Checking…" : !supervisor.enabled ? "Off" : supervisor.reachable ? (supervisor.hasModel ? "Online" : "Model not pulled") : supervisor.fallback ? `Offline · using ${supervisor.fallback}` : "Offline";

  return (
    <section className="team-section" aria-label="Agent team">
      <div className="team-head">
        <div>
          <span className="panel-kicker">02 / Team</span>
          <h2>Specialists in the IDE, one supervisor reporting to you.</h2>
        </div>
        <div className="team-meta">
          <span>{status.data?.parallel.enabled ? `Up to ${status.data.parallel.maxAgents} agents at once` : "One agent at a time"}</span>
          {parallelGroups.length ? <span><GitMerge size={12} /> {parallelGroups.length} parallel group{parallelGroups.length === 1 ? "" : "s"}</span> : null}
        </div>
      </div>
      <div className="team-grid" style={{ gridTemplateColumns: `minmax(240px, 1.2fr) repeat(${lanes.length}, minmax(0, 1fr))` }}>
        <article className="team-lane supervisor">
          <header>
            <ActivityDot active={active && Boolean(supervisor?.reachable)} tone={supervisor?.enabled && !supervisor.reachable && !supervisor.fallback ? "error" : "idle"} />
            <div><strong>Supervisor</strong><span>{supervisor ? `${supervisor.provider} · ${supervisor.model}` : "…"}</span></div>
          </header>
          <dl className="team-stats">
            <div><dt>Status</dt><dd>{supervisorState}</dd></div>
            <div><dt>Diagnoses</dt><dd>{notes.length}</dd></div>
            <div><dt>Escalated</dt><dd>{escalations}</dd></div>
          </dl>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={lastNote?.id ?? "none"} className="team-note" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.28, ease: UI_EASE }}>
              {lastNote ? <>{lastNote.detail.split("\n")[0]} <time>{relativeTime(lastNote.ts)}</time></> : supervisor?.enabled ? "Reads every failed check, tells the fix agent what to change, and stops loops that need you." : "Turn the supervisor on in Settings to get diagnoses on failures."}
            </motion.p>
          </AnimatePresence>
          {supervisor?.enabled && !supervisor.reachable ? <p className="team-hint">Start Ollama and run <code>ollama pull {supervisor.model}</code>{supervisor.fallback ? `; until then ${supervisor.fallback} supervises.` : "."}</p> : null}
        </article>
        {lanes.map(lane => {
          const working = lane.phases.find(phase => WORKING.has(phase.status));
          const note = [...notes].reverse().find(event => (event.payload?.agent ?? "builder") === lane.role);
          const passed = lane.phases.filter(phase => phase.status === "passed").length;
          return (
            <article className={`team-lane ${working && active ? "working" : ""}`} key={lane.role}>
              <header>
                <ActivityDot active={Boolean(working && active)} tone={lane.phases.some(phase => phase.status === "blocked") ? "error" : "idle"} />
                <div><strong>{ROLE_COPY[lane.role].label}</strong><span>{ROLE_COPY[lane.role].owns}</span></div>
                <em>{passed}/{lane.phases.length}</em>
              </header>
              <ol className="team-phases">
                {lane.phases.map(phase => (
                  <li key={phase.id} className={phase.id === working?.id ? "current" : undefined}>
                    <span className="team-phase-index">{String(phases.indexOf(phase) + 1).padStart(2, "0")}</span>
                    <span className="team-phase-name">{phase.name}{phase.parallelGroup ? <small> · parallel</small> : null}</span>
                    <StatusTag status={phase.status} />
                  </li>
                ))}
              </ol>
              {note ? <p className="team-note small">Supervisor: {note.detail.split("\n")[0]}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
