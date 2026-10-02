import { getDb } from "../core/db";

export type RepoAnalysis = {
  counts: { files: number; functions: number; classes: number; apis: number; tables: number; tests: number; dependencies: number; services: number; incidents: number };
  services: Array<{ name: string; path: string | null; callers: number; apis: number; tables: number; owner: string | null; incidents: number; tests: number }>;
  hotspots: Array<{ name: string; path: string | null; dependents: number }>;
  coverageGaps: string[];
  sharedTables: Array<{ table: string; writers: string[] }>;
  debt: Array<{ path: string; markers: number }>;
  risks: string[];
  summary: string;
};

const TEST_PATH = "(n.path LIKE '%test%' OR n.path LIKE '%spec%' OR n.path LIKE '%__tests__%')";

/** A deterministic read of the knowledge graph and context index. Every number is a count of what was indexed. */
export function analyzeRepository(projectId: number): RepoAnalysis {
  const db = getDb();
  const count = (kind: string, extra = "") => db.get<{ n: number }>(`SELECT COUNT(*) n FROM atlas_nodes n WHERE n.project_id = ? AND n.kind = ? AND n.valid_to IS NULL ${extra}`, projectId, kind)?.n ?? 0;
  const counts = { files: count("file"), functions: count("function"), classes: count("class"), apis: count("api"), tables: count("table"), tests: count("file", `AND ${TEST_PATH}`), dependencies: count("dependency"), services: count("service"), incidents: count("incident") };

  const services = db.all<{ id: number; name: string; path: string | null }>("SELECT id, name, path FROM atlas_nodes WHERE project_id = ? AND kind = 'service' AND valid_to IS NULL", projectId).map(service => {
    const edge = (sql: string) => db.get<{ n: number }>(sql, service.id)?.n ?? 0;
    return {
      name: service.name,
      path: service.path,
      callers: edge("SELECT COUNT(*) n FROM atlas_edges WHERE dst = ? AND kind = 'calls' AND valid_to IS NULL"),
      apis: edge("SELECT COUNT(*) n FROM atlas_edges WHERE src = ? AND kind = 'exposes' AND valid_to IS NULL"),
      tables: edge("SELECT COUNT(DISTINCT dst) n FROM atlas_edges WHERE src = ? AND kind IN ('writes', 'reads', 'owns_table') AND valid_to IS NULL"),
      owner: db.get<{ name: string }>("SELECT n.name FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'owned_by' LIMIT 1", service.id)?.name ?? null,
      incidents: edge("SELECT COUNT(DISTINCT e.src) n FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.src WHERE e.dst = ? AND n.kind = 'incident'"),
      tests: edge(`SELECT COUNT(*) n FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'contains' AND ${TEST_PATH}`),
    };
  }).sort((a, b) => b.callers * 3 + b.apis * 2 + b.tables - (a.callers * 3 + a.apis * 2 + a.tables));

  const hotspots = db.all<{ name: string; path: string | null; dependents: number }>(
    `SELECT n.name, n.path, COUNT(DISTINCT e.src) dependents FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.dst
     WHERE n.project_id = ? AND n.kind IN ('file', 'module', 'function', 'class') AND e.kind IN ('imports', 'calls', 'depends_on') AND e.valid_to IS NULL AND n.valid_to IS NULL
     GROUP BY n.id ORDER BY dependents DESC LIMIT 8`, projectId).filter(row => row.dependents > 1);

  const sharedTables = db.all<{ table_name: string; writers: string }>(
    `SELECT t.name table_name, GROUP_CONCAT(DISTINCT s.name) writers FROM atlas_edges e JOIN atlas_nodes s ON s.id = e.src JOIN atlas_nodes t ON t.id = e.dst
     WHERE t.project_id = ? AND t.kind = 'table' AND s.kind = 'service' AND e.kind = 'writes' AND e.valid_to IS NULL GROUP BY t.id HAVING COUNT(DISTINCT s.id) > 1`, projectId).map(row => ({ table: row.table_name, writers: row.writers.split(",") }));

  const debt = db.all<{ path: string; text: string }>("SELECT path, text FROM chunks WHERE project_id = ? AND source = 'code' AND (text LIKE '%TODO%' OR text LIKE '%FIXME%' OR text LIKE '%HACK%' OR text LIKE '%XXX%')", projectId)
    .reduce((acc, row) => acc.set(row.path, (acc.get(row.path) ?? 0) + (row.text.match(/\b(TODO|FIXME|HACK|XXX)\b/g)?.length ?? 0)), new Map<string, number>());
  const debtList = Array.from(debt, ([path, markers]) => ({ path, markers })).filter(item => item.markers > 0).sort((a, b) => b.markers - a.markers).slice(0, 8);

  const coverageGaps = services.filter(service => service.tests === 0).map(service => service.name);
  const risks: string[] = [];
  for (const service of services.slice(0, 10)) {
    if (service.incidents) risks.push(`${service.name} was involved in ${service.incidents} past incident${service.incidents === 1 ? "" : "s"}${service.tests ? "" : " and has no tests"}.`);
    else if (!service.tests && (service.callers || service.apis)) risks.push(`${service.name} has ${service.callers} caller${service.callers === 1 ? "" : "s"} and ${service.apis} API${service.apis === 1 ? "" : "s"} but no tests.`);
    if (!service.owner && counts.services > 1) risks.push(`${service.name} has no owner in CODEOWNERS.`);
  }
  for (const shared of sharedTables) risks.push(`Table ${shared.table} is written by ${shared.writers.length} services (${shared.writers.join(", ")}).`);
  if (counts.files && !counts.tests) risks.push("No test files were found in the repository.");

  const lines = [
    `## Architecture`,
    counts.services ? `${counts.services} service${counts.services === 1 ? "" : "s"}, ${counts.apis} APIs, ${counts.tables} tables, ${counts.files} files, ${counts.functions} functions, ${counts.classes} classes, ${counts.tests} test files.` : `${counts.files} files, ${counts.functions} functions, ${counts.classes} classes, ${counts.tests} test files.`,
    ...(services.length ? ["", "## Important services", ...services.slice(0, 6).map(service => `- ${service.name}: ${service.callers} callers, ${service.apis} APIs, ${service.tables} tables${service.owner ? `, owned by ${service.owner}` : ""}`)] : []),
    ...(hotspots.length ? ["", "## Dependency hotspots", ...hotspots.map(spot => `- ${spot.path ?? spot.name}: ${spot.dependents} dependents`)] : []),
    ...(coverageGaps.length ? ["", "## Test coverage gaps", ...coverageGaps.map(name => `- ${name} has no tests`)] : []),
    ...(debtList.length ? ["", "## Technical debt markers", ...debtList.map(item => `- ${item.path}: ${item.markers} TODO/FIXME`)] : []),
    ...(risks.length ? ["", "## Risks", ...risks.map(risk => `- ${risk}`)] : []),
  ];
  return { counts, services, hotspots, coverageGaps, sharedTables, debt: debtList, risks, summary: lines.join("\n") };
}
