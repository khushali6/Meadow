import { getDb } from "../core/db";

export const NODE_KINDS = ["repo", "service", "module", "file", "function", "class", "api", "table", "doc", "commit", "release", "pr", "issue", "incident", "person", "team", "infra", "pipeline", "dependency"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type AtlasNode = { id: number; kind: NodeKind; key: string; name: string; path: string | null; props: Record<string, unknown>; validFrom: string | null; validTo: string | null; source: string };
export type AtlasEdge = { id: number; src: number; dst: number; kind: string; props: Record<string, unknown>; validFrom: string | null; validTo: string | null };
export type AtlasDoc = { id: number; nodeId: number | null; kind: string; title: string; path: string | null; text: string; meta: Record<string, unknown>; ts: string | null };

type NodeRow = { id: number; kind: NodeKind; key: string; name: string; path: string | null; props_json: string; valid_from: string | null; valid_to: string | null; source: string };
type EdgeRow = { id: number; src: number; dst: number; kind: string; props_json: string; valid_from: string | null; valid_to: string | null };
type DocRow = { id: number; node_id: number | null; kind: string; title: string; path: string | null; text: string; meta_json: string; ts: string | null };

const toNode = (row: NodeRow): AtlasNode => ({ id: row.id, kind: row.kind, key: row.key, name: row.name, path: row.path, props: JSON.parse(row.props_json), validFrom: row.valid_from, validTo: row.valid_to, source: row.source });
const toEdge = (row: EdgeRow): AtlasEdge => ({ id: row.id, src: row.src, dst: row.dst, kind: row.kind, props: JSON.parse(row.props_json), validFrom: row.valid_from, validTo: row.valid_to });
const toDoc = (row: DocRow): AtlasDoc => ({ id: row.id, nodeId: row.node_id, kind: row.kind, title: row.title, path: row.path, text: row.text, meta: JSON.parse(row.meta_json), ts: row.ts });

/** "As of" filter: an item is visible at `at` when it started before and hasn't ended yet. */
export const visibleAt = (item: { validFrom: string | null; validTo: string | null }, at?: string | null) => !at || ((!item.validFrom || item.validFrom <= at) && (!item.validTo || item.validTo > at));

export class GraphWriter {
  private nodeIds = new Map<string, number>();
  constructor(readonly projectId: number) {}

  node(kind: NodeKind, key: string, name: string, extra: { path?: string | null; props?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null; source?: string } = {}): number {
    const fullKey = `${kind}:${key}`;
    const cached = this.nodeIds.get(fullKey);
    const db = getDb();
    if (cached) {
      if (extra.props || extra.validFrom || extra.validTo || extra.path) {
        const row = db.get<NodeRow>("SELECT * FROM atlas_nodes WHERE id = ?", cached)!;
        const props = { ...JSON.parse(row.props_json), ...(extra.props ?? {}) };
        const validFrom = [row.valid_from, extra.validFrom].filter(Boolean).sort()[0] ?? null;
        db.run("UPDATE atlas_nodes SET props_json = ?, valid_from = ?, valid_to = COALESCE(?, valid_to), path = COALESCE(path, ?) WHERE id = ?", JSON.stringify(props), validFrom, extra.validTo ?? null, extra.path ?? null, cached);
      }
      return cached;
    }
    const existing = db.get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", this.projectId, fullKey);
    const id = existing?.id ?? db.insert("atlas_nodes", { project_id: this.projectId, kind, key: fullKey, name, path: extra.path ?? null, props_json: JSON.stringify(extra.props ?? {}), valid_from: extra.validFrom ?? null, valid_to: extra.validTo ?? null, source: extra.source ?? "local" });
    this.nodeIds.set(fullKey, id);
    return id;
  }

  find(kind: NodeKind, key: string): number | null {
    const fullKey = `${kind}:${key}`;
    const cached = this.nodeIds.get(fullKey);
    if (cached) return cached;
    const row = getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", this.projectId, fullKey);
    if (row) this.nodeIds.set(fullKey, row.id);
    return row?.id ?? null;
  }

  edge(src: number, dst: number, kind: string, extra: { props?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null } = {}) {
    if (src === dst) return;
    getDb().run("INSERT INTO atlas_edges (project_id, src, dst, kind, props_json, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(src, dst, kind) DO UPDATE SET valid_from = COALESCE(MIN(atlas_edges.valid_from, excluded.valid_from), excluded.valid_from, atlas_edges.valid_from)", this.projectId, src, dst, kind, JSON.stringify(extra.props ?? {}), extra.validFrom ?? null, extra.validTo ?? null);
  }

  doc(nodeId: number | null, kind: string, title: string, text: string, extra: { path?: string | null; meta?: Record<string, unknown>; ts?: string | null } = {}): number {
    return getDb().insert("atlas_docs", { project_id: this.projectId, node_id: nodeId, kind, title, path: extra.path ?? null, text, meta_json: JSON.stringify(extra.meta ?? {}), ts: extra.ts ?? null });
  }
}

export function clearProjectGraph(projectId: number, source?: string) {
  const db = getDb();
  if (source) {
    db.run("DELETE FROM atlas_docs WHERE project_id = ? AND node_id IN (SELECT id FROM atlas_nodes WHERE project_id = ? AND source = ?)", projectId, projectId, source);
    db.run("DELETE FROM atlas_nodes WHERE project_id = ? AND source = ?", projectId, source);
    return;
  }
  db.run("DELETE FROM atlas_docs WHERE project_id = ?", projectId);
  db.run("DELETE FROM atlas_edges WHERE project_id = ?", projectId);
  db.run("DELETE FROM atlas_nodes WHERE project_id = ?", projectId);
}

export function getNode(id: number): AtlasNode | null {
  const row = getDb().get<NodeRow>("SELECT * FROM atlas_nodes WHERE id = ?", id);
  return row ? toNode(row) : null;
}

export function nodesByKind(projectId: number, kinds: NodeKind[], limit = 5000): AtlasNode[] {
  if (!kinds.length) return [];
  return getDb().all<NodeRow>(`SELECT * FROM atlas_nodes WHERE project_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY kind, name LIMIT ?`, projectId, ...kinds, limit).map(toNode);
}

export function findNodes(projectId: number, name: string, kinds?: NodeKind[], limit = 20): AtlasNode[] {
  const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  const exact = getDb().all<NodeRow>(`SELECT * FROM atlas_nodes WHERE project_id = ? AND lower(name) = lower(?)${kindSql} LIMIT ?`, projectId, name, ...(kinds ?? []), limit);
  if (exact.length) return exact.map(toNode);
  return getDb().all<NodeRow>(`SELECT * FROM atlas_nodes WHERE project_id = ? AND (lower(name) LIKE lower(?) OR lower(key) LIKE lower(?))${kindSql} ORDER BY length(name) LIMIT ?`, projectId, `%${name}%`, `%${name}%`, ...(kinds ?? []), limit).map(toNode);
}

export function edgesOf(nodeId: number, at?: string | null): Array<AtlasEdge & { direction: "out" | "in"; other: number }> {
  const rows = getDb().all<EdgeRow>("SELECT * FROM atlas_edges WHERE src = ? OR dst = ?", nodeId, nodeId).map(toEdge);
  return rows.filter(edge => visibleAt(edge, at)).map(edge => ({ ...edge, direction: edge.src === nodeId ? "out" as const : "in" as const, other: edge.src === nodeId ? edge.dst : edge.src }));
}

export type Neighborhood = { nodes: AtlasNode[]; edges: AtlasEdge[] };

/** Breadth-first expansion up to `hops`, optionally restricted to edge kinds and a point in time. */
export function neighborhood(seeds: number[], hops = 2, options: { edgeKinds?: string[]; at?: string | null; limit?: number } = {}): Neighborhood {
  const seen = new Set<number>(seeds);
  const edges = new Map<number, AtlasEdge>();
  let frontier = [...seeds];
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const edge of edgesOf(id, options.at)) {
        if (options.edgeKinds && !options.edgeKinds.includes(edge.kind)) continue;
        edges.set(edge.id, edge);
        if (!seen.has(edge.other)) {
          seen.add(edge.other);
          next.push(edge.other);
        }
        if (seen.size >= (options.limit ?? 400)) break;
      }
    }
    frontier = next;
  }
  const nodes = Array.from(seen).map(getNode).filter((node): node is AtlasNode => Boolean(node) && visibleAt(node!, options.at));
  const ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: Array.from(edges.values()).filter(edge => ids.has(edge.src) && ids.has(edge.dst)) };
}

export type PathStep = { node: AtlasNode; via: { kind: string; direction: "out" | "in" } | null };

/** Shortest undirected path between two nodes (BFS), used to explain how entities connect. */
export function shortestPath(from: number, to: number, options: { maxHops?: number; at?: string | null; avoidKinds?: NodeKind[] } = {}): PathStep[] | null {
  if (from === to) return [{ node: getNode(from)!, via: null }];
  const prev = new Map<number, { id: number; kind: string; direction: "out" | "in" }>();
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 0; depth < (options.maxHops ?? 6) && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const edge of edgesOf(id, options.at)) {
        if (seen.has(edge.other)) continue;
        if (options.avoidKinds?.length && edge.other !== to) {
          const kind = getDb().get<{ kind: NodeKind }>("SELECT kind FROM atlas_nodes WHERE id = ?", edge.other)?.kind;
          if (kind && options.avoidKinds.includes(kind)) continue;
        }
        seen.add(edge.other);
        prev.set(edge.other, { id, kind: edge.kind, direction: edge.direction });
        if (edge.other === to) {
          const steps: PathStep[] = [];
          let cursor = to;
          while (cursor !== from) {
            const step = prev.get(cursor)!;
            steps.unshift({ node: getNode(cursor)!, via: { kind: step.kind, direction: step.direction } });
            cursor = step.id;
          }
          steps.unshift({ node: getNode(from)!, via: null });
          return steps;
        }
        next.push(edge.other);
      }
    }
    frontier = next;
  }
  return null;
}

export function describePath(path: PathStep[]): string {
  return path.map((step, i) => (i === 0 ? `${step.node.kind}:${step.node.name}` : ` ${step.via!.direction === "out" ? `─${step.via!.kind}→` : `←${step.via!.kind}─`} ${step.node.kind}:${step.node.name}`)).join("");
}

export function docsForNodes(nodeIds: number[], limit = 50): AtlasDoc[] {
  if (!nodeIds.length) return [];
  return getDb().all<DocRow>(`SELECT id, node_id, kind, title, path, text, meta_json, ts FROM atlas_docs WHERE node_id IN (${nodeIds.map(() => "?").join(",")}) LIMIT ?`, ...nodeIds, limit).map(toDoc);
}

export function getDoc(id: number): AtlasDoc | null {
  const row = getDb().get<DocRow>("SELECT id, node_id, kind, title, path, text, meta_json, ts FROM atlas_docs WHERE id = ?", id);
  return row ? toDoc(row) : null;
}

export function graphStats(projectId: number) {
  const db = getDb();
  const nodes = db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) n FROM atlas_nodes WHERE project_id = ? GROUP BY kind", projectId);
  const edges = db.get<{ n: number }>("SELECT COUNT(*) n FROM atlas_edges WHERE project_id = ?", projectId)?.n ?? 0;
  const docs = db.get<{ n: number; e: number }>("SELECT COUNT(*) n, SUM(embedding IS NOT NULL) e FROM atlas_docs WHERE project_id = ?", projectId);
  const ingest = db.get<{ stats_json: string; finished_at: string }>("SELECT stats_json, finished_at FROM atlas_ingests WHERE project_id = ?", projectId);
  return { nodes: Object.fromEntries(nodes.map(row => [row.kind, row.n])), edges, docs: docs?.n ?? 0, embedded: docs?.e ?? 0, lastIngest: ingest ? { at: ingest.finished_at, ...JSON.parse(ingest.stats_json) } : null };
}

export function setEmbedding(docId: number, vector: number[], space: string) {
  getDb().run("UPDATE atlas_docs SET embedding = ?, embedding_space = ? WHERE id = ?", new Uint8Array(new Float32Array(vector).buffer), space, docId);
}

/** Stored vectors from one embedding space. Vectors from other spaces are never mixed into a search. */
export function allEmbeddings(projectId: number, space: string): Array<{ id: number; vector: Float32Array }> {
  return getDb().all<{ id: number; embedding: Uint8Array }>("SELECT id, embedding FROM atlas_docs WHERE project_id = ? AND embedding IS NOT NULL AND embedding_space = ?", projectId, space).map(row => ({ id: row.id, vector: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4) }));
}
