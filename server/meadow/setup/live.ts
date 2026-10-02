import fs from "node:fs";
import path from "node:path";
import { ingestProject } from "../atlas/ingest";
import { loadConfig } from "../config";
import { getDb } from "../core/db";
import { bus } from "../core/events";
import { git, headSha, status } from "../core/git";
import { getSetting, putSetting } from "../core/settings";
import { getProject, listProjects } from "../projects";
import { reindexFiles } from "../rag/index";

type Snapshot = { head: string | null; dirty: Record<string, string> };
export type LiveUpdate = { projectId: number; files: string[]; chunks: number; graph: boolean; reason: string; at: string; ms: number };

const POLL_MS = 20_000;
const GRAPH_MIN_INTERVAL_MS = 30_000;
/** Marks a snapshot whose graph rebuild was postponed by the debounce. */
const PENDING = "\u0000graph-pending";

async function snapshot(root: string): Promise<Snapshot | null> {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const head = await headSha(root).catch(() => null);
  const dirty: Record<string, string> = {};
  for (const entry of await status(root).catch(() => [])) {
    let mtime = "gone";
    try {
      mtime = String(fs.statSync(path.join(root, entry.path)).mtimeMs);
    } catch {
      // deleted
    }
    dirty[entry.path] = `${entry.code}:${mtime}`;
  }
  return { head, dirty };
}

/**
 * Keeps memory and the knowledge graph in step with the repository. Each pass compares HEAD and the
 * working tree with the last indexed snapshot: changed files are re-chunked individually, and the graph is
 * re-ingested in one transaction (debounced) so queries never see a half-built graph.
 */
class LiveGraph {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<number>();
  private lastGraph = new Map<number, number>();
  private isBusy: (projectId: number) => boolean = () => false;
  last = new Map<number, LiveUpdate>();

  start(options: { isBusy?: (projectId: number) => boolean } = {}) {
    if (options.isBusy) this.isBusy = options.isBusy;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (!loadConfig().atlas.liveUpdate) return;
    for (const project of listProjects()) {
      if (this.isBusy(project.id)) continue;
      await this.refresh(project.id, "git change").catch(error => console.warn(`[meadow] live update failed for ${project.name}: ${(error as Error).message}`));
    }
  }

  /** Records the current tree as indexed without re-indexing (after a full index). */
  async markIndexed(projectId: number) {
    const snap = await snapshot(getProject(projectId).path);
    if (snap) putSetting(`live:${projectId}`, snap);
  }

  async refresh(projectId: number, reason: string, options: { forceGraph?: boolean } = {}): Promise<LiveUpdate | null> {
    if (this.running.has(projectId)) return null;
    this.running.add(projectId);
    const started = Date.now();
    try {
      const project = getProject(projectId);
      const current = await snapshot(project.path);
      if (!current) return null;
      const previous = getSetting<Snapshot>(`live:${projectId}`);
      if (!previous) {
        putSetting(`live:${projectId}`, current);
        return null;
      }
      const pendingGraph = PENDING in previous.dirty;
      const changed = new Set<string>();
      if (previous.head && current.head && previous.head !== current.head) {
        const names = await git(project.path, "diff", "--name-only", previous.head, current.head).catch(() => "");
        for (const name of names.split("\n").filter(Boolean)) changed.add(name);
      }
      for (const [file, sig] of Object.entries(current.dirty)) if (previous.dirty[file] !== sig) changed.add(file);
      for (const file of Object.keys(previous.dirty)) if (file !== PENDING && !(file in current.dirty)) changed.add(file);
      const files = Array.from(changed).filter(file => !file.startsWith(".meadow/"));
      if (!files.length && !options.forceGraph && !pendingGraph) {
        putSetting(`live:${projectId}`, current);
        return null;
      }
      const memory = files.length ? await reindexFiles(projectId, project.path, files) : { chunks: 0 };
      const hasGraph = Boolean(getDb().get("SELECT 1 FROM atlas_ingests WHERE project_id = ?", projectId));
      const due = options.forceGraph || Date.now() - (this.lastGraph.get(projectId) ?? 0) > GRAPH_MIN_INTERVAL_MS;
      let graph = false;
      if (hasGraph && due) {
        await ingestProject(projectId);
        this.lastGraph.set(projectId, Date.now());
        graph = true;
      }
      if (graph || !hasGraph) putSetting(`live:${projectId}`, current);
      else putSetting(`live:${projectId}`, { head: current.head, dirty: { ...current.dirty, [PENDING]: String(Date.now()) } });
      if (!files.length && !graph) return null;
      const update: LiveUpdate = { projectId, files, chunks: memory.chunks, graph, reason, at: new Date().toISOString(), ms: Date.now() - started };
      this.last.set(projectId, update);
      bus.emitEvent({ type: "memory", projectId, title: `${graph ? "Graph and memory" : "Memory"} updated: ${files.length} changed file${files.length === 1 ? "" : "s"}`, detail: `${reason}. ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}`, payload: { live: true, files: files.length, chunks: memory.chunks, graph } });
      return update;
    } finally {
      this.running.delete(projectId);
    }
  }
}

export const liveGraph = new LiveGraph();
