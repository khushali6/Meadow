import fs from "node:fs";
import path from "node:path";
import { getDb } from "../core/db";
import { containsSecret } from "../core/redact";
import { embeddingRoute } from "../llm/router";
import { cosine, currentSpace, embedQuery, LOCAL_SPACE, localEmbed, providerEmbed, type EmbeddingSpace } from "../memory/embeddings";

/** Never indexed, regardless of project settings. */
const PERMANENT_IGNORE = [
  /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.venv(\/|$)/, /(^|\/)__pycache__(\/|$)/, /(^|\/)(dist|build|\.next|out|coverage|target)(\/|$)/,
  /(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx|crt|keystore)$/i, /(^|\/)(id_rsa|id_ed25519)/, /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml)$/i, /(^|\/)\.(npmrc|pypirc|netrc)$/,
  /(^|\/)\.meadow\/(screenshots|logs)(\/|$)/, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|bun\.lockb)$/,
];
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|vue|svelte|astro|html|css|scss|md|mdx|json|ya?ml|toml|sql|sh|txt|prisma|graphql)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 1500;

export function isIgnored(relative: string): boolean {
  return PERMANENT_IGNORE.some(pattern => pattern.test(relative));
}

export function listProjectFiles(root: string, extra?: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (isIgnored(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (TEXT_EXT.test(entry.name) || extra?.test(entry.name))) out.push(rel);
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(root);
  return out.sort();
}

export function chunkText(text: string, maxLines = 60): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const boundary = /^(#{1,3} |export |def |class |function |async function |const \w+ = \(|func |fn |pub fn )/.test(line);
    if (current.length >= maxLines || (boundary && current.length >= 15)) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.join("").trim()) chunks.push(current.join("\n"));
  return chunks.filter(chunk => chunk.trim().length > 20);
}

function spaceForWrite(embedded: { space: EmbeddingSpace } | null): string | null {
  if (embedded) return embedded.space.key;
  return currentSpace()?.backend === "local" ? LOCAL_SPACE.key : null;
}

export async function indexProject(projectId: number, root: string): Promise<{ files: number; chunks: number; embedded: boolean; space: string | null }> {
  const db = getDb();
  const files = listProjectFiles(root);
  const rows: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const full = path.join(root, file);
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\0") || containsSecret(text)) continue;
      for (const chunk of chunkText(text)) rows.push({ path: file, text: chunk });
    } catch {
      continue;
    }
  }
  const embedded = await providerEmbed(rows.map(row => `${row.path}\n${row.text}`));
  const space = spaceForWrite(embedded);
  db.raw.exec("BEGIN");
  try {
    db.run("DELETE FROM chunks WHERE project_id = ? AND source = 'code'", projectId);
    rows.forEach((row, i) => db.insert("chunks", { project_id: projectId, source: "code", path: row.path, text: row.text, embedding: embedded ? JSON.stringify(embedded.vectors[i]) : null, embedding_space: space }));
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  localCache.delete(projectId);
  return { files: files.length, chunks: rows.length, embedded: Boolean(space), space };
}

/** Re-indexes only the given files (changed, added or deleted), leaving every other chunk untouched. */
export async function reindexFiles(projectId: number, root: string, files: string[]): Promise<{ files: number; chunks: number }> {
  const db = getDb();
  const rows: Array<{ path: string; text: string }> = [];
  const touched = Array.from(new Set(files.map(file => file.replace(/^\.\//, "")))).filter(file => isSafeRelative(file) && !isIgnored(file));
  for (const file of touched) {
    const full = path.join(root, file);
    try {
      if (!TEXT_EXT.test(path.basename(file)) || fs.statSync(full).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\0") || containsSecret(text)) continue;
      for (const chunk of chunkText(text)) rows.push({ path: file, text: chunk });
    } catch {
      continue;
    }
  }
  const embedded = await providerEmbed(rows.map(row => `${row.path}\n${row.text}`));
  const space = spaceForWrite(embedded);
  db.raw.exec("BEGIN");
  try {
    for (const file of touched) db.run("DELETE FROM chunks WHERE project_id = ? AND source = 'code' AND path = ?", projectId, file);
    rows.forEach((row, i) => db.insert("chunks", { project_id: projectId, source: "code", path: row.path, text: row.text, embedding: embedded ? JSON.stringify(embedded.vectors[i]) : null, embedding_space: space }));
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  localCache.delete(projectId);
  return { files: touched.length, chunks: rows.length };
}

const isSafeRelative = (file: string) => !path.isAbsolute(file) && !file.split("/").includes("..");

export async function indexMemory(projectId: number, label: string, text: string) {
  if (containsSecret(text)) return;
  const embedded = await providerEmbed([text]);
  getDb().insert("chunks", { project_id: projectId, source: "memory", path: label, text, embedding: embedded ? JSON.stringify(embedded.vectors[0]) : null, embedding_space: spaceForWrite(embedded) });
  localCache.delete(projectId);
}

type ChunkRow = { id: number; source: string; path: string; text: string; embedding: string | null; embedding_space: string | null };
export type SearchHit = { path: string; source: string; text: string; score: number };

const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 2);

/** Local vectors are computed from chunk text on demand and cached until the chunk set changes. */
const localCache = new Map<number, { stamp: string; vectors: Map<number, Float32Array> }>();

function localVectors(projectId: number, rows: ChunkRow[]) {
  const stamp = `${rows.length}:${rows.reduce((max, row) => Math.max(max, row.id), 0)}`;
  let cached = localCache.get(projectId);
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, vectors: new Map() };
    localCache.set(projectId, cached);
  }
  for (const row of rows) if (!cached.vectors.has(row.id)) cached.vectors.set(row.id, localEmbed(`${row.path}\n${row.text}`));
  return cached.vectors;
}

function keywordRank(rows: ChunkRow[], query: string) {
  const terms = tokens(query);
  return rows.map(row => {
    const haystack = tokens(`${row.path} ${row.text}`);
    const counts = new Map<string, number>();
    for (const token of haystack) counts.set(token, (counts.get(token) ?? 0) + 1);
    const score = terms.reduce((sum, term) => sum + Math.log(1 + (counts.get(term) ?? 0)) + (row.path.toLowerCase().includes(term) ? 1.5 : 0), 0);
    return { row, score };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score);
}

async function vectorRank(projectId: number, rows: ChunkRow[], query: string) {
  const space = currentSpace();
  if (space?.backend === "provider") {
    const matching = rows.filter(row => row.embedding && row.embedding_space === space.key);
    if (matching.length >= rows.length / 2) {
      const queryVector = await embedQuery(query, space);
      if (queryVector) return matching.map(row => ({ row, score: cosine(queryVector, JSON.parse(row.embedding!) as number[]) })).sort((a, b) => b.score - a.score);
    }
  }
  const vectors = localVectors(projectId, rows);
  const queryVector = localEmbed(query);
  return rows.map(row => ({ row, score: cosine(queryVector, vectors.get(row.id)!) })).filter(hit => hit.score > 0.05).sort((a, b) => b.score - a.score);
}

/** Hybrid search: reciprocal rank fusion of keyword and vector rankings. Vectors come from the current embedding space only. */
export async function search(projectId: number, query: string, limit = 6, source?: "code" | "memory"): Promise<SearchHit[]> {
  const rows = source
    ? getDb().all<ChunkRow>("SELECT id, source, path, text, embedding, embedding_space FROM chunks WHERE project_id = ? AND source = ?", projectId, source)
    : getDb().all<ChunkRow>("SELECT id, source, path, text, embedding, embedding_space FROM chunks WHERE project_id = ?", projectId);
  if (!rows.length || !query.trim()) return [];
  const fused = new Map<number, { row: ChunkRow; score: number }>();
  const add = (ranked: Array<{ row: ChunkRow }>) => ranked.slice(0, 50).forEach((hit, rank) => {
    const entry = fused.get(hit.row.id) ?? { row: hit.row, score: 0 };
    entry.score += 1 / (60 + rank);
    fused.set(hit.row.id, entry);
  });
  add(keywordRank(rows, query));
  add(await vectorRank(projectId, rows, query));
  return Array.from(fused.values()).sort((a, b) => b.score - a.score).slice(0, limit).map(({ row, score }) => ({ path: row.path, source: row.source, text: row.text, score: Number(score.toFixed(4)) }));
}

export type MemoryStatus = { space: EmbeddingSpace | null; blockedReason: string | null; chunks: number; current: number; stale: number; spaces: Array<{ space: string; chunks: number }> };

/** How many chunks were embedded in the current space. Anything else is stale and needs a re-embed. */
export function memoryStatus(projectId: number): MemoryStatus {
  const space = currentSpace();
  const route = embeddingRoute();
  const spaces = getDb().all<{ space: string | null; chunks: number }>("SELECT embedding_space AS space, COUNT(*) AS chunks FROM chunks WHERE project_id = ? GROUP BY embedding_space", projectId).map(row => ({ space: row.space ?? "none", chunks: row.chunks }));
  const chunks = spaces.reduce((sum, row) => sum + row.chunks, 0);
  const current = space ? spaces.find(row => row.space === space.key)?.chunks ?? 0 : 0;
  return { space, blockedReason: route.mode === "blocked" ? route.reason : null, chunks, current, stale: chunks - current, spaces };
}

/** Recompute vectors for stale chunks, then swap them in one transaction. Search keeps working on the old vectors until then. */
export async function reembed(projectId: number): Promise<{ updated: number; space: string | null; failed: boolean }> {
  const space = currentSpace();
  if (!space) return { updated: 0, space: null, failed: true };
  const db = getDb();
  const stale = db.all<ChunkRow>("SELECT id, source, path, text, embedding, embedding_space FROM chunks WHERE project_id = ? AND (embedding_space IS NULL OR embedding_space != ?)", projectId, space.key);
  if (!stale.length) return { updated: 0, space: space.key, failed: false };
  let vectors: number[][] | null = null;
  if (space.backend === "provider") {
    const embedded = await providerEmbed(stale.map(row => `${row.path}\n${row.text}`));
    if (!embedded || embedded.space.key !== space.key) return { updated: 0, space: space.key, failed: true };
    vectors = embedded.vectors;
  }
  db.raw.exec("BEGIN");
  try {
    stale.forEach((row, i) => db.run("UPDATE chunks SET embedding = ?, embedding_space = ? WHERE id = ?", vectors ? JSON.stringify(vectors[i]) : null, space.key, row.id));
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  localCache.delete(projectId);
  return { updated: stale.length, space: space.key, failed: false };
}

/** Context block for prompts: top snippets if indexed, otherwise a file list. */
export async function promptContext(projectId: number, root: string, query: string): Promise<string> {
  const hits = await search(projectId, query, 5, "code").catch(() => []);
  if (hits.length) return hits.map(hit => `\`${hit.path}\`\n\`\`\`\n${hit.text.slice(0, 1200)}\n\`\`\``).join("\n\n");
  const files = listProjectFiles(root).filter(file => !/^(PLAN|SPEC)\.md$/.test(file));
  return files.length ? `Files in the repository:\n${files.slice(0, 120).map(file => `- ${file}`).join("\n")}` : "";
}
