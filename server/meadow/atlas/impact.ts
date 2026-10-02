import { getDb } from "../core/db";
import { edgesOf, getNode, type AtlasNode } from "./store";

/** Edges where the source depends on the target: if the target changes, the source may break. */
const DEPENDENT_EDGES = new Set(["calls", "imports", "reads", "writes", "implements", "handles", "depends_on", "includes", "deploys", "deployed_as", "runs_on"]);
/** Edges from a container to what it holds: a change inside affects the container. */
const CONTAINER_EDGES = new Set(["contains", "defines"]);
/** Edges from a node to what it exposes or produces: the target changes with it. */
const EXPOSE_EDGES = new Set(["exposes", "owns_table", "writes"]);
const IMPACT_KINDS = new Set(["service", "module", "file", "function", "class", "api", "table", "infra", "pipeline"]);

export type ImpactItem = { id: number; kind: string; name: string; path: string | null; depth: number; via: string; score: number };
export type ImpactReport = {
  seeds: Array<{ id: number; kind: string; name: string }>;
  impacted: ImpactItem[];
  services: string[];
  apis: string[];
  tables: string[];
  owners: string[];
  incidents: Array<{ id: number; name: string }>;
  tests: string[];
  risk: "low" | "medium" | "high";
  reasons: string[];
  edges: Array<[number, number]>;
};

const isTestPath = (value: string | null) => Boolean(value && /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i.test(value));

/** Graph nodes for changed files: the file node itself, or anything with that path. */
export function nodesForPaths(projectId: number, paths: string[]): AtlasNode[] {
  const out = new Map<number, AtlasNode>();
  for (const raw of paths.slice(0, 50)) {
    const file = raw.replace(/^\.\//, "");
    const rows = getDb().all<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND path = ? AND kind IN ('file', 'module', 'service') AND valid_to IS NULL LIMIT 5", projectId, file);
    for (const row of rows) {
      const node = getNode(row.id);
      if (node) out.set(node.id, node);
    }
  }
  return Array.from(out.values());
}

/**
 * What a change to the seed nodes can affect, walking dependents up to `maxDepth` hops. Each
 * result says which relation led to it. No model involved: the answer is a graph traversal.
 */
export function changeImpact(seedIds: number[], maxDepth = 3): ImpactReport {
  const seeds = seedIds.map(id => getNode(id)).filter((node): node is AtlasNode => Boolean(node));
  const seen = new Map<number, ImpactItem>();
  const edges: Array<[number, number]> = [];
  let frontier = seeds.map(node => node.id);
  for (const node of seeds) seen.set(node.id, { id: node.id, kind: node.kind, name: node.name, path: node.path, depth: 0, via: "changed", score: 1 });
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const current = getNode(id);
      if (!current) continue;
      for (const edge of edgesOf(id)) {
        if (edge.validTo) continue;
        const affected = (edge.direction === "in" && (DEPENDENT_EDGES.has(edge.kind) || CONTAINER_EDGES.has(edge.kind))) || (edge.direction === "out" && EXPOSE_EDGES.has(edge.kind));
        if (!affected || seen.has(edge.other)) continue;
        const other = getNode(edge.other);
        if (!other || !IMPACT_KINDS.has(other.kind)) continue;
        const via = edge.direction === "in" ? `${other.name} ─${edge.kind}→ ${current.name}` : `${current.name} ─${edge.kind}→ ${other.name}`;
        seen.set(other.id, { id: other.id, kind: other.kind, name: other.name, path: other.path, depth, via, score: Number((1 / (depth + 1)).toFixed(3)) });
        edges.push([current.id, other.id]);
        next.push(other.id);
      }
    }
    frontier = next.slice(0, 400);
  }
  const impacted = Array.from(seen.values()).filter(item => item.depth > 0).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  const all = [...seeds.map(node => seen.get(node.id)!), ...impacted];
  const byKind = (kind: string) => Array.from(new Set(all.filter(item => item.kind === kind).map(item => item.name)));
  const services = all.filter(item => item.kind === "service").map(item => item.id);
  const owners = new Set<string>();
  const incidents = new Map<number, string>();
  for (const id of services) {
    for (const edge of edgesOf(id)) {
      const other = getNode(edge.other);
      if (!other) continue;
      if (edge.kind === "owned_by" && edge.direction === "out") owners.add(other.name);
      if (other.kind === "incident" && (edge.kind === "affects" || edge.kind === "mentions")) incidents.set(other.id, other.name);
    }
  }
  const tests = Array.from(new Set(all.filter(item => isTestPath(item.path)).map(item => item.path!)));
  const reasons: string[] = [];
  const serviceNames = byKind("service");
  if (serviceNames.length > 1) reasons.push(`Crosses ${serviceNames.length} services: ${serviceNames.slice(0, 5).join(", ")}`);
  if (byKind("api").length) reasons.push(`Touches ${byKind("api").length} public API${byKind("api").length === 1 ? "" : "s"}`);
  if (byKind("table").length) reasons.push(`Touches data in ${byKind("table").join(", ")}`);
  if (incidents.size) reasons.push(`${incidents.size} past incident${incidents.size === 1 ? "" : "s"} involved these services`);
  if (!tests.length && impacted.length) reasons.push("No tests found among the affected code");
  const weight = (serviceNames.length > 1 ? 2 : 0) + (byKind("api").length ? 1 : 0) + (byKind("table").length ? 1 : 0) + (incidents.size ? 1 : 0) + (!tests.length && impacted.length ? 1 : 0);
  return {
    seeds: seeds.map(node => ({ id: node.id, kind: node.kind, name: node.name })),
    impacted,
    services: serviceNames,
    apis: byKind("api"),
    tables: byKind("table"),
    owners: Array.from(owners),
    incidents: Array.from(incidents, ([id, name]) => ({ id, name })),
    tests,
    risk: weight >= 3 ? "high" : weight >= 1 ? "medium" : "low",
    reasons,
    edges,
  };
}
