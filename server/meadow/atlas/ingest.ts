import fs from "node:fs";
import path from "node:path";
import { getDb, now } from "../core/db";
import { git } from "../core/git";
import { containsSecret } from "../core/redact";
import { getProject } from "../projects";
import { listProjectFiles } from "../rag/index";
import { ingestConnectors } from "./connectors";
import { tryEmbed } from "./llm";
import { extractImports, extractRoutes, extractSymbols, extractTables, markdownSections, nameVariants, parseCompose, parseFrontMatter, parseOpenApi, parseTerraform, tableRefs } from "./parse";
import { clearProjectGraph, GraphWriter, setEmbedding } from "./store";

const MAX_FILE_BYTES = 300_000;
const SERVICE_MARKERS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Dockerfile", "pom.xml", "Cargo.toml"];

export type IngestStats = { files: number; services: number; functions: number; apis: number; tables: number; commits: number; releases: number; incidents: number; docs: number; embedded: number; connectors: string[]; ms: number };
export type IngestProgress = (step: string, detail?: string) => void;

function detectServices(root: string, files: string[]): Map<string, string> {
  const dirs = new Map<string, string>();
  const markerDirs = new Set(files.filter(file => SERVICE_MARKERS.includes(path.basename(file))).map(file => path.dirname(file)).filter(dir => dir !== "." && dir.split("/").length <= 3));
  for (const dir of markerDirs) {
    if (Array.from(markerDirs).some(other => other !== dir && dir.startsWith(`${other}/`))) continue;
    dirs.set(dir, path.basename(dir));
  }
  for (const file of files) {
    const match = file.match(/^(services|apps|packages|cmd)\/([^/]+)\//);
    if (match && !Array.from(dirs.keys()).some(dir => file.startsWith(`${dir}/`))) dirs.set(`${match[1]}/${match[2]}`, match[2]);
  }
  if (!dirs.size) dirs.set(".", path.basename(root));
  return dirs;
}

function serviceOf(file: string, services: Map<string, string>): string | null {
  let best: string | null = null;
  for (const dir of services.keys()) if ((dir === "." || file.startsWith(`${dir}/`)) && (!best || dir.length > best.length)) best = dir;
  return best;
}

function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`, `${base}.py`]) if (files.has(candidate)) return candidate;
  return null;
}

async function gitLines(root: string, ...args: string[]) {
  try {
    return await git(root, ...args);
  } catch {
    return "";
  }
}

export async function ingestProject(projectId: number, onProgress: IngestProgress = () => undefined): Promise<IngestStats> {
  const started = Date.now();
  const project = getProject(projectId);
  const root = project.path;
  const db = getDb();
  const stats: IngestStats = { files: 0, services: 0, functions: 0, apis: 0, tables: 0, commits: 0, releases: 0, incidents: 0, docs: 0, embedded: 0, connectors: [], ms: 0 };
  onProgress("scan", "Listing files");
  const files = listProjectFiles(root, /(\.tf|^Dockerfile|^CODEOWNERS)$/).filter(file => !/^(PLAN|SPEC)\.md$|^\.atlas\/eval\.json$|^\.meadow\//.test(file));
  const fileSet = new Set(files);
  const texts = new Map<string, string>();
  for (const file of files) {
    try {
      const full = path.join(root, file);
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\0") || containsSecret(text)) continue;
      texts.set(file, text);
    } catch {
      continue;
    }
  }

  db.raw.exec("BEGIN");
  try {
    clearProjectGraph(projectId);
    const g = new GraphWriter(projectId);
    const repo = g.node("repo", project.name, project.name, { path: ".", props: { root } });

    // Services and files.
    onProgress("services", "Detecting services");
    const services = detectServices(root, files);
    const serviceIds = new Map<string, number>();
    for (const [dir, name] of services) {
      const id = g.node("service", name, name, { path: dir });
      serviceIds.set(dir, id);
      g.edge(repo, id, "contains");
    }
    stats.services = services.size;

    // Tables first so code references can link to them.
    const tableIds = new Map<string, number>();
    for (const [file, text] of texts) {
      if (!/\.(sql|prisma)$/.test(file) && !/migrations?\//.test(file)) continue;
      for (const table of extractTables(text)) {
        const id = g.node("table", table.name, table.name, { path: file, props: { columns: table.columns } });
        tableIds.set(table.name, id);
        g.doc(id, "table", `Table ${table.name} (${file})`, table.ddl, { path: file });
        const svc = serviceOf(file, services);
        if (svc) g.edge(serviceIds.get(svc)!, id, "owns_table");
      }
    }
    stats.tables = tableIds.size;
    const knownTables = new Set(tableIds.keys());

    onProgress("code", `Parsing ${texts.size} files`);
    const functionIds = new Map<string, Array<{ id: number; service: string | null }>>();
    const fileIds = new Map<string, number>();
    const symbolsByFile = new Map<string, ReturnType<typeof extractSymbols>>();
    for (const [file, text] of texts) {
      const svc = serviceOf(file, services);
      const fileId = g.node("file", file, path.basename(file), { path: file, props: { lines: text.split("\n").length } });
      fileIds.set(file, fileId);
      if (svc) g.edge(serviceIds.get(svc)!, fileId, "contains");
      const symbols = extractSymbols(file, text);
      symbolsByFile.set(file, symbols);
      for (const symbol of symbols) {
        const id = g.node(symbol.kind, `${file}#${symbol.name}:${symbol.line}`, symbol.name, { path: file, props: { line: symbol.line, endLine: symbol.endLine, exported: symbol.exported } });
        g.edge(fileId, id, "defines");
        g.doc(id, "code", `${symbol.kind} ${symbol.name} (${file}:${symbol.line})`, symbol.body, { path: file, meta: { line: symbol.line, service: svc ? services.get(svc) : null } });
        const list = functionIds.get(symbol.name) ?? [];
        list.push({ id, service: svc });
        functionIds.set(symbol.name, list);
        if (symbol.kind === "function") stats.functions += 1;
        for (const ref of tableRefs(symbol.body, knownTables)) {
          g.edge(id, tableIds.get(ref.table)!, ref.write ? "writes" : "reads");
          if (svc) g.edge(serviceIds.get(svc)!, tableIds.get(ref.table)!, ref.write ? "writes" : "reads");
        }
      }
      if (!symbols.length && !/\.md$/.test(file)) {
        const head = text.split("\n").slice(0, 80).join("\n");
        if (head.trim().length > 40) g.doc(fileId, "file", file, head, { path: file, meta: { service: svc ? services.get(svc) : null } });
        for (const ref of tableRefs(text, knownTables)) if (svc) g.edge(serviceIds.get(svc)!, tableIds.get(ref.table)!, ref.write ? "writes" : "reads");
      }
      for (const route of extractRoutes(text)) {
        const apiId = g.node("api", `${route.method} ${route.path}`, `${route.method} ${route.path}`, { path: file, props: { line: route.line } });
        if (svc) g.edge(serviceIds.get(svc)!, apiId, "exposes");
        g.edge(fileId, apiId, "handles");
        const handler = symbols.filter(symbol => symbol.line <= route.line + 3).at(-1) ?? symbols.find(symbol => symbol.line >= route.line);
        if (handler) {
          const handlerId = g.find(handler.kind, `${file}#${handler.name}:${handler.line}`);
          if (handlerId) g.edge(handlerId, apiId, "implements");
        }
        g.doc(apiId, "api", `API ${route.method} ${route.path}`, `${route.method} ${route.path} is handled in ${file}:${route.line}${svc ? ` (service ${services.get(svc)})` : ""}.`, { path: file });
      }
    }

    // Imports and calls.
    for (const [file, text] of texts) {
      const fileId = fileIds.get(file)!;
      for (const spec of extractImports(file, text)) {
        const target = resolveImport(file, spec, fileSet);
        if (target && fileIds.has(target)) g.edge(fileId, fileIds.get(target)!, "imports");
      }
      const svc = serviceOf(file, services);
      for (const symbol of symbolsByFile.get(file) ?? []) {
        const callerId = g.find(symbol.kind, `${file}#${symbol.name}:${symbol.line}`);
        if (!callerId) continue;
        let added = 0;
        for (const match of symbol.body.split("\n").slice(1).join("\n").matchAll(/\b([A-Za-z_]\w{2,})\s*\(/g)) {
          const candidates = functionIds.get(match[1]);
          if (!candidates || candidates.length > 3) continue;
          const target = candidates.find(c => c.service === svc) ?? candidates[0];
          if (target.id !== callerId) g.edge(callerId, target.id, "calls");
          if (++added >= 25) break;
        }
      }
    }

    // Service-to-service calls from URLs, env names and compose.
    const variants = new Map(Array.from(services).map(([dir, name]) => [dir, nameVariants(name)]));
    for (const [file, text] of texts) {
      const from = serviceOf(file, services);
      if (!from || /\.(md|ya?ml)$/.test(file)) continue;
      const lower = text.toLowerCase();
      for (const [dir, names] of variants) {
        if (dir === from) continue;
        if (names.some(name => lower.includes(`http://${name}`) || lower.includes(`https://${name}`) || lower.includes(`${name.replace(/-/g, "_")}_url`) || lower.includes(`${name.replace(/-/g, "_")}_host`) || new RegExp(`['"\`/]${name}['"\`/:]`).test(lower))) g.edge(serviceIds.get(from)!, serviceIds.get(dir)!, "calls");
      }
    }
    for (const [file, text] of texts) {
      if (!/(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/.test(file)) continue;
      for (const svc of parseCompose(text)) {
        const fromDir = Array.from(services).find(([, name]) => nameVariants(name).includes(svc.name.toLowerCase()))?.[0];
        const infra = g.node("infra", `compose:${svc.name}`, svc.name, { path: file, props: { image: svc.image } });
        if (fromDir) g.edge(serviceIds.get(fromDir)!, infra, "deployed_as");
        for (const dep of svc.dependsOn) {
          const depDir = Array.from(services).find(([, name]) => nameVariants(name).includes(dep.toLowerCase()))?.[0];
          if (fromDir && depDir) g.edge(serviceIds.get(fromDir)!, serviceIds.get(depDir)!, "calls");
          else g.edge(infra, g.node("infra", `compose:${dep}`, dep, { path: file }), "depends_on");
        }
      }
    }

    // Specs, infrastructure, CI, ownership, dependencies.
    onProgress("specs", "Reading API specs, infrastructure and CI");
    for (const [file, text] of texts) {
      const svc = serviceOf(file, services);
      if (/(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(file)) {
        for (const op of parseOpenApi(text)) {
          const apiId = g.node("api", `${op.method} ${op.path}`, `${op.method} ${op.path}`, { path: file, props: { summary: op.summary, spec: true } });
          if (svc) g.edge(serviceIds.get(svc)!, apiId, "exposes");
          g.doc(apiId, "api", `API ${op.method} ${op.path}`, `${op.method} ${op.path}: ${op.summary || "no summary"} (spec ${file})`, { path: file });
        }
      }
      if (/\.tf$/.test(file)) {
        for (const resource of parseTerraform(text)) {
          const id = g.node("infra", `tf:${resource.type}.${resource.name}`, `${resource.type}.${resource.name}`, { path: file });
          g.edge(repo, id, "provisions");
          for (const [dir, names] of variants) if (names.some(name => resource.name.toLowerCase().includes(name.replace(/-service$/, "")))) g.edge(serviceIds.get(dir)!, id, "runs_on");
          for (const [table, tableId] of tableIds) if (resource.name.toLowerCase().includes(table)) g.edge(tableId, id, "stored_in");
        }
        g.doc(null, "infra", `Terraform ${file}`, text.slice(0, 3000), { path: file });
      }
      if (/^\.github\/workflows\/.+\.ya?ml$/.test(file)) {
        const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? path.basename(file);
        const id = g.node("pipeline", file, name, { path: file });
        g.edge(repo, id, "has_pipeline");
        for (const [dir, names] of variants) if (names.some(name => text.toLowerCase().includes(name))) g.edge(id, serviceIds.get(dir)!, "deploys");
        g.doc(id, "pipeline", `CI pipeline ${name}`, text.slice(0, 3000), { path: file });
      }
      if (/(^|\/)package\.json$/.test(file) && svc) {
        try {
          const pkg = JSON.parse(text) as { dependencies?: Record<string, string> };
          for (const [dep, version] of Object.entries(pkg.dependencies ?? {}).slice(0, 40)) g.edge(serviceIds.get(svc)!, g.node("dependency", `npm:${dep}`, dep, { props: { version } }), "depends_on");
        } catch {
          // malformed package.json
        }
      }
      if (/(^|\/)requirements\.txt$/.test(file) && svc) {
        for (const line of text.split("\n").slice(0, 60)) {
          const dep = line.trim().match(/^([A-Za-z0-9_.-]+)/)?.[1];
          if (dep && !line.startsWith("#")) g.edge(serviceIds.get(svc)!, g.node("dependency", `pypi:${dep.toLowerCase()}`, dep), "depends_on");
        }
      }
      if (/(^|\/)CODEOWNERS$/.test(file)) {
        for (const line of text.split("\n")) {
          const [pattern, ...owners] = line.trim().split(/\s+/);
          if (!pattern || pattern.startsWith("#") || !owners.length) continue;
          const prefix = pattern.replace(/^\//, "").replace(/\*+$/, "").replace(/\/$/, "");
          for (const owner of owners) {
            const team = g.node("team", owner, owner.replace(/^@/, ""));
            for (const [dir, id] of serviceIds) if (dir === "." ? prefix === "" : dir.startsWith(prefix) || prefix.startsWith(dir)) g.edge(id, team, "owned_by");
          }
        }
      }
    }

    // Documentation.
    onProgress("docs", "Indexing documentation");
    const mentionTargets: Array<{ id: number; names: string[] }> = [
      ...Array.from(services, ([dir, name]) => ({ id: serviceIds.get(dir)!, names: nameVariants(name) })),
      ...Array.from(tableIds, ([name, id]) => ({ id, names: name.length >= 4 ? [name] : [] })),
    ];
    for (const [file, text] of texts) {
      if (!/\.(md|mdx|txt)$/.test(file) || /(^|\/)incidents?\//.test(file)) continue;
      const docNode = g.node("doc", file, path.basename(file), { path: file });
      const svc = serviceOf(file, services);
      if (svc && svc !== ".") g.edge(docNode, serviceIds.get(svc)!, "documents");
      for (const section of markdownSections(text)) {
        g.doc(docNode, "doc", `${file} › ${section.heading}`, section.body.slice(0, 4000), { path: file, meta: { section: section.heading } });
        stats.docs += 1;
        const lower = `${section.heading}\n${section.body}`.toLowerCase();
        for (const target of mentionTargets) if (target.names.some(name => lower.includes(name))) g.edge(docNode, target.id, "mentions");
      }
    }

    // Incidents (local markdown/yaml with front matter).
    const releaseIds = new Map<string, number>();
    const incidentFiles = Array.from(texts.keys()).filter(file => /(^|\/)(incidents?|postmortems?)\/[^/]+\.(md|ya?ml)$/i.test(file));
    const pendingIncidentLinks: Array<{ id: number; release: string }> = [];
    for (const file of incidentFiles) {
      const { meta, body } = parseFrontMatter(texts.get(file)!);
      const key = String(meta.id ?? path.basename(file).replace(/\.\w+$/, ""));
      const date = typeof meta.date === "string" ? meta.date : null;
      const id = g.node("incident", key, meta.title ? `${key}: ${meta.title}` : key, { path: file, validFrom: date, props: { severity: meta.severity ?? null, status: meta.status ?? null, date } });
      stats.incidents += 1;
      const affected = Array.isArray(meta.services) ? meta.services : typeof meta.services === "string" ? [meta.services] : [];
      for (const name of affected) {
        const dir = Array.from(services).find(([, svcName]) => nameVariants(svcName).includes(name.toLowerCase()))?.[0];
        if (dir) g.edge(id, serviceIds.get(dir)!, "affects", { validFrom: date });
      }
      if (typeof meta.release === "string") pendingIncidentLinks.push({ id, release: meta.release });
      g.doc(id, "incident", `Incident ${key}: ${meta.title ?? ""}`.trim(), body.slice(0, 5000), { path: file, ts: date, meta: { severity: meta.severity ?? null, services: affected } });
      const lower = body.toLowerCase();
      for (const target of mentionTargets) if (target.names.some(name => lower.includes(name))) g.edge(id, target.id, "mentions");
    }

    // Git history: commits, authors, releases, PR references, file lifetimes.
    onProgress("git", "Reading git history");
    const log = await gitLines(root, "log", "--date=iso-strict", "--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%ad%x1f%s", "--name-status", "-n", "800");
    const commitIds = new Map<string, number>();
    for (const entry of log.split("\x1e").map(part => part.trim()).filter(Boolean)) {
      const [header, ...fileLines] = entry.split("\n");
      const [sha, author, email, date, subject] = header.split("\x1f");
      if (!sha) continue;
      const commitId = g.node("commit", sha, `${sha.slice(0, 7)} ${subject.slice(0, 60)}`, { validFrom: date, props: { sha, subject, author, date } });
      commitIds.set(sha, commitId);
      stats.commits += 1;
      const person = g.node("person", email || author, author);
      g.edge(person, commitId, "authored", { validFrom: date });
      const touched = new Set<string>();
      const changed: string[] = [];
      for (const line of fileLines) {
        const [status, filePath, renamed] = line.split("\t");
        const target = renamed ?? filePath;
        if (!target) continue;
        changed.push(`${status} ${target}`);
        const fileId = fileIds.get(target) ?? (texts.has(target) ? null : g.node("file", target, path.basename(target), { path: target, props: { historical: true } }));
        if (fileId) {
          g.edge(commitId, fileId, "modifies", { validFrom: date });
          if (status?.startsWith("A")) g.node("file", target, path.basename(target), { validFrom: date });
          if (status === "D") getDb().run("UPDATE atlas_nodes SET valid_to = COALESCE(valid_to, ?) WHERE id = ?", date, fileId);
        }
        const svc = serviceOf(target, services);
        if (svc) touched.add(svc);
      }
      for (const svc of touched) g.edge(commitId, serviceIds.get(svc)!, "changes", { validFrom: date });
      const pr = subject.match(/(?:pull request|PR)\s*#(\d+)|\(#(\d+)\)/i);
      if (pr) {
        const number = pr[1] ?? pr[2];
        const prId = g.node("pr", `#${number}`, `PR #${number}`, { validFrom: date, props: { number: Number(number), title: subject } });
        g.edge(prId, commitId, "includes", { validFrom: date });
        for (const svc of touched) g.edge(prId, serviceIds.get(svc)!, "changes", { validFrom: date });
        g.edge(person, prId, "authored", { validFrom: date });
      }
      g.doc(commitId, "commit", `Commit ${sha.slice(0, 7)}: ${subject}`, `${subject}\nAuthor: ${author}\nDate: ${date}\nFiles:\n${changed.slice(0, 40).join("\n")}`, { ts: date, meta: { sha, author, services: Array.from(touched, dir => services.get(dir)) } });
    }

    const tagLines = (await gitLines(root, "for-each-ref", "--sort=creatordate", "--format=%(refname:short)%1f%(creatordate:iso-strict)", "refs/tags")).split("\n").filter(Boolean);
    let previous: string | null = null;
    for (const line of tagLines) {
      const [tag, date] = line.split("\x1f");
      const releaseId = g.node("release", tag, tag, { validFrom: date, props: { date } });
      releaseIds.set(tag, releaseId);
      stats.releases += 1;
      const range = previous ? `${previous}..${tag}` : tag;
      const shas = (await gitLines(root, "rev-list", range)).split("\n").filter(Boolean);
      const notes: string[] = [];
      for (const sha of shas) {
        const commitId = commitIds.get(sha);
        if (!commitId) continue;
        g.edge(commitId, releaseId, "released_in", { validFrom: date });
        const row = getDb().get<{ props_json: string }>("SELECT props_json FROM atlas_nodes WHERE id = ?", commitId);
        notes.push(`- ${sha.slice(0, 7)} ${row ? JSON.parse(row.props_json).subject : ""}`);
      }
      const svcIds = getDb().all<{ dst: number }>("SELECT DISTINCT e2.dst FROM atlas_edges e1 JOIN atlas_edges e2 ON e2.src = e1.src AND e2.kind = 'changes' WHERE e1.dst = ? AND e1.kind = 'released_in'", releaseId);
      for (const row of svcIds) g.edge(releaseId, row.dst, "deploys", { validFrom: date });
      g.doc(releaseId, "release", `Release ${tag}`, `Release ${tag} on ${date}${previous ? ` (since ${previous})` : ""}\n${notes.slice(0, 60).join("\n")}`, { ts: date });
      previous = tag;
    }
    for (const link of pendingIncidentLinks) {
      const releaseId = releaseIds.get(link.release) ?? g.find("release", link.release);
      if (releaseId) g.edge(link.id, releaseId, "follows");
    }

    const summarize = (kind: string, sql: string) => getDb().all<{ id: number; name: string; key: string; edges: string }>(sql, projectId).filter(row => row.edges).forEach(row => g.doc(row.id, kind, `${kind === "pr" ? "" : `${kind[0].toUpperCase()}${kind.slice(1)} `}${row.name}`, row.edges));
    summarize("pr", `SELECT p.id, p.name, p.key, ifnull(json_extract(p.props_json, '$.title'), p.name) || char(10) || ifnull(group_concat(DISTINCT 'Changes ' || s.name), '') || char(10) || ifnull((SELECT group_concat(DISTINCT 'Modifies ' || f.path) FROM atlas_edges i2 JOIN atlas_edges m ON m.src = i2.dst AND m.kind = 'modifies' JOIN atlas_nodes f ON f.id = m.dst WHERE i2.src = p.id AND i2.kind = 'includes'), '') || char(10) || ifnull((SELECT group_concat(DISTINCT 'Released in ' || r.name) FROM atlas_edges i3 JOIN atlas_edges re ON re.src = i3.dst AND re.kind = 'released_in' JOIN atlas_nodes r ON r.id = re.dst WHERE i3.src = p.id AND i3.kind = 'includes'), '') edges
      FROM atlas_nodes p LEFT JOIN atlas_edges e ON e.src = p.id AND e.kind = 'changes' LEFT JOIN atlas_nodes s ON s.id = e.dst WHERE p.project_id = ? AND p.kind = 'pr' GROUP BY p.id`);
    summarize("team", `SELECT t.id, t.name, t.key, 'Team ' || t.name || ' owns ' || group_concat(s.name, ', ') || '.' edges FROM atlas_nodes t JOIN atlas_edges e ON e.dst = t.id AND e.kind = 'owned_by' JOIN atlas_nodes s ON s.id = e.src WHERE t.project_id = ? AND t.kind = 'team' GROUP BY t.id`);
    summarize("person", `SELECT p.id, p.name, p.key, p.name || ' authored ' || COUNT(e.dst) || ' changes: ' || group_concat(json_extract(c.props_json, '$.subject'), '; ') edges FROM atlas_nodes p JOIN atlas_edges e ON e.src = p.id AND e.kind = 'authored' JOIN atlas_nodes c ON c.id = e.dst AND c.kind = 'commit' WHERE p.project_id = ? AND p.kind = 'person' GROUP BY p.id`);

    for (const [dir, name] of services) {
      const id = serviceIds.get(dir)!;
      const out = getDb().all<{ kind: string; name: string; nk: string }>("SELECT e.kind, n.name, n.kind nk FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.dst WHERE e.src = ? AND n.kind IN ('service','api','table','team','infra','dependency')", id);
      const by = (edge: string, kind?: string) => out.filter(row => row.kind === edge && (!kind || row.nk === kind)).map(row => row.name);
      g.doc(id, "service", `Service ${name}`, [`Service ${name} lives in ${dir}.`, by("exposes").length ? `Exposes: ${by("exposes").join(", ")}.` : "", by("calls", "service").length ? `Calls: ${by("calls", "service").join(", ")}.` : "", by("reads").length ? `Reads tables: ${by("reads").join(", ")}.` : "", by("writes").length ? `Writes tables: ${by("writes").join(", ")}.` : "", by("owned_by").length ? `Owned by: ${by("owned_by").join(", ")}.` : "", by("depends_on").length ? `Dependencies: ${by("depends_on").slice(0, 15).join(", ")}.` : ""].filter(Boolean).join("\n"), { path: dir });
    }
    stats.files = texts.size;
    stats.apis = getDb().get<{ n: number }>("SELECT COUNT(*) n FROM atlas_nodes WHERE project_id = ? AND kind = 'api'", projectId)!.n;
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }

  stats.connectors = await ingestConnectors(projectId, onProgress).catch(error => {
    onProgress("connectors", `Connector error: ${(error as Error).message}`);
    return [];
  });

  onProgress("embed", "Embedding evidence for semantic search");
  stats.embedded = await embedDocs(projectId);
  stats.ms = Date.now() - started;
  db.run("INSERT INTO atlas_ingests (project_id, stats_json, finished_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET stats_json = excluded.stats_json, finished_at = excluded.finished_at", projectId, JSON.stringify(stats), now());
  onProgress("done", `${stats.services} services, ${stats.functions} functions, ${stats.commits} commits`);
  return stats;
}

/** Embeds documents through the local gateway. Skips quietly when no embedding model is reachable. */
export async function embedDocs(projectId: number, limit = 4000): Promise<number> {
  const rows = getDb().all<{ id: number; title: string; text: string }>("SELECT id, title, text FROM atlas_docs WHERE project_id = ? AND embedding IS NULL LIMIT ?", projectId, limit);
  let done = 0;
  for (let i = 0; i < rows.length; i += 32) {
    const batch = rows.slice(i, i + 32);
    const vectors = await tryEmbed(batch.map(row => `${row.title}\n${row.text}`.slice(0, 4000)));
    if (!vectors) return done;
    batch.forEach((row, j) => vectors[j] && setEmbedding(row.id, vectors[j]));
    done += batch.length;
  }
  return done;
}
