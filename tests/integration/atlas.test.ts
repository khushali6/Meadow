import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAcmePay } from "../../server/meadow/atlas/demo";
import { ingestProject, type IngestStats } from "../../server/meadow/atlas/ingest";
import { edgesOf, getNode, GraphWriter, graphStats, shortestPath } from "../../server/meadow/atlas/store";
import { getDb } from "../../server/meadow/core/db";
import { createProject } from "../../server/meadow/projects";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let projectId: number;
let stats: IngestStats;

const nodeId = (key: string) => getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", projectId, key)?.id ?? null;
const linked = (from: string, kind: string, to: string) => {
  const src = nodeId(from);
  const dst = nodeId(to);
  return !!src && !!dst && edgesOf(src).some(edge => edge.kind === kind && edge.direction === "out" && edge.other === dst);
};

beforeAll(async () => {
  env = tempHome();
  const dir = path.join(env.root, "acmepay");
  await generateAcmePay(dir);
  projectId = (await createProject({ name: "acmepay", path: dir, engine: "fake" })).id;
  stats = await ingestProject(projectId);
}, 60_000);

afterAll(() => env.cleanup());

describe("atlas ingestion", () => {
  it("builds services, code, APIs, tables and history", () => {
    expect(stats.services).toBe(6);
    expect(stats.functions).toBeGreaterThan(15);
    expect(stats.tables).toBeGreaterThanOrEqual(6);
    expect(stats.commits).toBe(9);
    expect(stats.releases).toBe(4);
    expect(stats.incidents).toBe(3);
    expect(stats.embedded).toBe(0);
    expect(Object.values(graphStats(projectId).nodes).reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  });

  it("links services through calls, ownership and tables", () => {
    expect(linked("service:api-gateway", "calls", "service:payment-service")).toBe(true);
    expect(linked("service:order-service", "calls", "service:payment-service")).toBe(true);
    expect(linked("service:payment-service", "calls", "service:fraud-service")).toBe(true);
    expect(linked("service:fraud-service", "owned_by", "team:@acme/risk-team")).toBe(true);
    expect(linked("service:ledger-service", "writes", "table:ledger_entries")).toBe(true);
    expect(linked("service:payment-service", "writes", "table:payments")).toBe(true);
    expect(linked("service:payment-service", "exposes", "api:POST /payments")).toBe(true);
  });

  it("records PRs, releases and incidents with time", () => {
    expect(linked("pr:#482", "includes", nodeId("pr:#482") ? getDb().get<{ key: string }>("SELECT n.key FROM atlas_edges e JOIN atlas_nodes n ON n.id = e.dst WHERE e.src = ? AND e.kind = 'includes'", nodeId("pr:#482"))!.key : "")).toBe(true);
    expect(linked("incident:INC-2041", "follows", "release:v2.4.0")).toBe(true);
    expect(linked("incident:INC-2041", "affects", "service:payment-service")).toBe(true);
    expect(getNode(nodeId("release:v2.4.0")!)!.validFrom).toContain("2026-03-11");
    const released = getDb().all<{ key: string }>("SELECT c.key FROM atlas_edges e JOIN atlas_nodes c ON c.id = e.src JOIN atlas_edges p ON p.dst = c.id AND p.kind = 'includes' JOIN atlas_nodes pr ON pr.id = p.src WHERE e.dst = ? AND e.kind = 'released_in' AND pr.key = 'pr:#482'", nodeId("release:v2.4.0"));
    expect(released).toHaveLength(1);
  });

  it("finds the path from the incident to the retry change", () => {
    const path = shortestPath(nodeId("incident:INC-2041")!, nodeId("file:services/payment-service/src/retry.ts")!, { maxHops: 5, avoidKinds: ["service", "repo"] });
    expect(path).not.toBeNull();
    expect(path!.map(step => step.node.kind)).toContain("commit");
  });

  it("never indexes secrets or the benchmark answers", () => {
    const titles = getDb().all<{ path: string | null }>("SELECT DISTINCT path FROM atlas_docs WHERE project_id = ?", projectId).map(row => row.path ?? "");
    expect(titles.some(title => title.includes("eval.json"))).toBe(false);
    expect(new GraphWriter(projectId).find("file", ".atlas/eval.json")).toBeNull();
  });
});
