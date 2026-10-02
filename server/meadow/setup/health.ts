import { closeExternalClients, listExternalTools } from "../atlas/mcpClient";
import { telegram } from "../channels/telegram";
import { loadConfig } from "../config";
import { getDb } from "../core/db";
import { bus } from "../core/events";
import { chatProviderId, healthCheck } from "../llm/router";
import { isConfigured } from "../llm/catalog";
import { listProjects } from "../projects";
import { memoryStatus, reembed } from "../rag/index";

export type HealthArea = "database" | "memory" | "codeatlas" | "llm" | "mcp" | "telegram";
export type HealthCheck = { area: HealthArea; ok: boolean; skipped?: boolean; detail: string; repairable: boolean; fix?: string };
export type RepairResult = { area: HealthArea; attempted: boolean; ok: boolean; detail: string };

let llmCache: { at: number; check: HealthCheck } | null = null;

async function checkLlm(): Promise<HealthCheck> {
  if (llmCache && Date.now() - llmCache.at < 5 * 60_000) return llmCache.check;
  const id = chatProviderId();
  let check: HealthCheck;
  if (!isConfigured(id)) check = { area: "llm", ok: false, skipped: true, detail: "No agent model configured; Meadow uses rules and templates.", repairable: false, fix: "Runtime settings → Agent model" };
  else {
    const health = await healthCheck(id, { chat: false }).catch(error => ({ ok: false, steps: [{ name: "Endpoint", ok: false, detail: (error as Error).message }] }));
    const failed = health.steps.find(step => !step.ok);
    check = { area: "llm", ok: health.ok, detail: health.ok ? `${id} reachable` : `${id}: ${failed?.detail ?? "unreachable"}`, repairable: false, fix: "Start the local model server or check the key in Runtime settings → Agent model" };
  }
  llmCache = { at: Date.now(), check };
  return check;
}

/** A quick, read-only health pass over the things Meadow depends on. */
export async function diagnose(): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  try {
    const db = getDb();
    db.get("SELECT 1");
    checks.push({ area: "database", ok: true, detail: `Schema v${db.schemaVersion()}`, repairable: false });
  } catch (error) {
    checks.push({ area: "database", ok: false, detail: (error as Error).message, repairable: false, fix: "Restore the latest copy from ~/.meadow/backups" });
  }

  const projects = listProjects();
  const stale = projects.map(project => ({ project, status: memoryStatus(project.id) })).filter(item => item.status.stale > 0 && !item.status.blockedReason);
  checks.push(stale.length ? { area: "memory", ok: false, detail: stale.map(item => `${item.project.name}: ${item.status.stale} stale chunks`).join("; "), repairable: true } : { area: "memory", ok: true, detail: `${projects.length} project${projects.length === 1 ? "" : "s"} indexed locally`, repairable: false });

  const built = getDb().get<{ n: number }>("SELECT COUNT(*) n FROM atlas_ingests")?.n ?? 0;
  checks.push({ area: "codeatlas", ok: true, skipped: built === 0, detail: built ? `Graph built for ${built} project${built === 1 ? "" : "s"}${loadConfig().atlas.liveUpdate ? ", kept live" : ""}` : "No graph built yet", repairable: false });

  checks.push(await checkLlm());

  const servers = loadConfig().atlas.mcpServers;
  if (!servers.length) checks.push({ area: "mcp", ok: true, skipped: true, detail: "No external MCP servers", repairable: false });
  else {
    const tools = await listExternalTools();
    const down = servers.filter(server => !tools.some(tool => tool.server === server.name)).map(server => server.name);
    checks.push({ area: "mcp", ok: !down.length, detail: down.length ? `Not responding: ${down.join(", ")}` : `${servers.length} server${servers.length === 1 ? "" : "s"}, ${tools.length} tools`, repairable: down.length > 0 });
  }

  const tg = telegram.status();
  if (!tg.configured) checks.push({ area: "telegram", ok: true, skipped: true, detail: "Not connected", repairable: false });
  else checks.push({ area: "telegram", ok: tg.running && tg.connection.state === "connected", detail: tg.running && tg.connection.state === "connected" ? `Connected${tg.bot ? ` to @${tg.bot}` : ""}` : `${tg.connection.state}${tg.lastError ? `: ${tg.lastError}` : ""}`, repairable: true });
  return checks;
}

async function repairArea(area: HealthArea): Promise<RepairResult> {
  try {
    if (area === "telegram") {
      const ok = await telegram.repair();
      return { area, attempted: true, ok, detail: ok ? "Telegram connection restored" : "Telegram is still unreachable; Meadow keeps retrying with backoff" };
    }
    if (area === "mcp") {
      await closeExternalClients();
      const tools = await listExternalTools();
      const down = loadConfig().atlas.mcpServers.filter(server => !tools.some(tool => tool.server === server.name));
      return { area, attempted: true, ok: !down.length, detail: down.length ? `Still not responding: ${down.map(server => server.name).join(", ")}` : "MCP servers reconnected" };
    }
    if (area === "memory") {
      let updated = 0;
      for (const project of listProjects()) if (memoryStatus(project.id).stale > 0) updated += (await reembed(project.id)).updated;
      return { area, attempted: true, ok: true, detail: `Re-embedded ${updated} stale chunks` };
    }
  } catch (error) {
    return { area, attempted: true, ok: false, detail: (error as Error).message };
  }
  return { area, attempted: false, ok: false, detail: "Needs your attention" };
}

/** Diagnose, repair what can be repaired automatically, and diagnose again. */
export async function diagnoseAndRepair(): Promise<{ before: HealthCheck[]; repairs: RepairResult[]; after: HealthCheck[] }> {
  const before = await diagnose();
  const repairs: RepairResult[] = [];
  for (const check of before.filter(item => !item.ok && !item.skipped && item.repairable)) repairs.push(await repairArea(check.area));
  llmCache = null;
  const after = repairs.length ? await diagnose() : before;
  return { before, repairs, after };
}

/** Runs in the daemon: checks every few minutes and repairs on its own, telling the user only when something changed. */
export function startHealthMonitor(intervalMs = 2 * 60_000) {
  let last = new Map<HealthArea, boolean>();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { before, repairs, after } = await diagnoseAndRepair();
      for (const repair of repairs) bus.emitEvent({ type: "health", title: repair.ok ? `Repaired: ${repair.detail}` : `Repair failed (${repair.area})`, detail: repair.detail, payload: { area: repair.area, ok: repair.ok } });
      for (const check of after) {
        const was = last.get(check.area);
        if (was !== undefined && was !== check.ok && !check.skipped && !repairs.some(repair => repair.area === check.area)) bus.emitEvent({ type: "health", title: check.ok ? `${check.area} recovered` : `${check.area} problem detected`, detail: check.detail, payload: { area: check.area, ok: check.ok } });
      }
      last = new Map(after.map(check => [check.area, check.ok || Boolean(check.skipped)]));
      void before;
    } catch {
      // Diagnostics must never take the daemon down.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  setTimeout(() => void tick(), 15_000).unref();
  return () => clearInterval(timer);
}
