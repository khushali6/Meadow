import { getDb } from "../core/db";
import { loadConfig } from "../config";
import { llmAvailable, tryEmbed, tryJson, type LlmUsage } from "./llm";
import { nameVariants } from "./parse";
import { allEmbeddings, edgesOf, getNode, visibleAt, type AtlasNode, type NodeKind } from "./store";

export type QueryType = "semantic" | "entity" | "exact" | "relationship" | "code" | "temporal" | "multi-hop";
export type Strategy = "vector" | "bm25" | "symbol" | "graph";
export type Classification = { type: QueryType; entities: AtlasNode[]; releases: AtlasNode[]; at: string | null; terms: string[]; identifiers: string[]; relations: string[] };
export type Hit = {
  ref: string;
  docId: number | null;
  node: AtlasNode | null;
  kind: string;
  title: string;
  path: string | null;
  text: string;
  snippet: string;
  context: string;
  ts: string | null;
  score: number;
  sources: Strategy[];
  facts: string[];
};
export type RetrieveOptions = { k?: number; strategies?: Strategy[]; rerank?: boolean; at?: string | null; usage?: LlmUsage; classification?: Classification };
export type RetrievalResult = { query: string; classification: Classification; hits: Hit[]; timings: Partial<Record<Strategy | "fusion" | "rerank", number>>; vectorBackend: "gateway" | "hashed" | "none"; reranked: boolean };

const STOPWORDS = new Set("a an and are as at be by did do does for from has have how in into is it its of on or that the this to was were what when where which who whom why will with after before between since about there their them they any all our your can could would should show tell me list find".split(" "));
const RRF_K = 60;
const WEIGHTS: Record<QueryType, Record<Strategy, number>> = {
  semantic: { vector: 1.2, bm25: 1, symbol: 0.6, graph: 0.6 },
  entity: { vector: 0.8, bm25: 1, symbol: 1, graph: 1.2 },
  exact: { vector: 0.5, bm25: 1.3, symbol: 1.3, graph: 0.6 },
  relationship: { vector: 0.8, bm25: 0.8, symbol: 0.6, graph: 1.5 },
  code: { vector: 1, bm25: 1.1, symbol: 1.5, graph: 0.5 },
  temporal: { vector: 0.7, bm25: 1, symbol: 0.5, graph: 1.4 },
  "multi-hop": { vector: 1, bm25: 1, symbol: 0.7, graph: 1.4 },
};
const GRAPH_EDGES: Record<QueryType, string[] | null> = {
  relationship: ["calls", "owned_by", "reads", "writes", "exposes", "owns_table", "affects", "runs_on", "stored_in", "deploys", "deployed_as", "mentions", "depends_on", "implements"],
  temporal: ["released_in", "includes", "modifies", "changes", "deploys", "follows", "authored"],
  "multi-hop": ["follows", "released_in", "includes", "modifies", "changes", "affects", "calls", "reads", "writes", "mentions", "owned_by"],
  entity: null,
  semantic: ["mentions", "documents", "owned_by", "exposes"],
  exact: ["implements", "handles", "exposes"],
  code: ["defines", "calls", "implements", "imports"],
};
const RELATION_WORDS: Array<[RegExp, string[]]> = [
  [/\b(owns?|owner|owned|who maintains|team)\b/, ["owned_by"]],
  [/\b(calls?|callers?|talks to|upstream|downstream|invokes?)\b/, ["calls"]],
  [/\b(writes?|inserts?|updates?)\b/, ["writes", "owns_table"]],
  [/\b(reads?|queries|selects?)\b/, ["reads"]],
  [/\b(depends?|dependenc(y|ies))\b/, ["depends_on", "calls"]],
  [/\b(incidents?|outages?|affected|affects?)\b/, ["affects"]],
  [/\b(runs on|database|infra(structure)?|hosted|deployed)\b/, ["runs_on", "stored_in", "deployed_as", "provisions"]],
  [/\b(endpoints?|apis?|routes?|exposes?)\b/, ["exposes", "implements"]],
  [/\b(introduced|added|changed|pr|pull request|commit)\b/, ["modifies", "includes", "changes"]],
];
const STRUCTURAL_KINDS: NodeKind[] = ["service", "table", "team", "api", "infra", "incident", "pr", "release", "issue", "pipeline", "person"];

export function terms(text: string): string[] {
  const words = text.split(/[^A-Za-z0-9#_.\-/]+/).flatMap(word => [word, ...word.split(/[_.\-/]+/), ...word.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ")]).map(word => word.toLowerCase());
  return Array.from(new Set(words.map(word => word.replace(/^[#.\-/]+|[.\-/]+$/g, "")).filter(word => word.length >= 2 && !STOPWORDS.has(word))));
}

function identifiers(query: string): string[] {
  const out = new Set<string>();
  for (const match of query.matchAll(/`([^`]+)`/g)) out.add(match[1]);
  for (const match of query.matchAll(/\b([A-Za-z_][\w]*(?:[a-z][A-Z]|_)[\w]*)\b/g)) out.add(match[1]);
  for (const match of query.matchAll(/\b[\w-]+\.(?:ts|tsx|js|py|go|java|sql|md|ya?ml|tf)\b/g)) out.add(match[0]);
  for (const match of query.matchAll(/(?:^|\s)(\/[\w/{}:.-]+)/g)) out.add(match[1]);
  return Array.from(out);
}

type EntityIndex = { version: string; entries: Array<{ node: AtlasNode; patterns: string[] }> };
const entityCache = new Map<number, EntityIndex>();

function ingestVersion(projectId: number) {
  return getDb().get<{ finished_at: string }>("SELECT finished_at FROM atlas_ingests WHERE project_id = ?", projectId)?.finished_at ?? "none";
}

function entityIndex(projectId: number): EntityIndex {
  const version = ingestVersion(projectId);
  const cached = entityCache.get(projectId);
  if (cached?.version === version) return cached;
  const rows = getDb().all<{ id: number }>(`SELECT id FROM atlas_nodes WHERE project_id = ? AND kind IN (${STRUCTURAL_KINDS.map(() => "?").join(",")})`, projectId, ...STRUCTURAL_KINDS);
  const entries = rows.map(row => getNode(row.id)!).map(node => {
    const keyTail = node.key.slice(node.kind.length + 1);
    const patterns = node.kind === "service" ? nameVariants(node.name)
      : node.kind === "team" ? [node.name.toLowerCase(), node.name.split("/").pop()!.toLowerCase()]
      : node.kind === "infra" ? [keyTail.split(".").pop()!.toLowerCase()]
      : node.kind === "incident" || node.kind === "issue" || node.kind === "pr" || node.kind === "release" ? [keyTail.toLowerCase()]
      : node.kind === "api" ? [keyTail.toLowerCase()]
      : node.kind === "pipeline" ? []
      : [node.name.toLowerCase()];
    return { node, patterns: patterns.filter(pattern => pattern.length >= 3) };
  });
  const index = { version, entries };
  entityCache.set(projectId, index);
  return index;
}

const mentions = (text: string, pattern: string) => {
  const at = text.indexOf(pattern);
  if (at < 0) return false;
  const before = text[at - 1] ?? " ";
  const after = text[at + pattern.length] ?? " ";
  return !/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after);
};

export function classify(projectId: number, query: string): Classification {
  const lower = query.toLowerCase();
  const found = entityIndex(projectId).entries.filter(entry => entry.patterns.some(pattern => mentions(lower, pattern))).map(entry => entry.node);
  const entities = found.filter(node => !(node.kind === "api" && found.some(other => other !== node && other.kind === "api" && other.key.includes(node.key.slice(4)) && other.key.length > node.key.length)));
  const releases = entities.filter(node => node.kind === "release").sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? ""));
  const ids = identifiers(query);
  let at: string | null = null;
  const asOf = lower.match(/\b(?:as of|at the time of|before)\s+(v?\d+\.\d+(?:\.\d+)?)/);
  if (asOf) at = releases.find(release => release.name.toLowerCase() === asOf[1])?.validFrom ?? null;
  const type: QueryType =
    /\bwhy\b|root cause|caused|what broke|investigate/.test(lower) ? "multi-hop"
    : releases.length || /\b(changed|changes|release|deploy(ed|ment)?s?|since|history|introduced|when)\b/.test(lower) ? "temporal"
    : /\b(calls?|callers?|depends?|dependenc|owns?|owner|owned|who|upstream|downstream|impact|affect(ed|s)?|writes?|reads?|connect|runs on|talks to)\b/.test(lower) && entities.length ? "relationship"
    : /\b(where is|implemented|implementation|function|class|method|code for|defined)\b/.test(lower) || ids.some(id => /[a-z][A-Z]|_|\./.test(id)) ? "code"
    : /["`]/.test(query) || ids.some(id => id.startsWith("/")) || /\b(endpoint|route|table|column)\b/.test(lower) ? "exact"
    : entities.length ? "entity"
    : "semantic";
  const relations = Array.from(new Set(RELATION_WORDS.filter(([pattern]) => pattern.test(lower)).flatMap(([, kinds]) => kinds)));
  return { type, entities, releases, at, terms: terms(query), identifiers: ids, relations };
}

type Ranked = Array<{ ref: string; docId: number | null; nodeId: number | null; facts?: string[] }>;

function docRef(row: { id: number; node_id: number | null }) {
  return { ref: row.node_id ? `node:${row.node_id}` : `doc:${row.id}`, docId: row.id, nodeId: row.node_id };
}

function bm25(projectId: number, cls: Classification, k: number): Ranked {
  const tokens = cls.terms.filter(term => /^[a-z0-9_]+$/.test(term)).slice(0, 24);
  if (!tokens.length) return [];
  const match = tokens.map(term => `"${term}"`).join(" OR ");
  return getDb().all<{ id: number; node_id: number | null }>("SELECT d.id, d.node_id FROM atlas_fts JOIN atlas_docs d ON d.id = atlas_fts.rowid WHERE atlas_fts MATCH ? AND d.project_id = ? ORDER BY bm25(atlas_fts, 4.0, 1.0) LIMIT ?", match, projectId, k * 3).map(docRef);
}

const HASH_DIM = 512;
const hashedCache = new Map<number, { version: string; vectors: Array<{ id: number; nodeId: number | null; vector: Float32Array }>; idf: Map<string, number> }>();

function hashToken(token: string) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return Math.abs(h) % HASH_DIM;
}

function hashedVector(tokens: string[], idf: Map<string, number>) {
  const vector = new Float32Array(HASH_DIM);
  for (const token of tokens) vector[hashToken(token)] += idf.get(token) ?? 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

/** Offline fallback when no embedding model is reachable: TF-IDF feature hashing. Reported as the "hashed" backend. */
function hashedIndex(projectId: number) {
  const version = ingestVersion(projectId);
  const cached = hashedCache.get(projectId);
  if (cached?.version === version) return cached;
  const rows = getDb().all<{ id: number; node_id: number | null; title: string; text: string }>("SELECT id, node_id, title, text FROM atlas_docs WHERE project_id = ?", projectId);
  const docTokens = rows.map(row => terms(`${row.title} ${row.text}`.slice(0, 6000)));
  const df = new Map<string, number>();
  for (const tokens of docTokens) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  const idf = new Map(Array.from(df, ([token, count]) => [token, Math.log(1 + rows.length / count)]));
  const index = { version, idf, vectors: rows.map((row, i) => ({ id: row.id, nodeId: row.node_id, vector: hashedVector(docTokens[i], idf) })) };
  hashedCache.set(projectId, index);
  return index;
}

const dot = (a: Float32Array, b: Float32Array | number[]) => {
  let sum = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return sum / (Math.sqrt(na * nb) || 1);
};

async function vector(projectId: number, query: string, k: number): Promise<{ ranked: Ranked; backend: RetrievalResult["vectorBackend"] }> {
  const stored = allEmbeddings(projectId);
  if (stored.length) {
    const embedded = await tryEmbed([query]);
    if (embedded?.[0]?.length === stored[0].vector.length) {
      const nodeOf = new Map(getDb().all<{ id: number; node_id: number | null }>("SELECT id, node_id FROM atlas_docs WHERE project_id = ? AND embedding IS NOT NULL", projectId).map(row => [row.id, row.node_id]));
      const ranked = stored.map(row => ({ id: row.id, score: dot(row.vector, embedded[0]) })).sort((a, b) => b.score - a.score).slice(0, k * 3);
      return { ranked: ranked.map(row => docRef({ id: row.id, node_id: nodeOf.get(row.id) ?? null })), backend: "gateway" };
    }
  }
  const index = hashedIndex(projectId);
  if (!index.vectors.length) return { ranked: [], backend: "none" };
  const queryVector = hashedVector(terms(query), index.idf);
  const ranked = index.vectors.map(row => ({ row, score: dot(row.vector, queryVector) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, k * 3);
  return { ranked: ranked.map(item => docRef({ id: item.row.id, node_id: item.row.nodeId })), backend: "hashed" };
}

function symbol(projectId: number, cls: Classification, k: number): Ranked {
  const out: Ranked = [];
  const seen = new Set<number>();
  const push = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ref: `node:${id}`, docId: null, nodeId: id });
  };
  const kinds = ["function", "class", "file", "api", "table"];
  const inKinds = kinds.map(() => "?").join(",");
  for (const id of cls.identifiers) {
    const name = id.split("/").pop()!;
    for (const row of getDb().all<{ id: number }>(`SELECT id FROM atlas_nodes WHERE project_id = ? AND kind IN (${inKinds}) AND (name = ? OR key LIKE ?) ORDER BY length(key) LIMIT 5`, projectId, ...kinds, name, `%${id}%`)) push(row.id);
  }
  for (const term of cls.terms.filter(term => term.length >= 4 && /^[a-z0-9_]+$/.test(term))) {
    for (const row of getDb().all<{ id: number }>(`SELECT id FROM atlas_nodes WHERE project_id = ? AND kind IN ('function','class','file','api') AND lower(name) LIKE ? AND (props_json NOT LIKE '%"historical":true%') ORDER BY length(name) LIMIT 4`, projectId, `%${term}%`)) push(row.id);
  }
  return out.slice(0, k * 2);
}

function graph(projectId: number, cls: Classification, seedsFromText: number[], k: number, at: string | null): Ranked {
  const wide = cls.type === "temporal" || cls.type === "multi-hop";
  const boundary = cls.releases.length > 1 ? cls.releases[0].id : null;
  const seeds = Array.from(new Set(cls.entities.length ? [...cls.entities.filter(node => node.id !== boundary).map(node => node.id), ...(wide && !cls.releases.length ? seedsFromText.slice(0, 2) : [])] : seedsFromText.slice(0, 3)));
  const window = cls.releases.length && cls.type === "temporal" ? releaseWindow(projectId, cls.releases) : null;
  const inWindow = (node: AtlasNode) => !window || !["commit", "pr"].includes(node.kind) || !node.validFrom || (node.validFrom > window.from && node.validFrom <= window.to);
  if (!seeds.length) return [];
  const allowed = GRAPH_EDGES[cls.type] && [...GRAPH_EDGES[cls.type]!, ...cls.relations];
  const hops = cls.type === "multi-hop" || cls.type === "temporal" ? 3 : cls.type === "relationship" ? 1 : 2;
  const scores = new Map<number, { score: number; facts: string[] }>();
  const seen = new Set(seeds);
  let frontier = seeds.map(id => ({ id, score: 1 }));
  for (const seed of seeds) scores.set(seed, { score: 1.5, facts: [] });
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const { id, score } of frontier) {
      const from = getNode(id);
      if (!from) continue;
      for (const edge of edgesOf(id, at)) {
        if (allowed && !allowed.includes(edge.kind)) continue;
        const other = getNode(edge.other);
        if (!other || !visibleAt(other, at) || !inWindow(other) || other.id === boundary) continue;
        if ((other.kind === "repo" || other.kind === "dependency") && cls.type !== "relationship") continue;
        if (other.kind === "person" && !/\bwho\b|author|owner/.test(cls.terms.join(" "))) continue;
        const fact = edge.direction === "out" ? `${from.kind} ${from.name} ─${edge.kind}→ ${other.kind} ${other.name}` : `${other.kind} ${other.name} ─${edge.kind}→ ${from.kind} ${from.name}`;
        const value = score * (cls.relations.includes(edge.kind) ? (depth === 0 ? 2.5 : 1) : 0.6);
        const entry = scores.get(other.id) ?? { score: 0, facts: [] };
        entry.score += value;
        if (entry.facts.length < 4) entry.facts.push(fact);
        scores.set(other.id, entry);
        if (!seen.has(other.id) && seen.size < 300) {
          seen.add(other.id);
          next.push({ id: other.id, score: value });
        }
      }
    }
    frontier = next;
  }
  for (const release of cls.releases) {
    for (const fact of releaseDiff(projectId, cls.releases.length > 1 ? cls.releases[0] : null, release)) {
      const entry = scores.get(fact.id) ?? { score: 0, facts: [] };
      entry.score += fact.fact.startsWith("PR") ? 2.5 : 1;
      if (entry.facts.length < 4) entry.facts.push(fact.fact);
      scores.set(fact.id, entry);
    }
  }
  return Array.from(scores).sort((a, b) => b[1].score - a[1].score).slice(0, k * 2).map(([id, entry]) => ({ ref: `node:${id}`, docId: null, nodeId: id, facts: entry.facts }));
}

/** (from, to] time window for a release question: between two releases, or since the release before a single one. */
function releaseWindow(projectId: number, releases: AtlasNode[]): { from: string; to: string } | null {
  const last = releases[releases.length - 1];
  if (!last.validFrom) return null;
  if (releases.length > 1 && releases[0].validFrom) return { from: releases[0].validFrom, to: last.validFrom };
  const previous = getDb().get<{ valid_from: string }>("SELECT valid_from FROM atlas_nodes WHERE project_id = ? AND kind = 'release' AND valid_from < ? ORDER BY valid_from DESC LIMIT 1", projectId, last.validFrom);
  return { from: previous?.valid_from ?? "", to: last.validFrom };
}

/** Commits and PRs that shipped in `to` (after `from` when given). */
export function releaseDiff(projectId: number, from: AtlasNode | null, to: AtlasNode): Array<{ id: number; fact: string }> {
  const releases = getDb().all<{ id: number; name: string; valid_from: string | null }>("SELECT id, name, valid_from FROM atlas_nodes WHERE project_id = ? AND kind = 'release' ORDER BY valid_from", projectId);
  const window = releases.filter(release => (!from || (release.valid_from ?? "") > (from.validFrom ?? "")) && (release.valid_from ?? "") <= (to.validFrom ?? ""));
  const targets = from ? window : window.filter(release => release.id === to.id);
  const out: Array<{ id: number; fact: string }> = [];
  for (const release of targets) {
    const rows = getDb().all<{ commit_id: number; pr_id: number | null; pr_name: string | null; subject: string }>(
      `SELECT c.id commit_id, p.id pr_id, p.name pr_name, json_extract(c.props_json, '$.subject') subject
       FROM atlas_edges r JOIN atlas_nodes c ON c.id = r.src
       LEFT JOIN atlas_edges i ON i.dst = c.id AND i.kind = 'includes'
       LEFT JOIN atlas_nodes p ON p.id = i.src AND p.kind = 'pr'
       WHERE r.dst = ? AND r.kind = 'released_in'`, release.id);
    for (const row of rows) {
      out.push({ id: row.commit_id, fact: `commit "${row.subject}" ─released_in→ release ${release.name}` });
      if (row.pr_id) out.push({ id: row.pr_id, fact: `${row.pr_name} ─shipped_in→ release ${release.name}: ${row.subject}` });
    }
  }
  return out;
}

function compress(text: string, queryTerms: string[], maxChars = 700): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (queryTerms.some(term => term.length >= 3 && lower.includes(term))) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep.add(j);
  });
  const picked = keep.size ? Array.from(keep).sort((a, b) => a - b).map(i => lines[i]) : lines.slice(0, 12);
  const out = picked.join("\n").trim();
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

function contextFor(node: AtlasNode | null, docMeta: Record<string, unknown>): string {
  if (!node) return "";
  const parts: string[] = [node.kind];
  if (node.kind === "function" || node.kind === "class" || node.kind === "file") {
    const file = node.kind === "file" ? node : edgesOf(node.id).map(edge => (edge.kind === "defines" && edge.direction === "in" ? getNode(edge.other) : null)).find(Boolean);
    const service = file && edgesOf(file.id).map(edge => (edge.kind === "contains" && edge.direction === "in" ? getNode(edge.other) : null)).find(other => other?.kind === "service");
    if (service) parts.push(`service ${service.name}`);
    if (node.path) parts.push(`${node.path}${node.props.line ? `:${node.props.line}` : ""}`);
  } else if (node.path) parts.push(node.path);
  if (node.validFrom) parts.push(`from ${node.validFrom.slice(0, 10)}`);
  if (typeof docMeta.section === "string") parts.push(`§ ${docMeta.section}`);
  return parts.join(" · ");
}

function materialize(item: Ranked[number], queryTerms: string[]): Hit | null {
  const db = getDb();
  type Row = { id: number; node_id: number | null; kind: string; title: string; path: string | null; text: string; meta_json: string; ts: string | null };
  let doc: Row | undefined;
  if (item.docId) doc = db.get<Row>("SELECT id, node_id, kind, title, path, text, meta_json, ts FROM atlas_docs WHERE id = ?", item.docId);
  else if (item.nodeId) {
    const docs = db.all<Row>("SELECT id, node_id, kind, title, path, text, meta_json, ts FROM atlas_docs WHERE node_id = ? LIMIT 12", item.nodeId);
    doc = docs.map(row => ({ row, score: queryTerms.filter(term => `${row.title} ${row.text}`.toLowerCase().includes(term)).length })).sort((a, b) => b.score - a.score)[0]?.row;
  }
  const node = item.nodeId ? getNode(item.nodeId) : doc?.node_id ? getNode(doc.node_id) : null;
  if (!doc && !node) return null;
  const facts = item.facts ?? [];
  const text = doc?.text ?? (facts.length ? facts.join("\n") : `${node!.kind} ${node!.name}`);
  return {
    ref: item.ref,
    docId: doc?.id ?? null,
    node,
    kind: node?.kind ?? doc!.kind,
    title: doc?.title ?? `${node!.kind} ${node!.name}`,
    path: doc?.path ?? node?.path ?? null,
    text,
    snippet: compress(text, queryTerms),
    context: contextFor(node, doc ? JSON.parse(doc.meta_json) : {}),
    ts: doc?.ts ?? node?.validFrom ?? null,
    score: 0,
    sources: [],
    facts,
  };
}

async function llmRerank(query: string, hits: Hit[], usage: LlmUsage): Promise<Hit[] | null> {
  const top = hits.slice(0, 15);
  const listing = top.map((hit, i) => `[${i}] ${hit.title}\n${hit.snippet.slice(0, 280)}`).join("\n\n");
  const order = await tryJson(
    [
      { role: "system", content: "You rank evidence for an engineering question. Reply with JSON {\"order\": [indices]} listing the most useful evidence first. Use only the given indices." },
      { role: "user", content: `Question: ${query}\n\nEvidence:\n${listing}` },
    ],
    usage,
    value => {
      const list = (value as { order?: unknown }).order;
      return Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < top.length) : null;
    },
    { maxTokens: 200 },
  );
  if (!order?.length) return null;
  const picked = Array.from(new Set(order)).map(i => top[i]);
  return [...picked, ...top.filter(hit => !picked.includes(hit)), ...hits.slice(15)];
}

export async function retrieve(projectId: number, query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
  const k = options.k ?? 10;
  const strategies = options.strategies ?? ["vector", "bm25", "symbol", "graph"];
  const cls = options.classification ?? classify(projectId, query);
  const at = options.at ?? cls.at;
  const timings: RetrievalResult["timings"] = {};
  const time = async <T>(name: keyof RetrievalResult["timings"], run: () => T | Promise<T>) => {
    const started = performance.now();
    const value = await run();
    timings[name] = Math.round((performance.now() - started) * 10) / 10;
    return value;
  };
  const lists: Partial<Record<Strategy, Ranked>> = {};
  let vectorBackend: RetrievalResult["vectorBackend"] = "none";
  if (strategies.includes("bm25") || strategies.includes("graph")) lists.bm25 = await time("bm25", () => bm25(projectId, cls, k));
  if (strategies.includes("vector")) {
    const result = await time("vector", () => vector(projectId, query, k));
    lists.vector = result.ranked;
    vectorBackend = result.backend;
  }
  if (strategies.includes("symbol")) lists.symbol = await time("symbol", () => symbol(projectId, cls, k));
  if (strategies.includes("graph")) {
    const textSeeds = (lists.bm25 ?? []).map(item => item.nodeId).filter((id): id is number => Boolean(id));
    lists.graph = await time("graph", () => graph(projectId, cls, textSeeds, k, at));
  }
  if (!strategies.includes("bm25")) delete lists.bm25;

  const fused = new Map<string, { item: Ranked[number]; score: number; sources: Set<Strategy> }>();
  const fuseStart = performance.now();
  for (const [strategy, ranked] of Object.entries(lists) as Array<[Strategy, Ranked]>) {
    const weight = strategies.length === 1 ? 1 : WEIGHTS[cls.type][strategy];
    const seenRefs = new Set<string>();
    let rank = 0;
    for (const item of ranked) {
      if (seenRefs.has(item.ref)) continue;
      seenRefs.add(item.ref);
      const entry = fused.get(item.ref) ?? { item, score: 0, sources: new Set<Strategy>() };
      entry.score += weight / (RRF_K + ++rank);
      entry.sources.add(strategy);
      if (item.facts?.length) entry.item = { ...entry.item, facts: [...(entry.item.facts ?? []), ...item.facts].slice(0, 6) };
      fused.set(item.ref, entry);
    }
  }
  const entityIds = new Set(cls.entities.map(node => node.id));
  const window = cls.releases.length && cls.type === "temporal" ? releaseWindow(projectId, cls.releases) : null;
  let hits: Hit[] = [];
  for (const entry of Array.from(fused.values()).sort((a, b) => b.score - a.score).slice(0, k * 3)) {
    const hit = materialize(entry.item, cls.terms);
    if (!hit) continue;
    if (at && ((hit.node && !visibleAt(hit.node, at)) || (hit.ts && hit.ts > at && hit.kind !== "service"))) continue;
    if (window && hit.node && ["commit", "pr"].includes(hit.node.kind) && hit.node.validFrom && !(hit.node.validFrom > window.from && hit.node.validFrom <= window.to)) continue;
    hit.score = entry.score * (hit.node && entityIds.has(hit.node.id) && cls.type !== "relationship" ? 1.15 : 1);
    hit.sources = Array.from(entry.sources);
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  timings.fusion = Math.round((performance.now() - fuseStart) * 10) / 10;

  let reranked = false;
  if ((options.rerank ?? loadConfig().atlas.rerank) && strategies.length > 1 && llmAvailable() && options.usage) {
    const result = await time("rerank", () => llmRerank(query, hits, options.usage!));
    if (result) {
      hits = result;
      reranked = true;
    }
  }
  return { query, classification: cls, hits: hits.slice(0, k), timings, vectorBackend, reranked };
}
