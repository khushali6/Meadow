import "@xyflow/react/dist/style.css";
import { Background, Controls, MarkerType, MiniMap, ReactFlow, useEdgesState, useNodesState, type Edge, type Node } from "@xyflow/react";
import { Crosshair, Network, Route, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MotionButton, Reveal } from "../components/animation/motion";
import { EmptyState, ErrorNote, PageHeader } from "../components/common";
import { useTheme } from "../contexts/ThemeContext";
import { trpc } from "../lib/trpc";
import type { AtlasMap, ProjectSummary } from "../lib/types";
import { ATLAS_HIGHLIGHT_KEY } from "./InvestigateView";

const LAYERS = [
  { key: "architecture", label: "Architecture", hint: "Services, data stores, infra, pipelines and owners" },
  { key: "apis", label: "APIs", hint: "Which service exposes and calls which endpoint" },
  { key: "history", label: "History", hint: "Releases, pull requests and incidents over time" },
  { key: "code", label: "Code", hint: "Files and functions; select a service to focus" },
] as const;
type Layer = (typeof LAYERS)[number]["key"];

const COLUMNS = ["team", "service", "api", "file", "function", "table", "infra", "pipeline", "release", "commit", "pr", "incident", "issue", "doc", "person"];

type Highlight = { id?: number; nodes: number[]; edges: Array<[number, number]>; question?: string };

function readHighlight(): Highlight | null {
  try {
    const raw = sessionStorage.getItem(ATLAS_HIGHLIGHT_KEY);
    return raw ? (JSON.parse(raw) as Highlight) : null;
  } catch {
    return null;
  }
}

function layout(map: AtlasMap, highlight: Highlight | null, selected: number | null, dark: boolean): { nodes: Node[]; edges: Edge[] } {
  const columns = new Map<string, AtlasMap["nodes"]>();
  for (const node of map.nodes) {
    const kind = COLUMNS.includes(node.kind) ? node.kind : "other";
    columns.set(kind, [...(columns.get(kind) ?? []), node]);
  }
  const order = [...COLUMNS, "other"].filter(kind => columns.has(kind));
  const lit = new Set(highlight?.nodes ?? []);
  const nodes: Node[] = [];
  order.forEach((kind, col) => {
    const items = columns.get(kind)!.sort((a, b) => (map.layer === "history" ? (a.date ?? "").localeCompare(b.date ?? "") : b.degree - a.degree || a.name.localeCompare(b.name)));
    const height = items.length * 60;
    items.forEach((item, row) => {
      nodes.push({
        id: String(item.id),
        position: { x: col * 240, y: row * 60 - height / 2 },
        data: { label: <div className="flow-label"><span className="flow-kind">{item.kind}{item.severity ? ` · ${item.severity}` : ""}</span><strong title={item.name}>{item.name}</strong></div> },
        className: `atlas-flow-node kind-${item.kind}${lit.has(item.id) ? " lit" : ""}${selected === item.id ? " selected" : ""}${lit.size && !lit.has(item.id) ? " dim" : ""}`,
        initialWidth: 200,
        initialHeight: 44,
        sourcePosition: "right" as Node["sourcePosition"],
        targetPosition: "left" as Node["targetPosition"],
      });
    });
  });
  const pairs = new Set((highlight?.edges ?? []).flatMap(([a, b]) => [`${a}-${b}`, `${b}-${a}`]));
  const ink = dark ? "#f2f2ed" : "#1f211e";
  const edges: Edge[] = map.edges.map(edge => {
    const hot = pairs.has(`${edge.src}-${edge.dst}`);
    return {
      id: String(edge.id),
      source: String(edge.src),
      target: String(edge.dst),
      label: hot || map.edges.length < 60 ? edge.kind : undefined,
      animated: hot,
      className: hot ? "lit" : lit.size ? "dim" : undefined,
      style: { stroke: hot ? "#d9a92c" : ink, strokeWidth: hot ? 2.4 : 0.8, opacity: hot ? 1 : lit.size ? 0.18 : 0.5 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: hot ? "#d9a92c" : ink },
      labelStyle: { font: "9px ui-monospace, monospace", fill: ink },
      labelBgStyle: { fill: dark ? "#171917" : "#fffdf9" },
    };
  });
  return { nodes, edges };
}

function FlowCanvas({ flow, dark, fitTo, onNodeClick, onPaneClick }: { flow: { nodes: Node[]; edges: Edge[] }; dark: boolean; fitTo: number[]; onNodeClick: (id: number) => void; onPaneClick: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow.edges);
  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow, setNodes, setEdges]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2, nodes: fitTo.length ? fitTo.map(id => ({ id: String(id) })) : undefined }}
      minZoom={0.1}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      colorMode={dark ? "dark" : "light"}
      onNodeClick={(_, node) => onNodeClick(Number(node.id))}
      onPaneClick={onPaneClick}
    >
      <Background gap={24} size={1} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} nodeColor={node => (node.className?.includes(" lit") ? "#e8c872" : node.className?.includes("kind-service") ? (dark ? "#f2f2ed" : "#1f211e") : "#8a8c85")} maskColor={dark ? "rgba(0,0,0,.55)" : "rgba(250,248,243,.7)"} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function NodePanel({ nodeId, onClose, onPathFrom, pathFrom, onFocus }: { nodeId: number; onClose: () => void; onPathFrom: (id: number) => void; pathFrom: number | null; onFocus: (id: number) => void }) {
  const detail = trpc.atlas.node.useQuery({ nodeId });
  const node = detail.data?.node;
  return (
    <aside className="map-detail panel">
      <div className="panel-heading">
        <div><span className="panel-kicker">{node?.kind ?? "node"}</span><h2>{node?.name ?? "…"}</h2></div>
        <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}><X size={15} /></button>
      </div>
      {node?.path ? <code className="map-detail-path">{node.path}</code> : null}
      <div className="map-detail-actions">
        <MotionButton className="button tiny secondary" onClick={() => onPathFrom(nodeId)}><Route size={12} /> {pathFrom === nodeId ? "Pick a target…" : "Path from here"}</MotionButton>
        {node?.kind === "service" ? <MotionButton className="button tiny secondary" onClick={() => onFocus(nodeId)}><Crosshair size={12} /> Code view</MotionButton> : null}
      </div>
      <ul className="map-edges">
        {detail.data?.edges.map((edge, i) => <li key={i}><span className="atlas-via">{edge.direction === "out" ? `─${edge.kind}→` : `←${edge.kind}─`}</span><span className={`atlas-node-pill kind-${edge.other.kind}`}>{edge.other.name}</span></li>)}
      </ul>
      {detail.data?.docs.map(doc => <pre key={doc.id} className="map-doc">{doc.text}</pre>)}
      <ErrorNote error={detail.error} />
    </aside>
  );
}

export function SystemMapView({ project, onNavigate }: { project: ProjectSummary | undefined; onNavigate: (path: string) => void }) {
  const { theme } = useTheme();
  const [layer, setLayer] = useState<Layer>("architecture");
  const [focus, setFocus] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pathFrom, setPathFrom] = useState<number | null>(null);
  const [pathTo, setPathTo] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(() => readHighlight());
  const projectId = project?.id ?? 0;
  const path = trpc.atlas.path.useQuery({ from: pathFrom ?? 0, to: pathTo ?? 0 }, { enabled: Boolean(pathFrom && pathTo) });
  const active: Highlight | null = path.data ? { nodes: path.data.steps.map(step => step.nodeId), edges: path.data.steps.slice(1).map((step, i) => [path.data!.steps[i].nodeId, step.nodeId] as [number, number]) } : highlight;
  const map = trpc.atlas.map.useQuery({ projectId, layer, focus: layer === "code" ? focus : null, extra: active?.nodes.slice(0, 60) ?? [] }, { enabled: Boolean(project), placeholderData: previous => previous });
  const flow = useMemo(() => (map.data ? layout(map.data, active, selected, theme === "dark") : { nodes: [], edges: [] }), [map.data, active, selected, theme]);

  if (!project) return <EmptyState icon={Network} title="No project selected" body="Pick a project in the sidebar to see its system map." />;

  const clearOverlay = () => {
    sessionStorage.removeItem(ATLAS_HIGHLIGHT_KEY);
    setHighlight(null);
    setPathFrom(null);
    setPathTo(null);
  };

  return (
    <>
      <PageHeader
        eyebrow={`08 / SYSTEM MAP · ${project.name}`}
        title="See how it fits."
        description="The knowledge graph CodeAtlas built from code, infrastructure, git history and incidents. Click a node for its relations, find the path between two nodes, or overlay the evidence path from an investigation."
        action={<MotionButton className="button secondary" onClick={() => onNavigate("/atlas")}>Ask a question</MotionButton>}
      />
      <div className="map-toolbar">
        <div className="atlas-modes" role="radiogroup" aria-label="Map layer">
          {LAYERS.map(item => <button type="button" role="radio" aria-checked={layer === item.key} key={item.key} className={layer === item.key ? "active" : ""} title={item.hint} onClick={() => setLayer(item.key)}>{item.label}</button>)}
        </div>
        <span className="atlas-meta">{map.data ? `${map.data.nodes.length} nodes · ${map.data.edges.length} edges` : "…"}</span>
        {pathFrom && !pathTo ? <span className="map-hint">Click a target node to trace the path</span> : null}
      </div>
      <Reveal show={Boolean(active)} className="banner ok map-overlay">
        <div><strong>{path.data ? "Shortest path" : highlight?.question ? `Investigation #${highlight.id}` : "Overlay"}</strong><span>{path.data ? path.data.text : highlight?.question}</span></div>
        <div className="banner-actions"><MotionButton className="button tiny secondary" onClick={clearOverlay}>Clear</MotionButton></div>
      </Reveal>
      {pathFrom && pathTo && path.data === null ? <div className="banner warn"><div><strong>No path</strong><span>These two nodes are not connected within six hops.</span></div></div> : null}
      <ErrorNote error={map.error ?? path.error} />
      <div className="map-shell">
        <div className="map-canvas">
          {map.data && !map.data.nodes.length ? <EmptyState icon={Network} title="Nothing to draw yet" body="Build the knowledge graph from the CodeAtlas page first." action={<MotionButton className="button primary" onClick={() => onNavigate("/atlas")}>Open CodeAtlas</MotionButton>} /> : (
            <FlowCanvas
              key={`${layer}-${focus ?? 0}-${active?.nodes.join(",") ?? ""}`}
              flow={flow}
              dark={theme === "dark"}
              fitTo={active?.nodes ?? []}
              onNodeClick={id => {
                if (pathFrom && pathFrom !== id && !pathTo) setPathTo(id);
                else setSelected(id);
              }}
              onPaneClick={() => setSelected(null)}
            />
          )}
        </div>
        {selected ? (
          <NodePanel
            nodeId={selected}
            pathFrom={pathFrom}
            onClose={() => setSelected(null)}
            onPathFrom={id => { setPathFrom(id); setPathTo(null); setHighlight(null); }}
            onFocus={id => { setFocus(id); setLayer("code"); }}
          />
        ) : null}
      </div>
    </>
  );
}
