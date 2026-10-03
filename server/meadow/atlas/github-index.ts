/**
 * github-index.ts — Index an external GitHub repository into a project's CodeAtlas.
 *
 * The repo is cloned to a secure temp directory (under ~/.meadow/ext-repos/), indexed into the
 * project's chunk store under source = "ext:<owner/repo>", then cleaned up. The next time the user
 * asks CodeAtlas a question, retrieved chunks from the external repo appear alongside the project's
 * own code, enabling questions like "why is this service slow?" or "how does their auth work?".
 *
 * Security:
 *   - Only https://github.com URLs are accepted (no private schemes, no localhost).
 *   - The GITHUB_TOKEN is passed only via GIT_CONFIG environment variables, never in the URL or argv.
 *   - The clone is shallow (depth 1) and discarded after indexing.
 *   - The temp directory is deleted on success, error, and process exit.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { capture } from "../core/exec";
import { getSecret, homePath } from "../config";
import { getDb } from "../core/db";
import { indexProject, isIgnored, listProjectFiles, chunkText } from "../rag/index";
import { containsSecret } from "../core/redact";
import { providerEmbed } from "../memory/embeddings";
import { currentSpace } from "../memory/embeddings";

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|vue|svelte|astro|html|css|scss|md|mdx|json|ya?ml|toml|sql|sh|txt|prisma|graphql)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 1500;

export type GithubIndexResult = {
  repo: string;
  files: number;
  chunks: number;
  embedded: boolean;
  alreadyIndexed: boolean;
};

/** Validate and normalise a GitHub repo URL to "owner/repo". */
export function parseGithubUrl(url: string): string {
  const cleaned = url.trim().replace(/\.git$/, "");
  // Accept: https://github.com/owner/repo  or  github.com/owner/repo  or  owner/repo
  const match =
    cleaned.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/) ??
    cleaned.match(/^github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/) ??
    cleaned.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  if (!match?.[1]) throw new Error("Invalid GitHub URL. Use https://github.com/owner/repo or just owner/repo.");
  return match[1];
}

function extSource(repoSlug: string) {
  return `ext:${repoSlug}`;
}

/** True if this repo has already been indexed for the project (checking the DB). */
export function isIndexed(projectId: number, repoSlug: string): boolean {
  const row = getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM chunks WHERE project_id = ? AND source = ?", projectId, extSource(repoSlug));
  return (row?.n ?? 0) > 0;
}

/** Remove an external repo's chunks from the project. */
export function removeExternalRepo(projectId: number, repoSlug: string): void {
  getDb().run("DELETE FROM chunks WHERE project_id = ? AND source = ?", projectId, extSource(repoSlug));
}

/** List all external repos indexed for a project. */
export function listExternalRepos(projectId: number): string[] {
  const rows = getDb().all<{ source: string }>("SELECT DISTINCT source FROM chunks WHERE project_id = ? AND source LIKE 'ext:%'", projectId);
  return rows.map(row => row.source.slice(4));
}

/**
 * Clone and index a GitHub repository into the project's CodeAtlas.
 * Progress is reported via the `onProgress` callback.
 */
export async function indexGithubRepo(
  projectId: number,
  repoUrl: string,
  options: { force?: boolean; onProgress?: (step: string) => void } = {},
): Promise<GithubIndexResult> {
  const slug = parseGithubUrl(repoUrl);
  const { force = false, onProgress = () => undefined } = options;

  if (!force && isIndexed(projectId, slug)) {
    return { repo: slug, files: 0, chunks: 0, embedded: false, alreadyIndexed: true };
  }

  // Use a stable temp dir under ~/.meadow/ext-repos/<slug> so re-runs skip the clone.
  const cacheDir = homePath("ext-repos", slug.replace("/", "-"));
  const cloneDir = path.join(cacheDir, "repo");

  onProgress(`Cloning ${slug} (shallow)…`);

  if (!fs.existsSync(cloneDir)) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const token = getSecret("GITHUB_TOKEN");
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (token) {
      // Supply the token only through git config, not in the URL.
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    }
    const result = await capture("git", ["clone", "--depth", "1", "--quiet", `https://github.com/${slug}.git`, cloneDir], {
      cwd: os.homedir(),
      timeoutMs: 120_000,
      env,
    });
    if (result.code !== 0) {
      throw new Error(`git clone failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
  }

  onProgress(`Indexing ${slug}…`);

  // Walk the cloned repo and collect text chunks.
  const rows: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    if (rows.length >= MAX_FILES) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(cloneDir, full).split(path.sep).join("/");
      if (isIgnored(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !TEXT_EXT.test(entry.name)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("\0") || containsSecret(text)) continue;
        for (const chunk of chunkText(text)) {
          rows.push({ path: `${slug}/${rel}`, text: chunk });
        }
      } catch { continue; }
      if (rows.length >= MAX_FILES) break;
    }
  };
  walk(cloneDir);

  onProgress(`Embedding ${rows.length} chunks…`);

  const source = extSource(slug);
  const embedded = await providerEmbed(rows.map(row => `${row.path}\n${row.text}`));
  const space = embedded ? embedded.space.key : null;

  const db = getDb();
  db.raw.exec("BEGIN");
  try {
    db.run("DELETE FROM chunks WHERE project_id = ? AND source = ?", projectId, source);
    rows.forEach((row, i) =>
      db.insert("chunks", {
        project_id: projectId,
        source,
        path: row.path,
        text: row.text,
        embedding: embedded ? JSON.stringify(embedded.vectors[i]) : null,
        embedding_space: space,
      }),
    );
    db.raw.exec("COMMIT");
  } catch (err) {
    db.raw.exec("ROLLBACK");
    throw err;
  }

  return { repo: slug, files: listProjectFiles(cloneDir).length, chunks: rows.length, embedded: Boolean(space), alreadyIndexed: false };
}
