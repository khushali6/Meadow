import { Bot, FolderGit2, FolderKanban, Leaf, Plus, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote, PageHeader, StatusTag, relativeTime } from "../components/common";
import { trpc } from "../lib/trpc";
import type { ProjectSummary, Settings } from "../lib/types";
import { MotionButton, MotionDialog } from "../components/animation/motion";

/** The plan goal, else the description unless it is pasted plan YAML. */
function cardDescription(project: ProjectSummary): string {
  if (project.goal) return project.goal;
  const text = project.description?.trim() ?? "";
  return text && !/^(-\s*)?(id|name|project|phases|tasks|depends_on):/m.test(text) ? text : "No plan goal yet";
}

export function ProjectsView({ projects, settings, activeId, onOpen }: { projects: ProjectSummary[]; settings: Settings | undefined; activeId: number | null; onOpen: (id: number, path?: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader eyebrow="02 / WORKSPACES" title="Workspaces." description="Each project is a plain git repository inside your projects folder. Meadow never writes outside it." action={<MotionButton className="button primary" onClick={() => setCreating(true)}><Plus size={15} /> New project</MotionButton>} />
      {projects.length === 0 ? <EmptyState icon={FolderKanban} title="No projects yet" body="Create one here, send a request from the Request page, or message your Telegram bot." action={<MotionButton className="button primary" onClick={() => setCreating(true)}>Create a project</MotionButton>} /> : null}
      <div className="project-grid">
        {projects.map(project => (
          <button className={`project-card ${project.id === activeId ? "active" : ""}`} key={project.id} onClick={() => onOpen(project.id, "/")}>
            <div className="project-card-top"><div className="project-symbol"><Leaf size={20} /></div><StatusTag status={project.status} /></div>
            <div className="project-name">{project.name}</div>
            <p>{cardDescription(project)}</p>
            <div className="project-meta"><span title={project.path}><FolderGit2 size={13} /> {project.path.replace(/^\/Users\/[^/]+/, "~")}</span><span><Bot size={13} /> {project.engine}</span></div>
            <div className="project-card-divider" />
            <div className="project-card-footer"><span>{project.phaseCount ? `${project.passed}/${project.phaseCount} phases passed` : "No approved plan"}</span><span>{relativeTime(project.updated_at)}</span></div>
            <div className="mini-progress"><span style={{ width: `${project.phaseCount ? (project.passed / project.phaseCount) * 100 : 0}%` }} /></div>
          </button>
        ))}
        {projects.length ? <button className="new-project-card" onClick={() => setCreating(true)}><div className="new-project-icon"><Plus size={18} /></div><strong>Start another project</strong><span>A new git repository in your projects folder.</span></button> : null}
      </div>
      <MotionDialog open={creating} onClose={() => setCreating(false)} labelledBy="new-project-title">
        <NewProjectDialog settings={settings} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); onOpen(id, "/plans"); }} />
      </MotionDialog>
    </>
  );
}

function NewProjectDialog({ settings, onClose, onCreated }: { settings: Settings | undefined; onClose: () => void; onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [engine, setEngine] = useState(settings?.config.engine.default ?? "cursor");
  const create = trpc.createProject.useMutation({ onSuccess: project => { utils.overview.invalidate(); onCreated(project.id); } });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
      <form className="dialog" onSubmit={event => { event.preventDefault(); create.mutate({ name: slug, engine, description: description || undefined }); }}>
        <div className="dialog-head"><div><span className="eyebrow">New local project</span><h2 id="new-project-title">Give the work a home.</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <label><span>Name</span><input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="habit-tracker" /><small>Folder: {settings?.config.projectsDir}/{slug || "…"}</small></label>
        <label><span>Description (optional)</span><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
        <label><span>Engine</span><select value={engine} onChange={event => setEngine(event.target.value as typeof engine)}>{settings?.engines.map(item => <option key={item.name} value={item.name} disabled={item.status !== "available"}>{item.label}{item.status === "coming_soon" ? " — coming soon" : ""}</option>)}</select></label>
        <ErrorNote error={create.error} />
        <div className="dialog-foot"><span><ShieldCheck size={14} /> Stays on this machine</span><div><MotionButton type="button" className="button secondary" onClick={onClose}>Cancel</MotionButton><MotionButton className="button primary" disabled={slug.length < 2 || create.isPending}>{create.isPending ? "Creating…" : "Create project"}</MotionButton></div></div>
      </form>
  );
}
