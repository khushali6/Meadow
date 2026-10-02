import { getDb, now } from "../core/db";
import { bus } from "../core/events";
import { redact } from "../core/redact";
import { loadConfig } from "../config";
import { approxTokens, emptyUsage, llmAvailable, tryChat, tryJson, type LlmUsage } from "./llm";
import { callExternalTool, listExternalTools } from "./mcpClient";
import { classify, releaseDiff, retrieve, terms, type Classification, type Hit, type Strategy } from "./retrieve";
import { describePath, edgesOf, getNode, shortestPath, type AtlasNode, type PathStep } from "./store";
import { commitDiff, runTool, TOOLS, type ToolActor } from "./tools";

export type Mode = "agentic" | "hybrid" | "graph" | "vector";
export type Evidence = { n: number; ref: string; title: string; kind: string; path: string | null; snippet: string; context: string; nodeId: number | null; nodeKey: string | null; ts: string | null; sources: string[]; facts: string[]; score: number };
export type Claim = { text: string; citations: number[]; supported: boolean; support: number; method: "lexical" | "llm" | "none"; path: string | null; reretrieved: boolean };
export type Suspect = { nodeId: number; key: string; title: string; score: number; reasons: string[]; files: string[]; highlights: string[] };
export type Finding = { label: string; path: Array<{ nodeId: number; kind: string; name: string; via: string | null }>; text: string };
export type TraceStep = { id: number; ts: string; agent: string; step: string; detail: string; data: unknown };
export type InvestigationResult = {
  id: number;
  projectId: number;
  question: string;
  mode: Mode;
  status: "done" | "failed";
  answer: string;
  classification: { type: string; entities: string[]; releases: string[] };
  plan: { subquestions: string[]; tools: Array<{ name: string; args: Record<string, unknown> }>; planner: "llm" | "rules" };
  evidence: Evidence[];
  claims: Claim[];
  suspects: Suspect[];
  findings: Finding[];
  verifier: { supported: number; total: number; faithfulness: number; citationAccuracy: number; reretrieved: number; unsupported: string[] };
  actions: Array<{ tool: "propose_patch" | "create_issue"; label: string; args: Record<string, unknown> }>;
  highlight: { nodes: number[]; edges: Array<[number, number]> };
  usage: LlmUsage & { contextTokens: number };
  writer: "llm" | "rules";
  ms: number;
  error?: string;
};
export type InvestigateOptions = { mode?: Mode; actor?: ToolActor; at?: string | null; k?: number; record?: boolean; onStart?: (id: number) => void };

const AGENT_LABELS: Record<string, string> = { supervisor: "Supervisor", researcher: "Researcher", architect: "Architect", operator: "Operator", writer: "Writer", verifier: "Verifier" };
const CAUSE_WORDS = /\b(why|cause[ds]?|root|broke|broken|what happened|regression|started failing)\b/i;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

class Trace {
  constructor(readonly investigationId: number, readonly projectId: number, readonly record: boolean) {}
  step(agent: string, step: string, detail: string, data?: unknown) {
    if (!this.record) return;
    const clean = redact(detail).slice(0, 2000);
    getDb().insert("atlas_trace", { investigation_id: this.investigationId, ts: now(), agent, step, detail: clean, data_json: data === undefined ? null : redact(JSON.stringify(data)).slice(0, 20_000) });
    bus.emitEvent({ type: "atlas_trace", projectId: this.projectId, title: `${AGENT_LABELS[agent] ?? agent} · ${step}`, detail: clean, payload: { investigationId: this.investigationId, agent, step } });
  }
}

class EvidenceSet {
  private items = new Map<string, Evidence>();
  add(hit: Pick<Hit, "ref" | "title" | "kind" | "path" | "snippet" | "context" | "ts" | "facts"> & { node?: AtlasNode | null; sources?: string[]; score?: number }, boost = 1): Evidence {
    const existing = this.items.get(hit.ref);
    if (existing) {
      existing.score = Math.max(existing.score, (hit.score ?? 0.01) * boost);
      existing.facts = Array.from(new Set([...existing.facts, ...hit.facts])).slice(0, 6);
      existing.sources = Array.from(new Set([...existing.sources, ...(hit.sources ?? [])]));
      return existing;
    }
    const evidence: Evidence = { n: 0, ref: hit.ref, title: hit.title, kind: hit.kind, path: hit.path, snippet: hit.snippet, context: hit.context, nodeId: hit.node?.id ?? null, nodeKey: hit.node?.key ?? null, ts: hit.ts, sources: hit.sources ?? [], facts: hit.facts, score: (hit.score ?? 0.01) * boost };
    this.items.set(hit.ref, evidence);
    return evidence;
  }
  addNode(node: AtlasNode, title: string, snippet: string, facts: string[], score: number, source: string) {
    return this.add({ ref: `node:${node.id}`, title, kind: node.kind, path: node.path, snippet, context: node.kind, ts: node.validFrom, facts, node, sources: [source], score });
  }
  get(ref: string) {
    return this.items.get(ref);
  }
  /** Numbers the strongest items 1..max and returns them; numbering is what the writer cites. */
  finalize(max: number, pinned: string[] = [], keep: string[] = []): Evidence[] {
    const sorted = Array.from(this.items.values()).sort((a, b) => b.score - a.score);
    const pinnedItems = pinned.map(ref => this.items.get(ref)).filter((e): e is Evidence => Boolean(e));
    let list = Array.from(new Set([...pinnedItems, ...sorted])).slice(0, max);
    const missing = keep.map(ref => this.items.get(ref)).filter((e): e is Evidence => Boolean(e) && !list.includes(e!));
    if (missing.length) list = [...list.slice(0, max - missing.length), ...missing];
    list.forEach((item, i) => (item.n = i + 1));
    return list;
  }
  all() {
    return Array.from(this.items.values());
  }
}

const serializePath = (path: PathStep[]) => path.map(step => ({ nodeId: step.node.id, kind: step.node.kind, name: step.node.name, via: step.via ? `${step.via.direction === "out" ? "→" : "←"}${step.via.kind}` : null }));

function decompose(question: string, cls: Classification): string[] {
  const subs = [question];
  const halves = question.split(/\s+and\s+(?=(?:what|which|who|how|where|why|when)\b)/i);
  if (halves.length > 1) subs.push(...halves.map(half => half.trim()));
  if (cls.type === "multi-hop" || CAUSE_WORDS.test(question)) {
    const core = cls.terms.filter(term => !/^v?\d/.test(term)).slice(0, 6).join(" ");
    subs.push(`incident ${core}`);
    for (const release of cls.releases) subs.push(`changes shipped in release ${release.name}`);
    for (const service of cls.entities.filter(node => node.kind === "service").slice(0, 2)) subs.push(`recent changes to ${service.name}`);
    subs.push(`runbook ${core}`);
  }
  if (cls.type === "relationship") for (const entity of cls.entities.slice(0, 2)) subs.push(`${entity.name} ${cls.relations.join(" ")}`.trim());
  return Array.from(new Set(subs)).slice(0, 5);
}

function heuristicTools(question: string, cls: Classification): Array<{ name: string; args: Record<string, unknown> }> {
  const tools: Array<{ name: string; args: Record<string, unknown> }> = [];
  const services = cls.entities.filter(node => node.kind === "service");
  const hopped = cls.entities.filter(node => ["pr", "commit", "incident", "release", "issue"].includes(node.kind)).flatMap(node => edgesOf(node.id).filter(edge => ["changes", "affects", "deploys"].includes(edge.kind)).map(edge => getNode(edge.other)!)).filter(node => node?.kind === "service");
  if (cls.relations.includes("owned_by")) for (const node of [...cls.entities.filter(n => !["pr", "commit", "incident", "release", "issue"].includes(n.kind)), ...hopped].slice(0, 3)) tools.push({ name: "get_owner", args: { entity: node.name } });
  if (cls.relations.includes("calls") || cls.relations.includes("depends_on")) for (const node of services.slice(0, 2)) tools.push({ name: "find_dependencies", args: { entity: node.name } });
  for (const match of question.matchAll(/(?:PR|pull request)\s*#?(\d+)|#(\d+)/gi)) tools.push({ name: "get_pull_request", args: { number: match[1] ?? match[2] } });
  for (const match of question.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) tools.push({ name: "get_issue", args: { key: match[1] } });
  if (cls.type === "temporal" || cls.type === "multi-hop") tools.push({ name: "get_recent_deployments", args: services[0] ? { service: services[0].name } : {} });
  if (cls.type === "multi-hop") tools.push({ name: "find_related_incidents", args: services[0] ? { service: services[0].name } : { query: question } });
  return tools.slice(0, 5);
}

async function plan(question: string, cls: Classification, usage: LlmUsage): Promise<InvestigationResult["plan"]> {
  const fallback = { subquestions: decompose(question, cls), tools: heuristicTools(question, cls), planner: "rules" as const };
  if (!llmAvailable()) return fallback;
  const external = await listExternalTools().catch(() => []);
  const catalogue = [...TOOLS.filter(tool => tool.risk === "READ" && tool.name !== "investigate").map(tool => `${tool.name}: ${tool.description} args ${Object.keys(tool.shape).join(", ") || "none"}`), ...external.filter(tool => tool.readOnly).map(tool => `${tool.qualified}: ${tool.description}`)].join("\n");
  const result = await tryJson(
    [
      { role: "system", content: "You plan an engineering investigation over a code knowledge graph. Reply with JSON {\"subquestions\": [up to 4 short search queries], \"tools\": [{\"name\": tool, \"args\": {...}}]} using at most 4 read-only tools from the catalogue. Never include secrets." },
      { role: "user", content: `Question: ${question}\nQuery type: ${cls.type}\nEntities: ${cls.entities.map(e => `${e.kind} ${e.name}`).join(", ") || "none"}\n\nTools:\n${catalogue}` },
    ],
    usage,
    value => {
      const v = value as { subquestions?: unknown; tools?: unknown };
      if (!Array.isArray(v.subquestions)) return null;
      const known = new Set([...TOOLS.map(tool => tool.name), ...external.map(tool => tool.qualified)]);
      const tools = Array.isArray(v.tools) ? v.tools.filter((t): t is { name: string; args: Record<string, unknown> } => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" && known.has((t as { name: string }).name)).map(t => ({ name: t.name, args: t.args && typeof t.args === "object" ? t.args : {} })) : [];
      return { subquestions: v.subquestions.filter((s): s is string => typeof s === "string").slice(0, 4), tools: tools.filter(tool => !["run_tests", "create_issue", "propose_patch", "investigate"].includes(tool.name)).slice(0, 4) };
    },
    { maxTokens: 500 },
  );
  if (!result) return fallback;
  return { subquestions: Array.from(new Set([question, ...result.subquestions])).slice(0, 5), tools: result.tools.length ? result.tools : fallback.tools, planner: "llm" };
}

/** Human-readable summary of a diff: setting changes first (`maxAttempts 2 → 6`), then changed lines that mention the symptoms. */
export function diffHighlights(diff: string, focus: string[]): string[] {
  const settings: string[] = [];
  const lines: string[] = [];
  const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|#)/.test(line);
  const assignments = (text: string) => new Map(Array.from(text.matchAll(/\b([A-Za-z_]\w*)\s*[:=]\s*(-?\d+(?:\.\d+)?|true|false)\b/g), match => [match[1], match[2]] as [string, string]));
  const blocks: Array<{ removed: string[]; added: string[] }> = [];
  let current: { removed: string[]; added: string[] } | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-") || raw.startsWith("+")) {
      if (!current || (raw.startsWith("-") && current.added.length)) blocks.push((current = { removed: [], added: [] }));
      (raw.startsWith("-") ? current.removed : current.added).push(raw.slice(1));
    } else current = null;
  }
  for (const block of blocks) {
    const removed = block.removed.filter(line => !isComment(line));
    const added = block.added.filter(line => !isComment(line));
    const before = assignments(removed.join("\n"));
    const after = assignments(added.join("\n"));
    const changed = Array.from(before).filter(([key, value]) => after.has(key) && after.get(key) !== value).map(([key, value]) => `${key} ${value} → ${after.get(key)}`);
    if (changed.length) settings.push(...changed);
    else {
      removed.forEach((line, i) => {
        const next = added[i];
        if (next !== undefined && next.trim() !== line.trim() && focus.some(term => `${line} ${next}`.toLowerCase().includes(term))) lines.push(`\`${clip(line.trim(), 120)}\` → \`${clip(next.trim(), 120)}\``);
      });
    }
  }
  return [...(settings.length ? [`sets ${settings.slice(0, 4).join(", ")}`] : []), ...lines.slice(0, 2)];
}

/** Ranks changes that could explain an incident: commits shipped before it that touched affected services, scored against the symptoms. */
async function suspectsFor(projectId: number, incident: AtlasNode, symptomText: string, evidence: EvidenceSet, trace: Trace): Promise<{ suspects: Suspect[]; findings: Finding[] }> {
  const edges = edgesOf(incident.id);
  const affected = edges.filter(edge => edge.kind === "affects").map(edge => edge.other);
  const release = edges.filter(edge => edge.kind === "follows").map(edge => getNode(edge.other)!).find(Boolean) ?? null;
  const date = incident.validFrom ?? null;
  const since = date ? new Date(new Date(date).getTime() - 21 * 86_400_000).toISOString() : null;
  type Row = { id: number };
  const candidates = new Set<number>();
  if (release) for (const row of getDb().all<Row>("SELECT src id FROM atlas_edges WHERE dst = ? AND kind = 'released_in'", release.id)) candidates.add(row.id);
  if (date && affected.length) {
    for (const row of getDb().all<Row>(`SELECT c.id FROM atlas_edges e JOIN atlas_nodes c ON c.id = e.src WHERE c.kind = 'commit' AND e.kind = 'changes' AND e.dst IN (${affected.map(() => "?").join(",")}) AND c.valid_from <= ? AND c.valid_from >= ?`, ...affected, date, since!)) candidates.add(row.id);
  }
  const symptoms = new Map<string, number>();
  for (const term of terms(symptomText)) if (term.length >= 4 && !/^\d/.test(term)) symptoms.set(term, (symptoms.get(term) ?? 0) + 1);
  const focus = Array.from(symptoms.keys());
  const suspects: Suspect[] = [];
  for (const commitId of candidates) {
    const commit = getNode(commitId);
    if (!commit || commit.kind !== "commit") continue;
    const commitEdges = edgesOf(commitId);
    const files = commitEdges.filter(edge => edge.kind === "modifies").map(edge => getNode(edge.other)!).filter(Boolean);
    const touchesAffected = commitEdges.some(edge => edge.kind === "changes" && affected.includes(edge.other));
    const diff = await commitDiff(projectId, String(commit.props.sha ?? ""), 8000);
    const diffTerms = new Set(terms(`${commit.props.subject ?? ""} ${files.map(f => f.path).join(" ")} ${diff}`));
    const overlap = focus.filter(term => diffTerms.has(term));
    const configChange = /retry|retries|attempt|timeout|pool|max|limit|backoff|concurren|batch|cache|ttl/i.test(diff) ? 1 : 0;
    const score = overlap.length * 1.0 + (touchesAffected ? 2 : 0) + configChange * 1.5 + (release && commitEdges.some(edge => edge.kind === "released_in" && edge.other === release.id) ? 1 : 0);
    const pr = commitEdges.filter(edge => edge.kind === "includes" && edge.direction === "in").map(edge => getNode(edge.other)!).find(node => node?.kind === "pr") ?? null;
    const reasons = [touchesAffected ? `changes an affected service` : "", overlap.length ? `diff mentions ${overlap.slice(0, 5).join(", ")}` : "", configChange ? "alters retry/timeout/pool style settings" : "", release ? `shipped in ${release.name}` : ""].filter(Boolean);
    suspects.push({ nodeId: (pr ?? commit).id, key: (pr ?? commit).key, title: `${pr ? `${pr.name}: ` : ""}${commit.props.subject ?? commit.name}`, score, reasons, files: files.map(file => file.path ?? file.name), highlights: diffHighlights(diff, focus) });
    evidence.add({ ref: `diff:${commit.props.sha}`, title: `Diff of ${pr ? pr.name : String(commit.props.sha).slice(0, 7)}: ${commit.props.subject ?? ""}`, kind: "diff", path: files[0]?.path ?? null, snippet: diff.slice(0, 1200), context: `commit ${String(commit.props.sha).slice(0, 7)} · ${commit.validFrom?.slice(0, 10) ?? ""}`, ts: commit.validFrom, facts: [], node: pr ?? commit, sources: ["architect"], score: score / 100 });
  }
  suspects.sort((a, b) => b.score - a.score);
  const findings: Finding[] = [];
  const top = suspects[0];
  if (top) {
    for (const filePath of top.files.slice(0, 3)) {
      const fileId = getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", projectId, `file:${filePath}`)?.id;
      const fileNode = fileId ? getNode(fileId) : null;
      if (fileNode) evidence.addNode(fileNode, `File ${filePath}`, `${filePath} was changed by ${top.title}.\n${top.highlights.join("\n")}`, [`${top.title.split(":")[0]} ─modifies→ file ${filePath}`], top.score / 120, "architect");
    }
    const target = getNode(top.nodeId)!;
    const path = shortestPath(incident.id, target.id, { maxHops: 5, avoidKinds: ["repo", "service", "person"] }) ?? shortestPath(incident.id, target.id, { maxHops: 5 });
    if (path) findings.push({ label: `${incident.name} → ${target.name}`, path: serializePath(path), text: describePath(path) });
    const file = top.files[0] ? getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", projectId, `file:${top.files[0]}`) : null;
    if (file) {
      const toFile = shortestPath(target.id, file.id, { maxHops: 3, avoidKinds: ["service", "repo"] });
      if (toFile) findings.push({ label: `${target.name} → ${top.files[0]}`, path: serializePath(toFile), text: describePath(toFile) });
    }
  }
  trace.step("architect", "suspects", suspects.length ? suspects.slice(0, 3).map(s => `${s.title} (score ${s.score.toFixed(1)}: ${s.reasons.join("; ")})`).join("\n") : `No candidate changes found for ${incident.name}`, { incident: incident.key, release: release?.name ?? null, candidates: candidates.size });
  return { suspects, findings };
}

function ruleAnswer(projectId: number, question: string, cls: Classification, list: Evidence[], suspects: Suspect[], incident: AtlasNode | null): string {
  const cite = (predicate: (e: Evidence) => boolean) => {
    const found = list.filter(predicate).slice(0, 2).map(e => `[${e.n}]`);
    return found.length ? ` ${found.join("")}` : "";
  };
  const sentences: string[] = [];
  if (incident && suspects.length) {
    const top = suspects[0];
    const release = edgesOf(incident.id).filter(edge => edge.kind === "follows").map(edge => getNode(edge.other)!).find(Boolean);
    const day = (iso: string | null | undefined) => iso?.slice(0, 10) ?? "an unknown date";
    sentences.push(`Incident ${incident.key.replace(/^incident:/, "")} ("${incident.name.replace(/^[A-Z]+-\d+:\s*/, "")}") began on ${day(incident.validFrom)}${release ? `, after release ${release.name} shipped on ${day(release.validFrom)}` : ""}.${cite(e => e.nodeId === incident.id)}`);
    sentences.push(`The most likely cause is ${top.title.replace(/\s*\(#\d+\)$/, "")}, which changed ${top.files.join(", ") || "the affected service"}${release ? ` and shipped in ${release.name}` : ""}.${cite(e => e.ref.startsWith("diff:") && e.nodeId === top.nodeId)}`);
    if (top.highlights.length) sentences.push(`The diff ${top.highlights.join("; ")}.${cite(e => e.ref.startsWith("diff:") && e.nodeId === top.nodeId)}`);
    const mechanism = ["connection", "pool", "attempt", "retry", "retries", "exhausted", ...top.files.map(file => file.split("/").pop()!.replace(/\.\w+$/, ""))];
    const supporting = list
      .filter(e => (e.kind === "doc" || e.kind === "incident") && e.nodeId !== incident.id)
      .map(e => ({ e, score: mechanism.filter(term => e.snippet.toLowerCase().includes(term)).length }))
      .sort((a, b) => b.score - a.score)[0];
    if (supporting?.score) sentences.push(`${supporting.e.title.replace(/^.*›\s*/, "")}: ${firstSentence(supporting.e.snippet, mechanism)} [${supporting.e.n}]`);
    if (suspects.length > 1) sentences.push(`Other changes in the same window were less related: ${suspects.slice(1, 4).map(s => s.title.split(":")[0]).join(", ")}.${cite(e => suspects.slice(1, 4).some(s => s.nodeId === e.nodeId))}`);
    return sentences.join(" ");
  }
  if (cls.releases.length && (cls.type === "temporal" || cls.type === "multi-hop")) {
    const to = cls.releases[cls.releases.length - 1];
    const from = cls.releases.length > 1 ? cls.releases[0] : null;
    const prs = new Map<number, string>();
    for (const item of releaseDiff(projectId, from, to)) if (item.fact.startsWith("PR")) prs.set(item.id, item.fact.replace(/ ─shipped_in→ release [^:]+: /, ": ").replace(/\s*\(#\d+\)$/, ""));
    const releaseCite = cite(e => e.nodeId === to.id);
    if (prs.size) sentences.push(`${from ? `Between ${from.name} and ${to.name}` : `Release ${to.name}`} shipped ${prs.size} change${prs.size === 1 ? "" : "s"}: ${Array.from(prs.values()).join("; ")}.${releaseCite}`);
    for (const [id, text] of prs) {
      const e = list.find(item => item.nodeId === id);
      if (e && sentences.length < 5) sentences.push(`${text.split(":")[0]} touched ${e.snippet.split("\n").filter(line => /^(Changes|Modifies)/.test(line)).map(line => line.replace(/^(Changes|Modifies) /, "")).slice(0, 3).join(", ") || "the codebase"}. [${e.n}]`);
    }
    if (sentences.length) return sentences.join(" ");
  }
  const KINDS = "service|table|team|api|infra|incident|pr|release|issue|pipeline|person|file|function|class|commit|doc|dependency|repo";
  const factRe = new RegExp(`^(${KINDS}) (.+?) ─(\\w+)→ (${KINDS}) (.+)$`);
  const grouped = new Map<string, { subject: string; verb: string; rel: string; objects: Array<{ name: string; n: number }> }>();
  const entityNames = new Set(cls.entities.map(e => e.name));
  const structural = cls.type === "relationship" || cls.type === "entity" || (cls.type === "exact" && cls.relations.length > 0);
  for (const e of structural ? list : []) for (const raw of e.facts) {
    const m = raw.match(factRe);
    if (!m || (cls.relations.length && !cls.relations.includes(m[3]))) continue;
    const [, , src, rel, , dst] = m;
    const incoming = entityNames.has(dst) && !entityNames.has(src);
    const subject = incoming ? dst : src;
    const object = incoming ? src : dst;
    const verb = incoming ? `is ${PASSIVE[rel] ?? `${rel.replace(/_/g, " ")} by`}` : ACTIVE[rel] ?? rel.replace(/_/g, " ");
    const key = `${subject}|${verb}`;
    const group = grouped.get(key) ?? { subject, verb, rel, objects: [] };
    if (!group.objects.some(o => o.name === object)) group.objects.push({ name: object, n: e.n });
    grouped.set(key, group);
  }
  const relRank = (rel: string) => (cls.relations.includes(rel) ? cls.relations.indexOf(rel) : 99);
  const groups = Array.from(grouped.values()).sort((a, b) => relRank(a.rel) - relRank(b.rel) || Number(entityNames.has(b.subject)) - Number(entityNames.has(a.subject)) || Number(b.verb.startsWith("is")) - Number(a.verb.startsWith("is")));
  for (const group of groups.slice(0, 4)) {
    const names = group.objects.slice(0, 6).map(o => `${o.name} [${o.n}]`);
    sentences.push(`${group.subject} ${group.verb} ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}.`);
  }
  const already = new Set(sentences.join(" ").match(/\[\d+\]/g) ?? []);
  const rest = list.filter(item => !already.has(`[${item.n}]`));
  const ordered = cls.type === "code" || cls.type === "semantic" ? [...rest.filter(e => ["function", "class", "file", "doc"].includes(e.kind)), ...rest.filter(e => !["function", "class", "file", "doc"].includes(e.kind))] : rest;
  for (const e of ordered.slice(0, Math.max(1, 4 - sentences.length))) {
    const line = firstSentence(e.snippet, cls.terms);
    if (line) sentences.push(`${e.title.replace(/^.*›\s*/, "")}: ${line} [${e.n}]`);
  }
  return sentences.length ? sentences.join(" ") : `I could not find evidence for "${question}" in the indexed project.`;
}

const ACTIVE: Record<string, string> = { calls: "calls", owned_by: "is owned by", writes: "writes to", reads: "reads from", exposes: "exposes", affects: "affected", runs_on: "runs on", depends_on: "depends on", owns_table: "owns the table", stored_in: "is stored in", deploys: "deploys", implements: "implements", mentions: "mentions" };
const PASSIVE: Record<string, string> = { calls: "called by", owned_by: "the owner of", writes: "written by", reads: "read by", exposes: "exposed by", affects: "affected by", runs_on: "hosting", depends_on: "a dependency of", owns_table: "owned by", stored_in: "storing", deploys: "deployed by", implements: "implemented by", mentions: "mentioned by" };

function firstSentence(text: string, queryTerms: string[]): string {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(s => s.length > 12);
  const best = sentences.map(s => ({ s, n: queryTerms.filter(t => s.toLowerCase().includes(t)).length })).sort((a, b) => b.n - a.n)[0]?.s ?? text.slice(0, 160);
  const trimmed = best.trim().slice(0, 220);
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

async function write(projectId: number, question: string, cls: Classification, list: Evidence[], suspects: Suspect[], findings: Finding[], incident: AtlasNode | null, usage: LlmUsage): Promise<{ text: string; writer: "llm" | "rules" }> {
  if (llmAvailable()) {
    const context = list.map(e => `[${e.n}] ${e.title}${e.context ? ` (${e.context})` : ""}\n${e.facts.length ? `Facts: ${e.facts.join("; ")}\n` : ""}${e.snippet}`).join("\n\n");
    const extra = [suspects.length ? `Ranked suspect changes:\n${suspects.slice(0, 3).map(s => `- ${s.title}: ${s.reasons.join("; ")}${s.highlights.length ? `; ${s.highlights.join("; ")}` : ""}`).join("\n")}` : "", findings.length ? `Graph paths:\n${findings.map(f => `- ${f.text}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    const text = await tryChat(
      [
        { role: "system", content: "You are the Writer agent of an engineering intelligence system. Answer only from the numbered evidence. Put a citation like [2] at the end of every sentence. If the evidence is not enough, say what is missing. Be direct: 3-7 sentences, no preamble." },
        { role: "user", content: `Question: ${question}\n\n${extra}\n\nEvidence:\n${context}` },
      ],
      usage,
      { maxTokens: 700 },
    );
    if (text && /\[\d+\]/.test(text)) return { text: text.trim(), writer: "llm" };
  }
  return { text: ruleAnswer(projectId, question, cls, list, suspects, incident), writer: "rules" };
}

function splitClaims(answer: string): string[] {
  return answer.replace(/\n+/g, " ").split(/(?<=[.!?](?:\s*\[\d+\])*)\s+(?=[A-Z"`(#])/).map(s => s.trim()).filter(s => s.replace(/\[\d+\]/g, "").trim().length > 8);
}

function lexicalSupport(claim: string, evidence: Evidence[]): number {
  const claimTerms = terms(claim.replace(/\[\d+\]/g, "")).filter(term => term.length >= 3 && !/^(most|likely|other|same|which|changed|change|changes|less|related|cause|window|started|after)$/.test(term));
  if (!claimTerms.length || !evidence.length) return 0;
  const haystack = evidence.map(e => `${e.title} ${e.snippet} ${e.facts.join(" ")} ${e.path ?? ""} ${e.nodeKey ?? ""}`).join(" ").toLowerCase();
  return claimTerms.filter(term => haystack.includes(term)).length / claimTerms.length;
}

async function verify(projectId: number, answer: string, list: Evidence[], evidenceSet: EvidenceSet, usage: LlmUsage, allowReretrieve: boolean, trace: Trace): Promise<{ claims: Claim[]; added: Evidence[] }> {
  const claims: Claim[] = [];
  const added: Evidence[] = [];
  const byN = new Map(list.map(e => [e.n, e]));
  for (const text of splitClaims(answer)) {
    const citations = Array.from(text.matchAll(/\[(\d+)\]/g), match => Number(match[1])).filter(n => byN.has(n));
    const cited = citations.map(n => byN.get(n)!);
    let support = lexicalSupport(text, cited);
    let method: Claim["method"] = cited.length ? "lexical" : "none";
    if (cited.length && support < 0.6 && llmAvailable()) {
      const verdict = await tryJson([
        { role: "system", content: "You check whether evidence supports a claim. Reply JSON {\"supported\": true|false}." },
        { role: "user", content: `Claim: ${text}\n\nEvidence:\n${cited.map(e => `${e.title}\n${e.snippet}\n${e.facts.join("; ")}`).join("\n\n")}` },
      ], usage, value => (typeof (value as { supported?: unknown }).supported === "boolean" ? (value as { supported: boolean }).supported : null), { maxTokens: 30 });
      if (verdict !== null) {
        support = verdict ? Math.max(support, 0.8) : Math.min(support, 0.3);
        method = "llm";
      }
    }
    let reretrieved = false;
    if (support < 0.6 && allowReretrieve) {
      reretrieved = true;
      const result = await retrieve(projectId, text.replace(/\[\d+\]/g, ""), { k: 4, rerank: false });
      const fresh = result.hits.map(hit => evidenceSet.add(hit, 0.5));
      const pool = [...cited, ...fresh];
      const again = lexicalSupport(text, pool);
      if (again >= 0.6) {
        support = again;
        method = "lexical";
        for (const e of fresh) if (!e.n) added.push(e);
      }
    }
    const entities = classify(projectId, text).entities.slice(0, 2);
    const path = entities.length === 2 ? shortestPath(entities[0].id, entities[1].id, { maxHops: 4, avoidKinds: ["repo"] }) : null;
    claims.push({ text, citations, supported: support >= 0.6, support: Math.round(support * 100) / 100, method, path: path ? describePath(path) : null, reretrieved });
  }
  const unsupported = claims.filter(claim => !claim.supported);
  trace.step("verifier", "verdict", `${claims.length - unsupported.length}/${claims.length} claims supported${unsupported.length ? `; unsupported: ${unsupported.map(c => c.text.slice(0, 80)).join(" | ")}` : ""}`, { claims: claims.map(c => ({ text: c.text.slice(0, 160), supported: c.supported, support: c.support })) });
  return { claims, added };
}

export function getInvestigation(id: number): (InvestigationResult & { trace: TraceStep[] }) | null {
  const row = getDb().get<{ result_json: string | null; status: string; question: string; project_id: number; mode: Mode; created_at: string }>("SELECT * FROM atlas_investigations WHERE id = ?", id);
  if (!row) return null;
  const trace = getDb().all<{ id: number; ts: string; agent: string; step: string; detail: string; data_json: string | null }>("SELECT * FROM atlas_trace WHERE investigation_id = ? ORDER BY id", id).map(step => ({ id: step.id, ts: step.ts, agent: step.agent, step: step.step, detail: step.detail, data: step.data_json ? JSON.parse(step.data_json) : null }));
  const base = row.result_json ? (JSON.parse(row.result_json) as InvestigationResult) : ({ id, projectId: row.project_id, question: row.question, mode: row.mode, status: row.status, answer: "", evidence: [], claims: [], suspects: [], findings: [], actions: [] } as unknown as InvestigationResult);
  return { ...base, status: row.status as InvestigationResult["status"], trace };
}

export function listInvestigations(projectId: number, limit = 30) {
  return getDb().all<{ id: number; question: string; mode: string; status: string; answer: string | null; created_at: string; finished_at: string | null }>("SELECT id, question, mode, status, substr(answer, 1, 240) answer, created_at, finished_at FROM atlas_investigations WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit);
}

export async function investigate(projectId: number, question: string, options: InvestigateOptions = {}): Promise<InvestigationResult> {
  const started = Date.now();
  const mode = options.mode ?? "agentic";
  const record = options.record ?? true;
  const id = record ? getDb().insert("atlas_investigations", { project_id: projectId, question: redact(question), mode, status: "running", created_at: now() }) : 0;
  const trace = new Trace(id, projectId, record);
  const usage = emptyUsage();
  options.onStart?.(id);
  try {
    const result = await runInvestigation(id, projectId, question, mode, options, trace, usage);
    result.ms = Date.now() - started;
    if (record) getDb().update("atlas_investigations", id, { status: "done", answer: result.answer, result_json: JSON.stringify(result), finished_at: now() });
    trace.step("supervisor", "done", `${result.verifier.supported}/${result.verifier.total} claims verified in ${(result.ms / 1000).toFixed(1)}s`, { faithfulness: result.verifier.faithfulness });
    return result;
  } catch (error) {
    const message = (error as Error).message;
    if (record) getDb().update("atlas_investigations", id, { status: "failed", answer: message, finished_at: now() });
    trace.step("supervisor", "failed", message);
    throw error;
  }
}

async function runInvestigation(id: number, projectId: number, question: string, mode: Mode, options: InvestigateOptions, trace: Trace, usage: LlmUsage): Promise<InvestigationResult> {
  const cls = classify(projectId, question);
  const agentic = mode === "agentic";
  const strategies: Strategy[] | undefined = mode === "vector" ? ["vector"] : mode === "graph" ? ["graph"] : undefined;
  const k = options.k ?? 8;
  const evidence = new EvidenceSet();
  trace.step("supervisor", "classify", `${cls.type} question${cls.entities.length ? ` about ${cls.entities.map(e => e.name).join(", ")}` : ""}`, { type: cls.type, entities: cls.entities.map(e => e.key), relations: cls.relations, at: cls.at });

  const planned = agentic ? await plan(question, cls, usage) : { subquestions: [question], tools: [], planner: "rules" as const };
  if (agentic) trace.step("supervisor", "plan", `${planned.subquestions.length} searches, ${planned.tools.length} tool calls (${planned.planner})`, planned);

  for (const [i, sub] of planned.subquestions.entries()) {
    const result = await retrieve(projectId, sub, { k, strategies, at: options.at ?? null, usage, rerank: agentic ? undefined : false, classification: i === 0 ? cls : undefined });
    for (const hit of result.hits) evidence.add(hit, i === 0 ? 1 : 0.7);
    trace.step("researcher", i === 0 ? "search" : "sub-search", `${sub} → ${result.hits.slice(0, 4).map(hit => hit.title).join(" · ")}`, { query: sub, type: result.classification.type, vector: result.vectorBackend, reranked: result.reranked, timings: result.timings, hits: result.hits.map(hit => ({ title: hit.title, sources: hit.sources })) });
  }

  let suspects: Suspect[] = [];
  const findings: Finding[] = [];
  let incident: AtlasNode | null = null;
  const followUpRefs: string[] = [];
  const operatorRefs: string[] = [];
  if (agentic) {
    const candidates = [...cls.entities, ...evidence.all().sort((a, b) => b.score - a.score).slice(0, 8).map(e => (e.nodeId ? getNode(e.nodeId) : null)).filter((n): n is AtlasNode => Boolean(n))];
    incident = CAUSE_WORDS.test(question) || cls.type === "multi-hop" ? candidates.find(node => node.kind === "incident") ?? null : null;
    if (incident) {
      const symptomText = [getDb().all<{ text: string }>("SELECT text FROM atlas_docs WHERE node_id = ?", incident.id).map(row => row.text).join("\n"), question, ...evidence.all().filter(e => e.kind === "doc").slice(0, 3).map(e => e.snippet)].join("\n");
      evidence.addNode(incident, `Incident ${incident.name}`, symptomText.slice(0, 900), [], 0.05, "architect");
      ({ suspects } = await suspectsFor(projectId, incident, symptomText, evidence, trace).then(result => {
        findings.push(...result.findings);
        return result;
      }));
      const top = suspects[0];
      if (top) {
        const followUp = `${top.title.replace(/^PR #\d+:\s*/, "").replace(/\(#\d+\)/, "")} ${top.highlights.join(" ")} connection pool`;
        const result = await retrieve(projectId, followUp, { k: 6, strategies: ["bm25", "vector"], usage, rerank: false });
        for (const hit of result.hits.filter(hit => hit.kind === "doc" || hit.kind === "incident")) followUpRefs.push(evidence.add(hit, 0.9).ref);
        trace.step("researcher", "follow-up", `Evidence for ${top.key}: ${result.hits.slice(0, 4).map(hit => hit.title).join(" · ")}`, { query: followUp });
      }
    }
    const pairs = cls.entities.slice(0, 3);
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const path = shortestPath(pairs[i].id, pairs[j].id, { maxHops: 4, avoidKinds: ["repo"] });
      if (path) findings.push({ label: `${pairs[i].name} ↔ ${pairs[j].name}`, path: serializePath(path), text: describePath(path) });
    }
    trace.step("architect", "paths", findings.length ? findings.map(f => f.text).join("\n") : "No multi-entity paths needed", { findings: findings.length });

    for (const call of planned.tools.slice(0, loadConfig().atlas.maxAgentSteps)) {
      try {
        if (call.name.includes("__")) {
          const output = await callExternalTool(call.name, call.args, { projectId, agent: "operator" });
          evidence.add({ ref: `tool:${call.name}:${JSON.stringify(call.args)}`, title: `${call.name} (external MCP)`, kind: "tool", path: null, snippet: output.slice(0, 1500), context: "external tool", ts: null, facts: [], sources: ["operator"], score: 0.02 });
          trace.step("operator", call.name, output.slice(0, 300), { args: call.args, external: true });
          continue;
        }
        const output = await runTool(call.name, call.args, { projectId, actor: "agent", investigationId: id, usage });
        for (const item of output.evidence ?? []) {
          const node = item.nodeId ? getNode(item.nodeId) : null;
          const added = evidence.add({ ref: `tool:${call.name}:${item.title}`, title: `${item.title} (${call.name})`, kind: item.kind, path: item.path ?? null, snippet: item.text.slice(0, 1500), context: `tool ${call.name}`, ts: null, facts: item.text.split("\n").filter(line => line.includes("─")).slice(0, 6), node, sources: ["operator"], score: 0.012 });
          if (added.facts.length) operatorRefs.push(added.ref);
        }
        trace.step("operator", call.name, output.summary, { args: call.args });
      } catch (error) {
        trace.step("operator", call.name, `failed: ${(error as Error).message}`, { args: call.args });
      }
    }
  }

  const pinned = [
    ...(incident ? [`node:${incident.id}`] : []),
    ...suspects.slice(0, 2).flatMap(s => evidence.all().filter(e => e.ref.startsWith("diff:") && e.nodeId === s.nodeId).map(e => e.ref)),
    ...followUpRefs.slice(0, 2),
  ];
  let list = evidence.finalize(12, pinned, operatorRefs.slice(0, 3));
  const contextTokens = list.reduce((sum, e) => sum + approxTokens(`${e.title} ${e.snippet} ${e.facts.join(" ")}`), 0);
  const written = await write(projectId, question, cls, list, suspects, findings, incident, usage);
  trace.step("writer", "answer", written.text.slice(0, 600), { writer: written.writer, evidence: list.length });

  const verified = await verify(projectId, written.text, list, evidence, usage, agentic, trace);
  let answer = written.text;
  if (verified.added.length) {
    list = [...list, ...verified.added.map((e, i) => ({ ...e, n: list.length + i + 1 }))];
  }
  const unsupported = verified.claims.filter(claim => !claim.supported);
  if (unsupported.length && agentic) for (const claim of unsupported) answer = answer.replace(claim.text, `${claim.text} _(unverified)_`);
  const totalCitations = verified.claims.reduce((sum, claim) => sum + claim.citations.length, 0);
  const correctCitations = verified.claims.filter(claim => claim.supported).reduce((sum, claim) => sum + claim.citations.length, 0);

  const actions: InvestigationResult["actions"] = [];
  if (suspects[0]) {
    const top = suspects[0];
    actions.push({ tool: "propose_patch", label: "Fix with Meadow", args: { title: `Fix ${incident ? incident.key.replace(/^incident:/, "") : "regression"}: revisit ${top.title.split(":")[0]}`, description: `Root cause from CodeAtlas investigation #${id}: ${top.title}.\n${top.highlights.join("\n")}\nReasons: ${top.reasons.join("; ")}\nMake the change safe (for example cap retries, add jittered backoff, release pooled connections between attempts) and add a regression test.`, files: top.files.slice(0, 5) } });
  }
  actions.push({ tool: "create_issue", label: "Create issue", args: { title: incident ? `${incident.name} — follow-up` : question.slice(0, 120), body: `${answer}\n\nEvidence:\n${list.map(e => `[${e.n}] ${e.title}${e.path ? ` (${e.path})` : ""}`).join("\n")}\n\nGenerated by CodeAtlas investigation #${id}.`, labels: incident ? ["incident-followup"] : [] } });

  const highlightNodes = new Set<number>([...cls.entities.map(e => e.id), ...list.map(e => e.nodeId).filter((n): n is number => Boolean(n)), ...findings.flatMap(f => f.path.map(step => step.nodeId))]);
  const highlightEdges: Array<[number, number]> = findings.flatMap(f => f.path.slice(1).map((step, i) => [f.path[i].nodeId, step.nodeId] as [number, number]));
  return {
    id,
    projectId,
    question,
    mode,
    status: "done",
    answer,
    classification: { type: cls.type, entities: cls.entities.map(e => e.name), releases: cls.releases.map(r => r.name) },
    plan: planned,
    evidence: list,
    claims: verified.claims,
    suspects: suspects.slice(0, 5),
    findings,
    verifier: { supported: verified.claims.length - unsupported.length, total: verified.claims.length, faithfulness: verified.claims.length ? Math.round(((verified.claims.length - unsupported.length) / verified.claims.length) * 100) / 100 : 0, citationAccuracy: totalCitations ? Math.round((correctCitations / totalCitations) * 100) / 100 : 0, reretrieved: verified.claims.filter(c => c.reretrieved).length, unsupported: unsupported.map(c => c.text) },
    actions,
    highlight: { nodes: Array.from(highlightNodes).slice(0, 80), edges: highlightEdges },
    usage: { ...usage, contextTokens },
    writer: written.writer,
    ms: 0,
  };
}
