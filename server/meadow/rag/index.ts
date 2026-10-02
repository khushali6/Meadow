import fs from "node:fs";
import path from "node:path";
import { getDb } from "../core/db";
import { containsSecret } from "../core/redact";
import { getLlm } from "../llm/client";

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

export function listProjectFiles(root: string): string[] {
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
      else if (entry.isFile() && TEXT_EXT.test(entry.name)) out.push(rel);
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

async function embedSafely(texts: string[]): Promise<Array<number[] | null>> {
  if (!texts.length) return [];
  try {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) vectors.push(...(await getLlm().embed(texts.slice(i, i + 32).map(text => text.slice(0, 4000)))));
    return vectors;
  } catch {
    return texts.map(() => null);
  }
}

export async function indexProject(projectId: number, root: string): Promise<{ files: number; chunks: number; embedded: boolean }> {
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
  const vectors = await embedSafely(rows.map(row => `${row.path}\n${row.text}`));
  db.raw.exec("BEGIN");
  try {
    db.run("DELETE FROM chunks WHERE project_id = ? AND source = 'code'", projectId);
    rows.forEach((row, i) => db.insert("chunks", { project_id: projectId, source: "code", path: row.path, text: row.text, embedding: vectors[i] ? JSON.stringify(vectors[i]) : null }));
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  return { files: files.length, chunks: rows.length, embedded: vectors.some(Boolean) };
}

export async function indexMemory(projectId: number, label: string, text: string) {
  if (containsSecret(text)) return;
  const [vector] = await embedSafely([text]);
  getDb().insert("chunks", { project_id: projectId, source: "memory", path: label, text, embedding: vector ? JSON.stringify(vector) : null });
}

type ChunkRow = { id: number; source: string; path: string; text: string; embedding: string | null };
export type SearchHit = { path: string; source: string; text: string; score: number };

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 2);

export async function search(projectId: number, query: string, limit = 6, source?: "code" | "memory"): Promise<SearchHit[]> {
  const rows = source
    ? getDb().all<ChunkRow>("SELECT id, source, path, text, embedding FROM chunks WHERE project_id = ? AND source = ?", projectId, source)
    : getDb().all<ChunkRow>("SELECT id, source, path, text, embedding FROM chunks WHERE project_id = ?", projectId);
  if (!rows.length) return [];
  const embedded = rows.filter(row => row.embedding);
  let scored: SearchHit[] = [];
  if (embedded.length > rows.length / 2) {
    const [queryVector] = await embedSafely([query]);
    if (queryVector) scored = embedded.map(row => ({ path: row.path, source: row.source, text: row.text, score: cosine(queryVector, JSON.parse(row.embedding!)) }));
  }
  if (!scored.length) {
    const terms = tokens(query);
    scored = rows.map(row => {
      const haystack = tokens(`${row.path} ${row.text}`);
      const counts = new Map<string, number>();
      for (const token of haystack) counts.set(token, (counts.get(token) ?? 0) + 1);
      const score = terms.reduce((sum, term) => sum + Math.log(1 + (counts.get(term) ?? 0)) + (row.path.toLowerCase().includes(term) ? 1.5 : 0), 0);
      return { path: row.path, source: row.source, text: row.text, score };
    }).filter(hit => hit.score > 0);
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Context block for prompts: top snippets if indexed, otherwise a file list. */
export async function promptContext(projectId: number, root: string, query: string): Promise<string> {
  const hits = await search(projectId, query, 5, "code").catch(() => []);
  if (hits.length) return hits.map(hit => `\`${hit.path}\`\n\`\`\`\n${hit.text.slice(0, 1200)}\n\`\`\``).join("\n\n");
  const files = listProjectFiles(root).filter(file => !/^(PLAN|SPEC)\.md$/.test(file));
  return files.length ? `Files in the repository:\n${files.slice(0, 120).map(file => `- ${file}`).join("\n")}` : "";
}
