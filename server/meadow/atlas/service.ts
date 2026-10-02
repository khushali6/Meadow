import fs from "node:fs";
import path from "node:path";
import { getSecret, homePath, loadConfig } from "../config";
import { getDb } from "../core/db";
import { bus } from "../core/events";
import { createProject, findProject, getProject } from "../projects";
import { investigate, type Mode } from "./agents";
import { generateAcmePay } from "./demo";
import { formatReport, runEval, type EvalReport } from "./eval";
import { ingestProject, type IngestStats } from "./ingest";
import { llmStatus } from "./llm";
import { listExternalTools } from "./mcpClient";
import { describePath, edgesOf, getNode, graphStats, shortestPath, type NodeKind } from "./store";
import { detectTestCommands, TOOLS } from "./tools";

export const MAP_LAYERS: Record<string, NodeKind[]> = {
  architecture: ["service", "table", "team", "infra", "pipeline"],
  apis: ["service", "api", "table"],
  history: ["service", "release", "pr", "incident"],
  code: ["service", "file", "function"],
};

const ingesting = new Map<number, Promise<IngestStats>>();

export function startIngest(projectId: number): { started: boolean } {
  if (ingesting.has(projectId)) return { started: false };
  const emit = (title: string, detail: string, payload: Record<string, unknown> = {}) => bus.emitEvent({ type: "atlas_ingest", projectId, title, detail, payload });
  const job = ingestProject(projectId, (step, detail) => emit(`Indexing: ${step}`, detail ?? "", { step }))
    .then(stats => {
      emit("Knowledge graph ready", `${stats.services} services · ${stats.functions} functions · ${stats.apis} APIs · ${stats.commits} commits · ${stats.incidents} incidents`, { step: "done", stats });
      return stats;
    })
    .catch(error => {
      emit("Indexing failed", (error as Error).message, { step: "failed" });
      throw error;
    })
    .finally(() => ingesting.delete(projectId));
  job.catch(() => undefined);
  ingesting.set(projectId, job);
  return { started: true };
}

export function atlasStatus(projectId: number) {
  const config = loadConfig().atlas;
  return {
    graph: graphStats(projectId),
    ingesting: ingesting.has(projectId),
    llm: llmStatus(),
    connectors: {
      github: { ...config.connectors.github, token: Boolean(getSecret("GITHUB_TOKEN")) },
      jira: { ...config.connectors.jira, token: Boolean(getSecret("JIRA_API_TOKEN")) },
      linear: { ...config.connectors.linear, token: Boolean(getSecret("LINEAR_API_KEY")) },
    },
    mcpServers: config.mcpServers.map(server => ({ name: server.name, command: [server.command, ...server.args].join(" ") })),
    testCommands: detectTestCommands(getProject(projectId).path),
    lastEval: readEval(projectId),
  };
}

export function systemMap(projectId: number, layer: string, focus: number | null, extra: number[] = []) {
  const kinds = MAP_LAYERS[layer] ?? MAP_LAYERS.architecture;
  const db = getDb();
  type Row = { id: number; kind: string; name: string; path: string | null; valid_from: string | null; props_json: string };
  let nodes = db.all<Row>(`SELECT id, kind, name, path, valid_from, props_json FROM atlas_nodes WHERE project_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) LIMIT 400`, projectId, ...kinds);
  if (layer === "code" && focus) {
    const keep = new Set([focus, ...edgesOf(focus).map(edge => edge.other)]);
    for (const id of Array.from(keep)) for (const edge of edgesOf(id)) if (edge.kind === "defines" || edge.kind === "calls") keep.add(edge.other);
    nodes = nodes.filter(node => keep.has(node.id) || node.kind === "service");
  } else if (layer === "code") nodes = nodes.filter(node => node.kind !== "function").slice(0, 160);
  const missing = extra.filter(id => !nodes.some(node => node.id === id)).slice(0, 60);
  if (missing.length) nodes = nodes.concat(db.all<Row>(`SELECT id, kind, name, path, valid_from, props_json FROM atlas_nodes WHERE project_id = ? AND id IN (${missing.map(() => "?").join(",")})`, projectId, ...missing));
  const ids = new Set(nodes.map(node => node.id));
  const edges = nodes.length ? db.all<{ id: number; src: number; dst: number; kind: string }>(`SELECT id, src, dst, kind FROM atlas_edges WHERE project_id = ? AND src IN (${Array.from(ids).join(",")}) AND dst IN (${Array.from(ids).join(",")})`, projectId) : [];
  const degree = new Map<number, number>();
  for (const edge of edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }
  const connected = layer === "architecture" ? nodes : nodes.filter(node => node.kind === "service" || degree.has(node.id) || extra.includes(node.id));
  return { layer, nodes: connected.map(node => ({ id: node.id, kind: node.kind, name: node.name, path: node.path, date: node.valid_from, degree: degree.get(node.id) ?? 0, severity: (JSON.parse(node.props_json) as { severity?: string }).severity ?? null })), edges };
}

export function nodeDetail(nodeId: number) {
  const node = getNode(nodeId);
  if (!node) throw new Error("Node not found");
  const edges = edgesOf(nodeId).slice(0, 80).map(edge => {
    const other = getNode(edge.other)!;
    return { kind: edge.kind, direction: edge.direction, other: { id: other.id, kind: other.kind, name: other.name } };
  });
  const docs = getDb().all<{ id: number; title: string; text: string; path: string | null }>("SELECT id, title, substr(text, 1, 1600) text, path FROM atlas_docs WHERE node_id = ? LIMIT 3", nodeId);
  return { node, edges, docs };
}

export function pathBetween(from: number, to: number) {
  const steps = shortestPath(from, to, { maxHops: 6, avoidKinds: ["repo"] });
  return steps ? { text: describePath(steps), steps: steps.map(step => ({ nodeId: step.node.id, kind: step.node.kind, name: step.node.name, via: step.via })) } : null;
}

/** Starts an investigation and resolves as soon as it has an id; progress streams as atlas_trace events. */
export function startInvestigation(projectId: number, question: string, mode: Mode, actor: "ui" | "telegram" = "ui"): Promise<number> {
  return new Promise((resolve, reject) => {
    let started = false;
    investigate(projectId, question, { mode, actor, onStart: id => {
      started = true;
      resolve(id);
    } }).catch(error => {
      if (!started) reject(error);
    });
  });
}

const evalFile = (projectId: number) => homePath("atlas", `eval-${projectId}.json`);

function readEval(projectId: number): (EvalReport & { markdown: string }) | null {
  try {
    const report = JSON.parse(fs.readFileSync(evalFile(projectId), "utf8")) as EvalReport;
    return { ...report, markdown: formatReport(report) };
  } catch {
    return null;
  }
}

export async function evaluate(projectId: number) {
  const report = await runEval(projectId);
  fs.mkdirSync(path.dirname(evalFile(projectId)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evalFile(projectId), JSON.stringify(report, null, 2), { mode: 0o600 });
  return { ...report, markdown: formatReport(report) };
}

export async function createDemo(): Promise<{ projectId: number; name: string }> {
  let name = "acmepay";
  for (let i = 2; findProject(name) || fs.existsSync(path.join(loadConfig().projectsDir, name)); i++) name = `acmepay-${i}`;
  const dir = path.join(loadConfig().projectsDir, name);
  await generateAcmePay(dir);
  const project = await createProject({ name, path: dir, description: "AcmePay demo for CodeAtlas: six services, releases, PRs and a planted incident." });
  await ingestProject(project.id);
  return { projectId: project.id, name };
}

export async function toolCatalogue() {
  const external = await listExternalTools().catch(() => []);
  return {
    tools: TOOLS.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, risk: tool.risk, args: Object.keys(tool.shape) })),
    external,
  };
}
