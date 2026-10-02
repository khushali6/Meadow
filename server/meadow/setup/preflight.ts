import { changeImpact, nodesForPaths, type ImpactReport } from "../atlas/impact";
import { getDb } from "../core/db";
import type { PlanPhase } from "../planning/format";

const FILE_TOKEN = /(?:^|[\s`'"(])((?:[\w@.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|sql|prisma|vue|svelte|ya?ml|tf))(?=$|[\s`'"),:;])/g;

/** Graph nodes a phase is about to touch: files named in its tasks, and services or APIs mentioned by name. */
export function phaseSeeds(projectId: number, phase: PlanPhase): number[] {
  const text = [phase.name, ...phase.tasks, phase.doneWhen].join("\n");
  const files = Array.from(text.matchAll(FILE_TOKEN), match => match[1].replace(/^\.\//, ""));
  const ids = new Set(nodesForPaths(projectId, files).map(node => node.id));
  const named = getDb().all<{ id: number; name: string }>("SELECT id, name FROM atlas_nodes WHERE project_id = ? AND kind IN ('service', 'table') AND valid_to IS NULL AND length(name) >= 4", projectId);
  const lower = text.toLowerCase();
  for (const node of named) {
    const name = node.name.toLowerCase();
    const at = lower.indexOf(name);
    if (at >= 0 && !/[a-z0-9]/.test(lower[at - 1] ?? " ") && !/[a-z0-9]/.test(lower[at + name.length] ?? " ")) ids.add(node.id);
  }
  return Array.from(ids).slice(0, 12);
}

/** Impact of a phase before it runs, as a prompt section the engine can plan around. Null when the graph knows nothing relevant. */
export function preflightImpact(projectId: number, phase: PlanPhase): { report: ImpactReport; text: string } | null {
  const seeds = phaseSeeds(projectId, phase);
  if (!seeds.length) return null;
  const report = changeImpact(seeds, 2);
  if (!report.impacted.length) return null;
  const list = (label: string, items: string[]) => (items.length ? `- ${label}: ${items.slice(0, 10).join(", ")}${items.length > 10 ? ` (+${items.length - 10})` : ""}` : "");
  const text = [
    "# Change impact (from the knowledge graph)",
    `This phase touches ${report.seeds.map(seed => seed.name).join(", ")}. Risk: ${report.risk}. ${report.reasons.join(". ")}.`,
    list("Services that depend on it", report.services.filter(name => !report.seeds.some(seed => seed.name === name))),
    list("APIs", report.apis),
    list("Tables", report.tables),
    list("Tests to keep green", report.tests),
    report.incidents.length ? list("Past incidents nearby", report.incidents.map(item => item.name)) : "",
    "Keep these working. If a dependent must change, change it within this phase's scope or say so in your report.",
  ].filter(Boolean).join("\n");
  return { report, text };
}
