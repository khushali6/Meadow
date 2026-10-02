import { Bug, CheckCircle2, Copy, Database, FlaskConical, GitBranch, Network, Play, Plug, Radar, RefreshCw, Sparkles, Wrench } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, MotionButton, UI_EASE } from "../components/animation/motion";
import { ActivityDot, ExecutionPipeline, useStaggerNewRows } from "../components/animation/technical";
import { EmptyState, ErrorNote, PageHeader, relativeTime, StatusTag } from "../components/common";
import { trpc } from "../lib/trpc";
import type { AtlasInvestigation, ProjectSummary } from "../lib/types";

export const ATLAS_HIGHLIGHT_KEY = "meadow.atlas.highlight";

const MODES = [
  { key: "agentic", label: "Agentic", hint: "Planner, researcher, architect, operator, writer and verifier" },
  { key: "hybrid", label: "Hybrid", hint: "Vector + BM25 + symbol + graph, fused" },
  { key: "graph", label: "Graph", hint: "Knowledge graph traversal only" },
  { key: "vector", label: "Vector", hint: "Embedding similarity only (baseline)" },
] as const;
type Mode = (typeof MODES)[number]["key"];

const AGENTS = [
  { key: "supervisor", label: "Supervisor", detail: "Plan" },
  { key: "researcher", label: "Researcher", detail: "Retrieve" },
  { key: "architect", label: "Architect", detail: "Graph + diffs" },
  { key: "operator", label: "Operator", detail: "Tools" },
  { key: "writer", label: "Writer", detail: "Cited answer" },
  { key: "verifier", label: "Verifier", detail: "Check claims" },
];

const EXAMPLES = [
  "Why did payment-service start timing out after release v2.4.0?",
  "Which services depend on payment-service?",
  "What changed between v2.3.0 and v2.4.0?",
  "Who owns the ledger service?",
  "Where is withRetry implemented and what calls it?",
];

/** Renders the writer's markdown subset: paragraphs, bullets, **bold**, `code` and [n] citations. */
function RichText({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  const inline = (line: string, key: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\](?:\[\d+\])*)/g).filter(Boolean).map((part, i) => {
      if (part.startsWith("**")) return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`")) return <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>;
      if (/^\[\d+\]/.test(part)) return <Fragment key={`${key}-${i}`}>{Array.from(part.matchAll(/\[(\d+)\]/g)).map(match => <button type="button" key={match[1]} className="cite-chip" onClick={() => onCite(Number(match[1]))}>{match[1]}</button>)}</Fragment>;
      return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
    });
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(line)) list.push(<li key={i}>{inline(line.replace(/^\s*[-*•]\s+/, ""), `l${i}`)}</li>);
    else {
      flush();
      if (/^#{1,4}\s/.test(line)) blocks.push(<h4 key={i}>{inline(line.replace(/^#+\s/, ""), `h${i}`)}</h4>);
      else if (line.trim()) blocks.push(<p key={i}>{inline(line, `p${i}`)}</p>);
    }
  });
  flush();
  return <div className="atlas-answer-body">{blocks}</div>;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function IndexStrip({ projectId, onNavigate }: { projectId: number; onNavigate: (path: string) => void }) {
  const utils = trpc.useUtils();
  const status = trpc.atlas.status.useQuery({ projectId }, { refetchInterval: query => (query.state.data?.ingesting ? 1500 : false) });
  const ingest = trpc.atlas.ingest.useMutation({ onSuccess: () => utils.atlas.status.invalidate() });
  const graph = status.data?.graph;
  const count = (kind: string) => graph?.nodes[kind] ?? 0;
  const busy = status.data?.ingesting || ingest.isPending;
  const cells = [
    ["Services", count("service")],
    ["Functions", count("function")],
    ["APIs", count("api")],
    ["Tables", count("table")],
    ["Commits", count("commit")],
    ["PRs", count("pr")],
    ["Releases", count("release")],
    ["Incidents", count("incident")],
    ["Edges", graph?.edges ?? 0],
  ] as const;
  return (
    <section className="panel atlas-index">
      <div className="panel-heading">
        <div><span className="panel-kicker">01 / Knowledge graph</span><h2>{graph?.lastIngest ? `Indexed ${relativeTime(graph.lastIngest.at)}` : "Not indexed yet"}</h2></div>
        <div className="atlas-index-actions">
          <ActivityDot active={Boolean(busy)} tone={busy ? "amber" : "idle"} />
          <span className="atlas-meta">{status.data ? `${status.data.llm.available ? "FreeLLMAPI on" : "rule-based (no LLM)"} · ${graph?.embedded ? "gateway vectors" : "local hashed vectors"}` : "…"}</span>
          <MotionButton className="button secondary" onClick={() => onNavigate("/map")}><Network size={14} /> System map</MotionButton>
          <MotionButton className="button primary" disabled={busy} onClick={() => ingest.mutate({ projectId })}><RefreshCw size={14} className={busy ? "spin-slow" : undefined} /> {busy ? "Indexing…" : graph?.lastIngest ? "Re-index" : "Build graph"}</MotionButton>
        </div>
      </div>
      <div className="atlas-counts">
        {cells.map(([label, value]) => <div key={label}><strong>{value.toLocaleString()}</strong><span>{label}</span></div>)}
      </div>
      <ErrorNote error={ingest.error ?? status.error} />
    </section>
  );
}

function TracePanel({ result, running }: { result: AtlasInvestigation; running: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  useStaggerNewRows(listRef, result.trace.map(step => step.id));
  const lastAgent = result.trace.length ? result.trace[result.trace.length - 1].agent : null;
  const current = running ? Math.max(0, AGENTS.findIndex(agent => agent.key === lastAgent)) : AGENTS.length - 1;
  return (
    <section className="panel atlas-trace">
      <div className="panel-heading"><div><span className="panel-kicker">03 / Agent trace</span><h2>{running ? "Investigating…" : result.status === "failed" ? "Investigation failed" : `Done in ${result.ms ?? 0}ms`}</h2></div><StatusTag status={running ? "running" : result.status === "failed" ? "blocked" : "passed"} /></div>
      <div className="atlas-pipeline"><ExecutionPipeline stages={AGENTS} current={current} state={running ? "active" : result.status === "failed" ? "blocked" : "done"} /></div>
      <ol className="atlas-trace-list" ref={listRef}>
        {result.trace.map(step => (
          <li key={step.id} data-row-id={step.id}>
            <span className="atlas-trace-agent">{step.agent}</span>
            <div><strong>{step.step}</strong><span>{step.detail}</span></div>
          </li>
        ))}
        {running && !result.trace.length ? <li className="event-empty">Waiting for the supervisor…</li> : null}
      </ol>
    </section>
  );
}

function ResultPanels({ result, projectId, onNavigate }: { result: AtlasInvestigation; projectId: number; onNavigate: (path: string) => void }) {
  const utils = trpc.useUtils();
  const [cited, setCited] = useState<number | null>(null);
  const runAction = trpc.atlas.runAction.useMutation({
    onSuccess: data => {
      toast.success(data.pending ? "Waiting for your approval" : "Done", { description: data.summary });
      utils.atlas.actions.invalidate();
      utils.overview.invalidate();
    },
  });
  const cite = (n: number) => {
    setCited(n);
    document.getElementById(`evidence-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const showOnMap = () => {
    sessionStorage.setItem(ATLAS_HIGHLIGHT_KEY, JSON.stringify({ id: result.id, nodes: result.highlight.nodes, edges: result.highlight.edges, question: result.question }));
    onNavigate("/map");
  };
  const v = result.verifier;
  return (
    <>
      <section className="panel atlas-answer">
        <div className="panel-heading">
          <div><span className="panel-kicker">04 / Answer · {result.writer === "llm" ? "FreeLLMAPI writer" : "rule-based writer"} · {result.classification?.type ?? "query"}</span><h2>{result.question}</h2></div>
          {v ? <div className={`verifier-badge ${v.supported === v.total ? "ok" : "warn"}`}><CheckCircle2 size={14} /> {v.supported}/{v.total} claims verified</div> : null}
        </div>
        <RichText text={result.answer || result.error || ""} onCite={cite} />
        {v ? (
          <div className="atlas-scores">
            <div><span>Faithfulness</span><strong>{pct(v.faithfulness)}</strong></div>
            <div><span>Citation accuracy</span><strong>{pct(v.citationAccuracy)}</strong></div>
            <div><span>Re-retrieved</span><strong>{v.reretrieved}</strong></div>
            <div><span>Context</span><strong>{result.usage?.contextTokens?.toLocaleString() ?? 0} tok</strong></div>
            <div><span>LLM calls</span><strong>{result.usage?.calls ?? 0}</strong></div>
          </div>
        ) : null}
        {result.actions?.length ? (
          <div className="atlas-actions">
            {result.actions.map(action => (
              <MotionButton key={action.tool} className={`button ${action.tool === "propose_patch" ? "primary" : "secondary"}`} disabled={runAction.isPending} onClick={() => runAction.mutate({ projectId, investigationId: result.id, tool: action.tool, args: action.args })}>
                {action.tool === "propose_patch" ? <Wrench size={14} /> : <Bug size={14} />} {action.label}
              </MotionButton>
            ))}
            {result.highlight?.nodes.length ? <MotionButton className="button secondary" onClick={showOnMap}><Network size={14} /> Show on map</MotionButton> : null}
            <span className="atlas-meta">Write actions need your approval in Approvals or Telegram.</span>
          </div>
        ) : null}
        <ErrorNote error={runAction.error} />
      </section>

      {result.suspects?.length ? (
        <section className="panel">
          <div className="panel-heading"><div><span className="panel-kicker">Root cause candidates</span><h2>Suspects, ranked</h2></div></div>
          <div className="atlas-suspects">
            {result.suspects.map((suspect, i) => (
              <div key={suspect.key} className={`atlas-suspect ${i === 0 ? "top" : ""}`}>
                <div className="atlas-suspect-head"><span className="atlas-rank">{String(i + 1).padStart(2, "0")}</span><strong>{suspect.title}</strong><span className="evidence-chip">score {suspect.score.toFixed(1)}</span></div>
                {suspect.highlights.length ? <pre>{suspect.highlights.join("\n").replace(/`/g, "")}</pre> : null}
                <ul>{suspect.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
                {suspect.files.length ? <div className="atlas-files">{suspect.files.map(file => <code key={file}>{file}</code>)}</div> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {result.findings?.length ? (
        <section className="panel">
          <div className="panel-heading"><div><span className="panel-kicker">Graph evidence</span><h2>How these facts connect</h2></div></div>
          <div className="atlas-findings">
            {result.findings.map(finding => (
              <div key={finding.label + finding.text}>
                <span className="atlas-meta">{finding.label}</span>
                <div className="atlas-path">{finding.path.map((step, i) => <Fragment key={`${step.nodeId}-${i}`}>{step.via ? <span className="atlas-via">─{step.via}→</span> : null}<span className={`atlas-node-pill kind-${step.kind}`}>{step.name}</span></Fragment>)}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-heading"><div><span className="panel-kicker">Evidence · {result.evidence?.length ?? 0} sources</span><h2>What the answer is based on</h2></div></div>
        <div className="atlas-evidence">
          {result.evidence?.map(item => (
            <div key={item.n} id={`evidence-${item.n}`} className={`atlas-evidence-item ${cited === item.n ? "cited" : ""}`}>
              <div className="atlas-evidence-head"><span className="cite-chip static">{item.n}</span><strong>{item.title}</strong><span className="atlas-meta">{item.kind}{item.path ? ` · ${item.path}` : ""} · {item.sources.join("+")}</span></div>
              {item.facts.length ? <div className="atlas-facts">{item.facts.slice(0, 4).map(fact => <code key={fact}>{fact}</code>)}</div> : null}
              <pre>{item.snippet}</pre>
            </div>
          ))}
        </div>
      </section>

      {result.claims?.length ? (
        <section className="panel">
          <div className="panel-heading"><div><span className="panel-kicker">Verifier</span><h2>Claim by claim</h2></div></div>
          <ol className="atlas-claims">
            {result.claims.map((claim, i) => (
              <li key={i} className={claim.supported ? "ok" : "warn"}>
                <span className="status-tag"><span />{claim.supported ? `supported ${pct(claim.support)}` : "unverified"}</span>
                <div><p>{claim.text}</p>{claim.path ? <code>{claim.path}</code> : null}<span className="atlas-meta">{claim.method}{claim.reretrieved ? " · re-retrieved" : ""}{claim.citations.length ? ` · cites ${claim.citations.map(n => `[${n}]`).join("")}` : ""}</span></div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function Benchmark({ projectId }: { projectId: number }) {
  const utils = trpc.useUtils();
  const status = trpc.atlas.status.useQuery({ projectId });
  const evaluate = trpc.atlas.evaluate.useMutation({ onSuccess: () => utils.atlas.status.invalidate() });
  const report = evaluate.data ?? status.data?.lastEval ?? null;
  const rows = report ? (Object.entries(report.modes) as Array<[string, NonNullable<(typeof report.modes)["hybrid"]>]>) : [];
  return (
    <section className="panel">
      <div className="panel-heading">
        <div><span className="panel-kicker">05 / Benchmark</span><h2>{report ? `${report.cases} questions · ${report.llm ? "with LLM" : "rule-based"} · ${report.vectorBackend} vectors` : "Measure retrieval quality"}</h2></div>
        <MotionButton className="button secondary" disabled={evaluate.isPending} onClick={() => evaluate.mutate({ projectId })}><FlaskConical size={14} className={evaluate.isPending ? "spin-slow" : undefined} /> {evaluate.isPending ? "Running…" : "Run benchmark"}</MotionButton>
      </div>
      {rows.length ? (
        <div className="atlas-table-wrap">
          <table className="atlas-table">
            <thead><tr><th>Mode</th><th>Recall@5</th><th>Recall@10</th><th>MRR</th><th>nDCG@10</th><th>Answer hit</th><th>Faithful</th><th>Avg ms</th><th>p95 ms</th></tr></thead>
            <tbody>{rows.map(([mode, score]) => <tr key={mode}><td>{mode}</td><td>{score.recall5.toFixed(2)}</td><td>{score.recall10.toFixed(2)}</td><td>{score.mrr.toFixed(2)}</td><td>{score.ndcg10.toFixed(2)}</td><td>{score.answerHit.toFixed(2)}</td><td>{score.faithfulness.toFixed(2)}</td><td>{Math.round(score.latencyMs)}</td><td>{Math.round(score.p95Ms)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <div className="event-empty">Add <code>.atlas/eval.json</code> with questions and the node keys that answer them (the AcmePay demo ships with 12), then run the benchmark to compare vector, graph, hybrid and agentic retrieval.</div>}
      <ErrorNote error={evaluate.error} />
    </section>
  );
}

function ToolsPanel({ projectId }: { projectId: number }) {
  const tools = trpc.atlas.tools.useQuery();
  const mcp = trpc.atlas.mcpConfig.useQuery();
  const actions = trpc.atlas.actions.useQuery({ projectId }, { refetchInterval: 4000 });
  const cursorJson = mcp.data ? JSON.stringify(mcp.data.cursor.json, null, 2) : "";
  const copy = (text: string, message: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success(message), () => toast.error("Clipboard is not available"));
  };
  return (
    <section className="panel">
      <div className="panel-heading"><div><span className="panel-kicker">06 / Tools & MCP</span><h2>Use CodeAtlas from Cursor or Claude Code</h2></div><Plug size={16} /></div>
      <div className="atlas-tools">
        <div>
          <span className="atlas-meta">Cursor: add this to <code>{mcp.data?.cursor.file ?? ".cursor/mcp.json"}</code>. It runs locally over stdio.</span>
          <pre className="atlas-snippet">{cursorJson || "…"}</pre>
          <MotionButton className="button tiny secondary" disabled={!cursorJson} onClick={() => copy(cursorJson, "Cursor MCP config copied")}><Copy size={12} /> Copy</MotionButton>
          <span className="atlas-meta">Claude Code:</span>
          <pre className="atlas-snippet">{mcp.data?.claudeCode.command ?? "…"}</pre>
          <MotionButton className="button tiny secondary" disabled={!mcp.data} onClick={() => copy(mcp.data?.claudeCode.command ?? "", "Claude Code command copied")}><Copy size={12} /> Copy</MotionButton>
        </div>
        <ul className="atlas-tool-list">
          {tools.data?.tools.map(tool => <li key={tool.name}><code>{tool.name}</code><span className={`atlas-risk ${tool.risk}`}>{tool.risk}</span><span>{tool.description}</span></li>)}
          {tools.data?.external.map(tool => <li key={tool.qualified}><code>{tool.qualified}</code><span className="atlas-risk external">external</span><span>{tool.description}</span></li>)}
        </ul>
      </div>
      {actions.data?.length ? (
        <div className="atlas-action-log">
          <span className="panel-kicker">Tool actions</span>
          {actions.data.slice(0, 8).map(action => <div key={action.id}><span className={`status-tag ${action.status === "done" ? "passed" : action.status === "running" || action.status === "pending" ? "running" : "blocked"}`}><span />{action.status}</span><strong>{action.title}</strong><span className="atlas-meta">{action.tool} · {action.actor} · {relativeTime(action.created_at)}</span>{action.result ? <span className="atlas-meta">{action.result.slice(0, 160)}</span> : null}</div>)}
        </div>
      ) : null}
    </section>
  );
}

export function InvestigateView({ project, onNavigate }: { project: ProjectSummary | undefined; onNavigate: (path: string) => void }) {
  const utils = trpc.useUtils();
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<Mode>("agentic");
  const [activeId, setActiveId] = useState<number | null>(null);
  const projectId = project?.id ?? 0;
  const history = trpc.atlas.investigations.useQuery({ projectId }, { enabled: Boolean(project) });
  const demo = trpc.atlas.demo.useMutation({ onSuccess: data => { toast.success(`Created ${data.name}`, { description: "Six services, releases, PRs and a planted incident. Pick it in the sidebar." }); utils.overview.invalidate(); } });
  const start = trpc.atlas.investigate.useMutation({ onSuccess: data => { setActiveId(data.id); utils.atlas.investigations.invalidate(); } });
  const current = trpc.atlas.investigation.useQuery({ id: activeId ?? 0 }, { enabled: Boolean(activeId), refetchInterval: query => (query.state.data?.status === ("running" as string) ? 900 : false) });
  const running = current.data?.status === ("running" as string);
  const examples = useMemo(() => (project?.name.startsWith("acmepay") ? EXAMPLES : EXAMPLES.slice(1, 3)), [project?.name]);

  useEffect(() => {
    if (!activeId && history.data?.length) setActiveId(history.data[0].id);
  }, [activeId, history.data]);
  useEffect(() => {
    if (current.data && !running) utils.atlas.investigations.invalidate();
  }, [running, current.data, utils]);

  if (!project) {
    return (
      <>
        <PageHeader eyebrow="07 / CODEATLAS" title="Ask your system." description="CodeAtlas builds a knowledge graph of services, APIs, tables, owners, releases, PRs and incidents, then answers engineering questions with cited, verified evidence." />
        <EmptyState icon={Radar} title="No project yet" body="Add a project, or generate the AcmePay demo: six services, release history and a planted production incident." action={<MotionButton className="button primary" disabled={demo.isPending} onClick={() => demo.mutate()}><Sparkles size={14} /> {demo.isPending ? "Generating…" : "Generate demo"}</MotionButton>} />
        <ErrorNote error={demo.error} />
      </>
    );
  }

  const ask = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 5) return;
    setQuestion(trimmed);
    start.mutate({ projectId, question: trimmed, mode });
  };

  return (
    <>
      <PageHeader
        eyebrow={`07 / CODEATLAS · ${project.name}`}
        title="Ask your system."
        description="Questions run through a planner, hybrid retrieval over a temporal knowledge graph, tool calls, a cited writer and a verifier. Everything stays on this machine; only the LLM call goes to your FreeLLMAPI gateway."
        action={<MotionButton className="button secondary" disabled={demo.isPending} onClick={() => demo.mutate()}><Sparkles size={14} /> {demo.isPending ? "Generating…" : "AcmePay demo"}</MotionButton>}
      />
      <ErrorNote error={demo.error} />
      <IndexStrip projectId={projectId} onNavigate={onNavigate} />

      <div className="atlas-layout">
        <aside className="atlas-side">
          <section className="panel">
            <div className="panel-heading"><div><span className="panel-kicker">02 / Question</span><h2>What do you need to know?</h2></div></div>
            <form className="atlas-ask" onSubmit={event => { event.preventDefault(); ask(question); }}>
              <textarea rows={4} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Why did checkout latency jump after the last release?" onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) ask(question); }} />
              <div className="atlas-modes" role="radiogroup" aria-label="Retrieval mode">
                {MODES.map(item => <button type="button" role="radio" aria-checked={mode === item.key} key={item.key} className={mode === item.key ? "active" : ""} title={item.hint} onClick={() => setMode(item.key)}>{item.label}</button>)}
              </div>
              <MotionButton className="button primary" disabled={start.isPending || running || question.trim().length < 5}><Play size={14} /> {running ? "Investigating…" : "Investigate"}</MotionButton>
              <ErrorNote error={start.error} />
            </form>
            <div className="atlas-examples">
              {examples.map(example => <button type="button" key={example} onClick={() => ask(example)} disabled={start.isPending || running}>{example}</button>)}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><span className="panel-kicker">History</span><h2>Past investigations</h2></div></div>
            <ul className="atlas-history">
              {history.data?.map(item => (
                <li key={item.id}><button type="button" className={item.id === activeId ? "active" : ""} onClick={() => setActiveId(item.id)}><strong>{item.question}</strong><span>{item.mode} · {item.status} · {relativeTime(item.created_at)}</span></button></li>
              ))}
              {history.data?.length === 0 ? <li className="event-empty">No investigations yet.</li> : null}
            </ul>
          </section>
        </aside>
        <div className="atlas-main">
          <AnimatePresence mode="wait">
            {current.data ? (
              <motion.div key={current.data.id} className="atlas-stack" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: UI_EASE }}>
                <TracePanel result={current.data} running={running} />
                {!running ? <ResultPanels result={current.data} projectId={projectId} onNavigate={onNavigate} /> : null}
              </motion.div>
            ) : (
              <EmptyState icon={GitBranch} title="Ask a question" body="Try a root-cause question about an incident, a dependency question, or what changed between two releases." />
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="atlas-bottom">
        <Benchmark projectId={projectId} />
        <ToolsPanel projectId={projectId} />
      </div>
      <p className="atlas-footnote"><Database size={12} /> Index, graph, traces and benchmark reports are stored in <code>~/.meadow</code>. GitHub, Jira and Linear are only contacted when you enable them in Runtime settings.</p>
    </>
  );
}
