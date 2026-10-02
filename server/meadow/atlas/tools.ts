import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getSecret, loadConfig } from "../config";
import { requestApproval } from "../core/approvals";
import { audit, isSafeRelativePath, RISK_POLICY, type RiskLevel } from "../core/audit";
import { getDb, now } from "../core/db";
import { bus } from "../core/events";
import { minimalEnv, runShell } from "../core/exec";
import { git } from "../core/git";
import { redact, tail } from "../core/redact";
import { harness } from "../harness/runner";
import { addNote, approvePlan, getProject, savePlanVersion } from "../projects";
import { githubRepo } from "./connectors";
import { changeImpact, nodesForPaths } from "./impact";
import { callExternalTool, listExternalTools } from "./mcpClient";
import type { LlmUsage } from "./llm";
import { nameVariants } from "./parse";
import { releaseDiff, retrieve, type Strategy } from "./retrieve";
import { edgesOf, findNodes, getNode, neighborhood, nodesByKind, shortestPath, describePath, type AtlasNode, type NodeKind } from "./store";

export type ToolActor = "agent" | "mcp" | "ui" | "telegram" | "cli";
export type ToolContext = { projectId: number; actor: ToolActor; investigationId?: number | null; usage?: LlmUsage };
export type ToolEvidence = { title: string; text: string; nodeId?: number | null; path?: string | null; kind: string };
export type ToolResult = { summary: string; data: unknown; evidence?: ToolEvidence[]; pending?: { actionId: number; approvalId: number } };
type Shape = Record<string, z.ZodType>;
export type ToolDef<S extends Shape = Shape> = { name: string; title: string; description: string; risk: RiskLevel; shape: S; run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult> };

const define = <S extends Shape>(tool: ToolDef<S>) => tool as unknown as ToolDef;

function resolveEntity(projectId: number, name: string, kinds?: NodeKind[]): AtlasNode | null {
  const direct = findNodes(projectId, name, kinds, 5);
  if (direct.length) return direct.sort((a, b) => (a.kind === "service" ? -1 : 0) - (b.kind === "service" ? -1 : 0))[0];
  const lower = name.toLowerCase();
  return nodesByKind(projectId, kinds ?? ["service"]).find(node => node.kind === "service" && nameVariants(node.name).includes(lower)) ?? null;
}

const fact = (from: AtlasNode, kind: string, to: AtlasNode, direction: "out" | "in") => (direction === "out" ? `${from.name} ─${kind}→ ${to.name}` : `${to.name} ─${kind}→ ${from.name}`);

function serviceOfNode(node: AtlasNode): AtlasNode | null {
  if (node.kind === "service") return node;
  let current: AtlasNode | null = node;
  for (let i = 0; i < 3 && current; i++) {
    const parent: AtlasNode | null = edgesOf(current.id).filter(edge => edge.direction === "in" && (edge.kind === "contains" || edge.kind === "defines")).map(edge => getNode(edge.other)).find(Boolean) ?? null;
    if (parent?.kind === "service") return parent;
    current = parent;
  }
  return null;
}

/** Commands the project itself declares as its tests. */
export function detectTestCommands(root: string): string[] {
  const out: string[] = [];
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      const test = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.test;
      if (test && !/no test specified/.test(test)) out.push(fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm test" : "npm test --silent");
    } catch {
      // ignore malformed package.json
    }
  }
  if (read("pytest.ini") || /\[tool\.pytest/.test(read("pyproject.toml") ?? "")) out.push("python3 -m pytest -q");
  if (read("go.mod")) out.push("go test ./...");
  if (/^test:/m.test(read("Makefile") ?? "")) out.push("make test");
  if (read("Cargo.toml")) out.push("cargo test");
  return out;
}

type ActionRow = { id: number; project_id: number; investigation_id: number | null; tool: string; title: string; args_json: string; status: string; approval_id: number | null; result: string | null; actor: string; created_at: string; finished_at: string | null };

export function listActions(projectId: number, limit = 50) {
  return getDb().all<ActionRow>("SELECT * FROM atlas_actions WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit).map(row => ({ ...row, args: JSON.parse(row.args_json) }));
}

type Executor = (args: Record<string, unknown>, projectId: number) => Promise<string>;

const EXECUTORS: Record<string, Executor> = {
  async run_tests(args, projectId) {
    const project = getProject(projectId);
    const result = await runShell(String(args.command), { cwd: project.path, timeoutS: loadConfig().harness.checkTimeoutS, env: minimalEnv() });
    return `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""} in ${Math.round(result.durationMs / 1000)}s\n${tail(result.output, 80, 6000)}`;
  },
  async create_issue(args, projectId) {
    const project = getProject(projectId);
    const github = loadConfig().atlas.connectors.github;
    const repo = github.enabled && getSecret("GITHUB_TOKEN") ? await githubRepo(projectId) : null;
    if (repo) {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: "POST", headers: { Authorization: `Bearer ${getSecret("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "User-Agent": "meadow-atlas", "Content-Type": "application/json" }, body: JSON.stringify({ title: args.title, body: args.body, labels: args.labels ?? [] }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const created = (await response.json()) as { html_url: string; number: number };
      return `Created GitHub issue #${created.number}: ${created.html_url}`;
    }
    addNote({ projectId: project.id, title: String(args.title), body: String(args.body), source: "atlas" });
    return `Saved as a note in ${project.name}`;
  },
  async propose_patch(args, projectId) {
    const project = getProject(projectId);
    if (harness.isActive(project.id)) throw new Error("A run is already active for this project.");
    const row = savePlanVersion(project.id, String(args.plan), { source: "atlas" });
    await approvePlan(row.id);
    const executionId = await harness.start(project.id, { hint: String(args.description).slice(0, 2000) });
    return `Started execution ${executionId} with plan v${row.version} on ${project.engine}. Progress streams to the dashboard and Telegram.`;
  },
  async external_write(args, projectId) {
    return callExternalTool(String(args.tool), (args.arguments ?? {}) as Record<string, unknown>, { projectId, agent: "approved-action", approved: true });
  },
};

let executorStarted = false;

async function settleAction(approvalId: number, status: string) {
  const db = getDb();
  const action = db.get<ActionRow>("SELECT * FROM atlas_actions WHERE approval_id = ? AND status = 'pending'", approvalId);
  if (!action) return;
  const risk = getTool(action.tool)?.risk ?? "HIGH_WRITE";
  const args = JSON.parse(action.args_json) as Record<string, unknown>;
  const base = { projectId: action.project_id, agent: action.actor, user: userOf(action.actor as ToolActor), tool: action.tool, risk, args };
  if (status !== "approved") {
    db.run("UPDATE atlas_actions SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'", status === "expired" ? "expired" : "denied", now(), action.id);
    audit({ ...base, approval: status === "expired" ? "expired" : "denied", result: "refused", durationMs: 0, detail: `approval #${approvalId}` });
    return;
  }
  if (db.run("UPDATE atlas_actions SET status = 'running' WHERE id = ? AND status = 'pending'", action.id).changes === 0) return;
  const started = Date.now();
  try {
    const result = redact(await EXECUTORS[action.tool](args, action.project_id));
    db.update("atlas_actions", action.id, { status: "done", result, finished_at: now() });
    audit({ ...base, approval: "approved", result: "ok", durationMs: Date.now() - started, detail: `approval #${approvalId}` });
    bus.emitEvent({ type: "message", projectId: action.project_id, title: `${action.title}: done`, detail: result.slice(0, 1500), payload: { atlasAction: action.id, tool: action.tool } });
  } catch (error) {
    db.update("atlas_actions", action.id, { status: "failed", result: (error as Error).message, finished_at: now() });
    audit({ ...base, approval: "approved", result: "error", durationMs: Date.now() - started, detail: (error as Error).message });
    bus.emitEvent({ type: "error", projectId: action.project_id, title: `${action.title}: failed`, detail: (error as Error).message, payload: { atlasAction: action.id, tool: action.tool } });
  }
}

/** Runs approved CodeAtlas actions. The daemon owns this; the MCP server process only records requests. */
export function startActionExecutor() {
  if (executorStarted) return;
  executorStarted = true;
  bus.onEvent(event => {
    if (event.type !== "approval_decided" || typeof event.payload?.approvalId !== "number") return;
    void settleAction(event.payload.approvalId, String(event.payload.status));
  });
}

/** Records an action and asks the owner. It runs only after approval; expiry means deny. */
function gated(ctx: ToolContext, tool: keyof typeof EXECUTORS, title: string, detail: string, args: Record<string, unknown>, risk: "medium" | "high"): ToolResult {
  if (process.env.MEADOW_ROLE !== "mcp") startActionExecutor();
  const actionId = getDb().insert("atlas_actions", { project_id: ctx.projectId, investigation_id: ctx.investigationId ?? null, tool, title, args_json: JSON.stringify(args), status: "pending", actor: ctx.actor, created_at: now() });
  const approval = requestApproval({ projectId: ctx.projectId, kind: `atlas.${tool}`, title, detail, risk, detached: true });
  getDb().update("atlas_actions", actionId, { approval_id: approval.id });
  return { summary: `Waiting for approval #${approval.id}: ${title}. Approve it in the Meadow dashboard or on Telegram; it runs in the Meadow daemon.`, data: { actionId, approvalId: approval.id, status: "pending" }, pending: { actionId, approvalId: approval.id } };
}

export function fixPlanMarkdown(input: { projectName: string; title: string; description: string; files: string[]; checks: string[] }): string {
  const yaml = (value: string) => JSON.stringify(value);
  const checks = input.checks.length ? input.checks : input.files.length ? [`git diff --name-only HEAD -- ${input.files.map(file => `'${file.replace(/'/g, "")}'`).join(" ")} | grep -q .`] : ["git diff --quiet HEAD && exit 1 || exit 0"];
  return `---
project: ${input.projectName}
goal: ${yaml(input.title)}
stack: [existing]
constraints:
  - Change only what the fix needs; keep the public API stable
  - Explain the root cause in the commit message
phases:
  - id: 1
    name: ${yaml(input.title.slice(0, 80))}
    tasks:
${input.description.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 12).map(line => `      - ${yaml(line.replace(/^[-*]\s*/, ""))}`).join("\n")}
${input.files.length ? `      - ${yaml(`Start from: ${input.files.join(", ")}`)}\n` : ""}    checks:
${checks.map(cmd => `      - cmd: ${yaml(cmd)}`).join("\n")}
    done_when: ${yaml("The fix is in place and the checks pass")}
---

Generated by CodeAtlas from an investigation. Review before approving.
`;
}

export const TOOLS: ToolDef[] = [
  define({
    name: "search_code", title: "Search code and knowledge", risk: "READ",
    description: "Hybrid search (vector + BM25 + code symbols + knowledge graph) over code, docs, commits, PRs and incidents of the project.",
    shape: { query: z.string().min(2).max(500), k: z.number().int().min(1).max(30).optional(), mode: z.enum(["hybrid", "vector", "bm25", "graph", "symbol"]).optional() },
    async run(args, ctx) {
      const strategies = !args.mode || args.mode === "hybrid" ? undefined : [args.mode as Strategy];
      const result = await retrieve(ctx.projectId, args.query, { k: args.k ?? 8, strategies, usage: ctx.usage });
      return {
        summary: `${result.hits.length} results (${result.classification.type} query)`,
        data: { type: result.classification.type, hits: result.hits.map(hit => ({ title: hit.title, kind: hit.kind, path: hit.path, context: hit.context, snippet: hit.snippet, sources: hit.sources, facts: hit.facts })) },
        evidence: result.hits.map(hit => ({ title: hit.title, text: hit.snippet, nodeId: hit.node?.id, path: hit.path, kind: hit.kind })),
      };
    },
  }),
  define({
    name: "get_repository_map", title: "Repository map", risk: "READ",
    description: "Services with their APIs, tables, owners and service-to-service calls.",
    shape: {},
    async run(_args, ctx) {
      const services = nodesByKind(ctx.projectId, ["service"]).map(service => {
        const edges = edgesOf(service.id).map(edge => ({ ...edge, node: getNode(edge.other)! }));
        const pick = (kind: string, direction: "out" | "in", nodeKind?: string) => edges.filter(edge => edge.kind === kind && edge.direction === direction && (!nodeKind || edge.node.kind === nodeKind)).map(edge => edge.node.name);
        return { name: service.name, path: service.path, apis: pick("exposes", "out"), tables: [...new Set([...pick("writes", "out"), ...pick("reads", "out")])], owners: pick("owned_by", "out"), calls: pick("calls", "out", "service"), calledBy: pick("calls", "in", "service") };
      });
      return { summary: `${services.length} services`, data: { services }, evidence: services.map(service => ({ title: `Service ${service.name}`, text: `calls ${service.calls.join(", ") || "nothing"}; called by ${service.calledBy.join(", ") || "nobody"}; owners ${service.owners.join(", ") || "unknown"}; tables ${service.tables.join(", ") || "none"}`, kind: "service" })) };
    },
  }),
  define({
    name: "find_dependencies", title: "Find dependencies", risk: "READ",
    description: "What an entity (service, table, API, file) depends on and what depends on it.",
    shape: { entity: z.string().min(1).max(200), direction: z.enum(["in", "out", "both"]).optional() },
    async run(args, ctx) {
      const node = resolveEntity(ctx.projectId, args.entity);
      if (!node) return { summary: `No entity called ${args.entity}`, data: null };
      const kinds = ["calls", "depends_on", "reads", "writes", "runs_on", "imports", "stored_in"];
      const direction = args.direction ?? "both";
      const edges = edgesOf(node.id).filter(edge => kinds.includes(edge.kind) && (direction === "both" || edge.direction === direction)).map(edge => ({ edge, other: getNode(edge.other)! }));
      const facts = edges.map(({ edge, other }) => fact(node, edge.kind, other, edge.direction));
      return { summary: `${facts.length} dependency edges for ${node.name}`, data: { entity: node.name, kind: node.kind, dependsOn: edges.filter(e => e.edge.direction === "out").map(e => ({ name: e.other.name, kind: e.other.kind, via: e.edge.kind })), dependents: edges.filter(e => e.edge.direction === "in").map(e => ({ name: e.other.name, kind: e.other.kind, via: e.edge.kind })) }, evidence: [{ title: `Dependencies of ${node.name}`, text: facts.join("\n"), nodeId: node.id, kind: "graph" }] };
    },
  }),
  define({
    name: "trace_service", title: "Trace a service", risk: "READ",
    description: "Neighbourhood of a service: APIs, tables, infrastructure, owners, incidents and connected services.",
    shape: { service: z.string().min(1).max(200), depth: z.number().int().min(1).max(3).optional() },
    async run(args, ctx) {
      const node = resolveEntity(ctx.projectId, args.service, ["service"]);
      if (!node) return { summary: `No service called ${args.service}`, data: null };
      const hood = neighborhood([node.id], args.depth ?? 1, { edgeKinds: ["calls", "exposes", "reads", "writes", "owned_by", "affects", "runs_on", "deployed_as", "deploys", "owns_table"] });
      const byId = new Map(hood.nodes.map(n => [n.id, n]));
      const facts = hood.edges.map(edge => `${byId.get(edge.src)?.name} ─${edge.kind}→ ${byId.get(edge.dst)?.name}`);
      return { summary: `${hood.nodes.length} connected entities`, data: { service: node.name, nodes: hood.nodes.map(n => ({ id: n.id, kind: n.kind, name: n.name })), edges: hood.edges.map(edge => ({ src: edge.src, dst: edge.dst, kind: edge.kind })) }, evidence: [{ title: `Trace of ${node.name}`, text: facts.join("\n"), nodeId: node.id, kind: "graph" }] };
    },
  }),
  define({
    name: "find_related_incidents", title: "Related incidents", risk: "READ",
    description: "Incidents that affected a service or match a description.",
    shape: { service: z.string().max(200).optional(), query: z.string().max(500).optional() },
    async run(args, ctx) {
      const incidents = new Map<number, AtlasNode>();
      if (args.service) {
        const service = resolveEntity(ctx.projectId, args.service, ["service"]);
        if (service) for (const edge of edgesOf(service.id)) if (edge.kind === "affects" && edge.direction === "in") incidents.set(edge.other, getNode(edge.other)!);
      }
      if (args.query) {
        const result = await retrieve(ctx.projectId, args.query, { k: 10, strategies: ["bm25", "vector"] });
        for (const hit of result.hits) if (hit.node?.kind === "incident") incidents.set(hit.node.id, hit.node);
      }
      if (!args.service && !args.query) for (const node of nodesByKind(ctx.projectId, ["incident"])) incidents.set(node.id, node);
      const list = Array.from(incidents.values()).sort((a, b) => (b.validFrom ?? "").localeCompare(a.validFrom ?? ""));
      return { summary: `${list.length} incidents`, data: list.map(node => ({ key: node.key.replace(/^incident:/, ""), title: node.name, date: node.validFrom, severity: node.props.severity ?? null, path: node.path })), evidence: list.map(node => ({ title: `Incident ${node.name}`, text: `${node.name} on ${node.validFrom ?? "unknown date"} severity ${node.props.severity ?? "?"}`, nodeId: node.id, path: node.path, kind: "incident" })) };
    },
  }),
  define({
    name: "get_recent_deployments", title: "Recent deployments", risk: "READ",
    description: "Recent releases with the PRs and commits they shipped, optionally for one service.",
    shape: { service: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() },
    async run(args, ctx) {
      let releases = nodesByKind(ctx.projectId, ["release"]).sort((a, b) => (b.validFrom ?? "").localeCompare(a.validFrom ?? ""));
      const service = args.service ? resolveEntity(ctx.projectId, args.service, ["service"]) : null;
      if (service) releases = releases.filter(release => edgesOf(release.id).some(edge => edge.kind === "deploys" && edge.other === service.id));
      const list = releases.slice(0, args.limit ?? 5).map(release => ({ release: release.name, date: release.validFrom, changes: releaseDiff(ctx.projectId, null, release).filter(item => item.fact.startsWith("PR") || !item.fact.includes("(#")).map(item => item.fact) }));
      return { summary: `${list.length} releases${service ? ` touching ${service.name}` : ""}`, data: list, evidence: list.map(item => ({ title: `Release ${item.release}`, text: `${item.release} on ${item.date}\n${item.changes.join("\n")}`, nodeId: releases.find(r => r.name === item.release)?.id, kind: "release" })) };
    },
  }),
  define({
    name: "get_pull_request", title: "Pull request", risk: "READ",
    description: "A pull request with its commits, changed files, services, release and diff excerpt.",
    shape: { number: z.union([z.number().int(), z.string().regex(/^#?\d+$/)]) },
    async run(args, ctx) {
      const number = String(args.number).replace(/^#/, "");
      const node = findNodes(ctx.projectId, `PR #${number}`, ["pr"], 1)[0];
      if (!node) return { summary: `PR #${number} is not in the graph`, data: null };
      const commits = edgesOf(node.id).filter(edge => edge.kind === "includes" && edge.direction === "out").map(edge => getNode(edge.other)!).filter(n => n.kind === "commit");
      const files = new Set<string>();
      const releases = new Set<string>();
      let diff = "";
      for (const commit of commits) {
        for (const edge of edgesOf(commit.id)) {
          const other = getNode(edge.other)!;
          if (edge.kind === "modifies" && other.path) files.add(other.path);
          if (edge.kind === "released_in") releases.add(other.name);
        }
        diff += await commitDiff(ctx.projectId, String(commit.props.sha ?? ""), 4000);
      }
      const services = edgesOf(node.id).filter(edge => edge.kind === "changes").map(edge => getNode(edge.other)!.name);
      const data = { number: Number(number), title: node.props.title ?? node.name, url: node.props.url ?? null, state: node.props.state ?? "merged", date: node.validFrom, services, files: [...files], releases: [...releases], diff: diff.slice(0, 6000) };
      return { summary: `PR #${number}: ${data.title}`, data, evidence: [{ title: `PR #${number}: ${data.title}`, text: `Changes ${services.join(", ")}; files ${[...files].join(", ")}; released in ${[...releases].join(", ") || "unreleased"}\n${diff.slice(0, 2500)}`, nodeId: node.id, kind: "pr" }] };
    },
  }),
  define({
    name: "get_issue", title: "Issue or incident", risk: "READ",
    description: "An issue or incident by key (for example INC-2041, ENG-12 or #31).",
    shape: { key: z.string().min(1).max(60) },
    async run(args, ctx) {
      const node = getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND kind IN ('issue','incident') AND (key = ? OR key = ? OR key = ?)", ctx.projectId, `issue:${args.key}`, `incident:${args.key}`, `issue:#${args.key.replace(/^#/, "")}`);
      if (!node) return { summary: `${args.key} is not in the graph`, data: null };
      const full = getNode(node.id)!;
      const doc = getDb().get<{ text: string }>("SELECT text FROM atlas_docs WHERE node_id = ? LIMIT 1", node.id)?.text ?? "";
      const links = edgesOf(node.id).map(edge => fact(full, edge.kind, getNode(edge.other)!, edge.direction));
      return { summary: `${args.key}: ${full.name}`, data: { key: args.key, kind: full.kind, title: full.name, date: full.validFrom, props: full.props, text: doc.slice(0, 4000), links }, evidence: [{ title: full.name, text: `${doc.slice(0, 2000)}\n${links.join("\n")}`, nodeId: node.id, path: full.path, kind: full.kind }] };
    },
  }),
  define({
    name: "query_architecture", title: "Query architecture", risk: "READ",
    description: "Answers structural questions from the knowledge graph: facts and paths between the entities named in the question.",
    shape: { question: z.string().min(3).max(500) },
    async run(args, ctx) {
      const result = await retrieve(ctx.projectId, args.question, { k: 12, strategies: ["graph", "bm25"] });
      const entities = result.classification.entities.slice(0, 4);
      const paths: string[] = [];
      for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) {
        const found = shortestPath(entities[i].id, entities[j].id, { maxHops: 4, avoidKinds: ["repo"] });
        if (found) paths.push(describePath(found));
      }
      const facts = result.hits.flatMap(hit => hit.facts).slice(0, 30);
      return { summary: `${facts.length} facts, ${paths.length} paths`, data: { type: result.classification.type, entities: entities.map(e => e.name), facts, paths }, evidence: [{ title: "Architecture facts", text: [...paths, ...facts].join("\n"), kind: "graph" }] };
    },
  }),
  define({
    name: "get_owner", title: "Owner", risk: "READ",
    description: "Owning team (CODEOWNERS) and most active authors for a service or file.",
    shape: { entity: z.string().min(1).max(300) },
    async run(args, ctx) {
      const node = resolveEntity(ctx.projectId, args.entity, ["service", "file", "function", "table", "api"]);
      if (!node) return { summary: `No entity called ${args.entity}`, data: null };
      const service = serviceOfNode(node) ?? (node.kind === "table" ? edgesOf(node.id).filter(e => e.kind === "owns_table" && e.direction === "in").map(e => getNode(e.other)).find(Boolean) ?? null : null);
      const teams = service ? edgesOf(service.id).filter(edge => edge.kind === "owned_by").map(edge => getNode(edge.other)!.name) : [];
      const authors = getDb().all<{ name: string; n: number }>(
        `SELECT p.name, COUNT(*) n FROM atlas_edges m JOIN atlas_edges a ON a.dst = m.src AND a.kind = 'authored' JOIN atlas_nodes p ON p.id = a.src
         WHERE m.kind IN ('modifies','changes') AND m.dst = ? GROUP BY p.id ORDER BY n DESC LIMIT 5`, service && node.kind !== "file" ? service.id : node.id);
      return { summary: `${node.name}: ${teams.join(", ") || "no CODEOWNERS entry"}`, data: { entity: node.name, service: service?.name ?? null, teams, topAuthors: authors }, evidence: [{ title: `Owner of ${node.name}`, text: `${service ? teams.map(team => `service ${service.name} ─owned_by→ team ${team}`).join("\n") : ""}\nTop authors: ${authors.map(a => `${a.name} (${a.n})`).join(", ")}`, nodeId: service?.id ?? node.id, kind: "graph" }] };
    },
  }),
  define({
    name: "run_tests", title: "Run tests", risk: "HIGH_WRITE",
    description: "Runs the project's test command after the owner approves it. Returns immediately with a pending action.",
    shape: { command: z.string().max(300).optional() },
    async run(args, ctx) {
      const project = getProject(ctx.projectId);
      const detected = detectTestCommands(project.path);
      const command = args.command?.trim() || detected[0];
      if (!command) return { summary: "No test command found. Pass one explicitly.", data: { detected } };
      return gated(ctx, "run_tests", `Run tests in ${project.name}`, `Command: ${command}\nDirectory: ${project.path}`, { command }, detected.includes(command) ? "medium" : "high");
    },
  }),
  define({
    name: "create_issue", title: "Create issue", risk: "LOW_WRITE",
    description: "Files an issue after approval: on GitHub when that connector is enabled, otherwise as a Meadow note.",
    shape: { title: z.string().min(3).max(200), body: z.string().max(20_000), labels: z.array(z.string().max(50)).max(10).optional() },
    async run(args, ctx) {
      const settings = loadConfig().atlas.connectors.github;
      const useGithub = settings.enabled && !!getSecret("GITHUB_TOKEN");
      const target = useGithub ? `GitHub (${(await githubRepo(ctx.projectId)) ?? "repo unknown"})` : "Meadow notes";
      return gated(ctx, "create_issue", `Create issue: ${args.title}`, `Target: ${target}\n\n${args.body.slice(0, 1500)}`, args, "medium");
    },
  }),
  define({
    name: "propose_patch", title: "Fix with Meadow", risk: "HIGH_WRITE",
    description: "Turns a diagnosis into a one-phase fix plan and, after approval, runs it through the Meadow harness with the project's coding engine.",
    shape: { title: z.string().min(3).max(200), description: z.string().min(10).max(8000), files: z.array(z.string().max(300).refine(isSafeRelativePath, "Files must be relative paths inside the project")).max(20).optional(), checks: z.array(z.string().max(300)).max(5).optional() },
    async run(args, ctx) {
      const project = getProject(ctx.projectId);
      if (harness.isActive(project.id)) return { summary: "A run is already active for this project. Wait for it to finish.", data: null };
      const checks = args.checks?.length ? args.checks : detectTestCommands(project.path);
      const plan = fixPlanMarkdown({ projectName: project.name, title: args.title, description: args.description, files: args.files ?? [], checks });
      return gated(ctx, "propose_patch", `Fix with Meadow: ${args.title}`, `Engine: ${project.engine}\nFiles: ${(args.files ?? []).join(", ") || "agent decides"}\nChecks: ${checks.join("; ") || "files changed"}\n\n${args.description.slice(0, 1200)}`, { ...args, plan }, "high");
    },
  }),
  define({
    name: "call_external_tool", title: "Call an external MCP tool", risk: "HIGH_WRITE",
    description: "Call a tool from an MCP server configured in Meadow (qualified as server__tool). Read-only tools run immediately; tools that write wait for the owner's approval; destructive tools can't be requested over MCP.",
    shape: { tool: z.string().regex(/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/).max(160), arguments: z.record(z.string(), z.unknown()).optional() },
    async run(args, ctx) {
      const known = (await listExternalTools(args.tool.split("__")[0])).find(tool => tool.qualified === args.tool);
      if (!known) throw new ToolPolicyError("UNKNOWN_TOOL", `No external tool ${args.tool}. Configured MCP servers are listed in Settings → MCP.`);
      const payload = args.arguments ?? {};
      if (JSON.stringify(payload).length > 20_000) throw new ToolPolicyError("INVALID_ARGS", "External tool arguments must be under 20 KB.");
      if (known.readOnly) return { summary: (await callExternalTool(known.qualified, payload, { projectId: ctx.projectId, agent: ctx.actor })).slice(0, 4000), data: null };
      if (known.risk === "DESTRUCTIVE" && ctx.actor === "mcp") throw new ToolPolicyError("NOT_ALLOWED", `${known.qualified} is destructive and can't be requested over MCP.`);
      return gated(ctx, "external_write", `${known.risk === "DESTRUCTIVE" ? "Destructive" : "Write"}: ${known.qualified}`, `${known.description || known.tool}\nArguments: ${redact(JSON.stringify(payload)).slice(0, 800)}`, { tool: known.qualified, arguments: payload }, "high");
    },
  }),
  define({
    name: "change_impact", title: "Change impact", risk: "READ",
    description: "What a change to an entity or to files can affect: dependent services, APIs, tables, owners, tests and past incidents, with the relation behind each.",
    shape: { entity: z.string().min(1).max(200).optional(), paths: z.array(z.string().max(300).refine(isSafeRelativePath, "Paths must be relative paths inside the project")).max(50).optional() },
    async run(args, ctx) {
      const seeds = args.entity ? [resolveEntity(ctx.projectId, args.entity, ["service", "api", "table", "file", "function", "class", "module", "infra"])].filter((node): node is AtlasNode => Boolean(node)) : nodesForPaths(ctx.projectId, args.paths ?? []);
      if (!seeds.length) return { summary: "Nothing in the knowledge graph matches. Build or refresh the graph first.", data: null };
      const report = changeImpact(seeds.map(node => node.id));
      return {
        summary: `${report.impacted.length} affected (${report.risk} risk): ${report.reasons.join("; ") || "no dependents"}`,
        data: report,
        evidence: report.impacted.slice(0, 12).map(item => ({ title: `${item.kind} ${item.name}`, text: item.via, nodeId: item.id, path: item.path, kind: item.kind })),
      };
    },
  }),
  define({
    name: "investigate", title: "Investigate", risk: "READ",
    description: "Runs the multi-agent investigation (planner, researcher, architect, operator, writer, verifier) and returns a cited, verified answer.",
    shape: { question: z.string().min(5).max(1000), mode: z.enum(["agentic", "hybrid", "graph", "vector"]).optional() },
    async run(args, ctx) {
      const { investigate } = await import("./agents");
      const result = await investigate(ctx.projectId, args.question, { mode: args.mode ?? "agentic", actor: ctx.actor });
      return { summary: result.answer.slice(0, 300), data: { id: result.id, answer: result.answer, claims: result.claims, verifier: result.verifier, suspects: result.suspects, evidence: result.evidence.map(e => ({ n: e.n, title: e.title, path: e.path })) } };
    },
  }),
];

export const getTool = (name: string) => TOOLS.find(tool => tool.name === name);

export class ToolPolicyError extends Error {
  constructor(readonly code: "UNKNOWN_TOOL" | "INVALID_ARGS" | "NOT_ALLOWED", message: string) {
    super(message);
  }
}

const userOf = (actor: ToolActor) => (actor === "telegram" ? "telegram-owner" : actor === "mcp" ? "mcp-client" : "local-owner");

/**
 * The single entry point for CodeAtlas tools from agents, MCP clients, the dashboard and Telegram.
 * Arguments are validated strictly, the risk policy is applied, and every call is audited by
 * argument hash (never the arguments themselves).
 */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const tool = getTool(name);
  const base = { projectId: ctx.projectId, agent: ctx.actor, user: userOf(ctx.actor), tool: name, args: rawArgs };
  if (!tool) {
    audit({ ...base, risk: "READ", approval: "refused", result: "refused", durationMs: 0, detail: "unknown tool" });
    throw new ToolPolicyError("UNKNOWN_TOOL", `Unknown tool ${name}`);
  }
  if (ctx.actor === "mcp" && !RISK_POLICY[tool.risk].allowFromMcp) {
    audit({ ...base, risk: tool.risk, approval: "refused", result: "refused", durationMs: 0, detail: "not allowed from MCP" });
    throw new ToolPolicyError("NOT_ALLOWED", `${tool.title} is ${tool.risk} and can't be called over MCP.`);
  }
  const parsed = z.object(tool.shape).strict().safeParse(rawArgs ?? {});
  if (!parsed.success) {
    audit({ ...base, risk: tool.risk, approval: "refused", result: "refused", durationMs: Date.now() - started, detail: "invalid arguments" });
    throw new ToolPolicyError("INVALID_ARGS", `Invalid arguments for ${name}: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ")}`);
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    audit({ ...base, risk: tool.risk, approval: result.pending ? "pending" : "not_required", result: result.pending ? "pending" : "ok", durationMs: Date.now() - started, detail: result.pending ? `approval #${result.pending.approvalId}` : "" });
    return result;
  } catch (error) {
    audit({ ...base, risk: tool.risk, approval: RISK_POLICY[tool.risk].approval === "none" ? "not_required" : "pending", result: "error", durationMs: Date.now() - started, detail: (error as Error).message });
    throw error;
  }
}

export async function commitDiff(projectId: number, sha: string, maxChars = 6000): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return "";
  try {
    const out = await git(getProject(projectId).path, "show", "--format=", "--unified=1", "--no-color", "--no-ext-diff", sha);
    return redact(out).slice(0, maxChars);
  } catch {
    return "";
  }
}
