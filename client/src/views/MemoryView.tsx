import { BookOpen, Plus, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote, PageHeader, relativeTime } from "../components/common";
import { trpc } from "../lib/trpc";
import type { ProjectSummary } from "../lib/types";

export function MemoryView({ project }: { project: ProjectSummary | undefined }) {
  const projectId = project?.id ?? null;
  const utils = trpc.useUtils();
  const notes = trpc.notes.useQuery({ projectId });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const addNote = trpc.addNote.useMutation({ onSuccess: () => { setTitle(""); setBody(""); utils.notes.invalidate(); } });
  const reindex = trpc.reindex.useMutation();
  const results = trpc.search.useQuery({ projectId: projectId ?? 0, query: submitted }, { enabled: Boolean(projectId && submitted) });

  return (
    <>
      <PageHeader
        eyebrow={project ? `05 / CONTEXT INDEX · ${project.name}` : "05 / CONTEXT INDEX"}
        title="Remember the context."
        description="Notes and project code are indexed locally so prompts get the right context. .env files, keys, and credentials are never indexed."
        action={project ? <button className="button secondary" disabled={reindex.isPending} onClick={() => reindex.mutate({ projectId: project.id })}><RefreshCw size={15} className={reindex.isPending ? "spin-slow" : undefined} /> {reindex.isPending ? "Indexing…" : "Re-index project"}</button> : undefined}
      />
      {reindex.data ? <div className="banner ok"><div><strong>Indexed {reindex.data.files} files into {reindex.data.chunks} chunks</strong><span>{reindex.data.embedded ? "Embeddings came from FreeLLMAPI." : "FreeLLMAPI embeddings were unavailable, so search uses keyword matching."}</span></div></div> : null}
      <ErrorNote error={reindex.error ?? addNote.error ?? results.error} />
      <div className="memory-layout">
        <section className="panel">
          <div className="panel-heading"><div><span className="panel-kicker">Search</span><h2>Ask the index</h2></div></div>
          <form className="search-row" onSubmit={event => { event.preventDefault(); setSubmitted(query.trim()); }}>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={project ? "e.g. where is the cart total computed" : "Pick a project first"} disabled={!project} />
            <button className="button secondary" disabled={!project || !query.trim()}><Search size={14} /> Search</button>
          </form>
          <div className="search-results">
            {results.data?.map((hit, i) => <div className="memory-card" key={i}><div className="memory-card-head"><strong>{hit.path}</strong><span className="evidence-chip">{hit.source} · {hit.score.toFixed(2)}</span></div><pre>{hit.text.slice(0, 600)}</pre></div>)}
            {results.data?.length === 0 ? <div className="event-empty">No matches. Try re-indexing the project.</div> : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><span className="panel-kicker">Notes</span><h2>Remember this</h2></div></div>
          <form className="note-form" onSubmit={event => { event.preventDefault(); addNote.mutate({ projectId, title, body }); }}>
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Title, e.g. Use pnpm, not npm" />
            <textarea rows={3} value={body} onChange={event => setBody(event.target.value)} placeholder="Details the engine should know" />
            <button className="button primary" disabled={!title.trim() || !body.trim() || addNote.isPending}><Plus size={14} /> Save note</button>
          </form>
          {notes.data?.length === 0 ? <EmptyState icon={BookOpen} title="No notes yet" body="Notes you save here or with /remember in Telegram are added to future prompts." /> : null}
          <div className="note-list">
            {notes.data?.map(note => <div className="memory-card" key={note.id}><div className="memory-card-head"><strong>{note.title}</strong><span>{note.project_id ? "project" : "global"} · {note.source} · {relativeTime(note.created_at)}</span></div><p>{note.body}</p></div>)}
          </div>
        </section>
      </div>
    </>
  );
}
