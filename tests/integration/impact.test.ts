import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAcmePay } from "../../server/meadow/atlas/demo";
import { changeImpact, nodesForPaths } from "../../server/meadow/atlas/impact";
import { ingestProject } from "../../server/meadow/atlas/ingest";
import { runTool } from "../../server/meadow/atlas/tools";
import { getDb } from "../../server/meadow/core/db";
import { metrics } from "../../server/meadow/metrics";
import { createProject } from "../../server/meadow/projects";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let projectId: number;
const nodeId = (key: string) => getDb().get<{ id: number }>("SELECT id FROM atlas_nodes WHERE project_id = ? AND key = ?", projectId, key)!.id;

beforeAll(async () => {
  env = tempHome();
  const dir = path.join(env.root, "acmepay");
  await generateAcmePay(dir);
  projectId = (await createProject({ name: "acmepay", path: dir, engine: "fake" })).id;
  await ingestProject(projectId);
}, 60_000);

afterAll(() => env.cleanup());

describe("change impact", () => {
  it("follows callers, APIs, tables, owners and incidents from a service", () => {
    const report = changeImpact([nodeId("service:payment-service")]);
    expect(report.seeds.map(seed => seed.name)).toContain("payment-service");
    expect(report.services).toEqual(expect.arrayContaining(["api-gateway", "order-service"]));
    expect(report.apis.some(api => api.includes("/payments"))).toBe(true);
    expect(report.tables).toContain("payments");
    expect(report.owners.length).toBeGreaterThan(0);
    expect(report.risk).toBe("high");
    expect(report.reasons.length).toBeGreaterThan(0);
    for (const item of report.impacted) expect(item.via).toBeTruthy();
    expect(report.edges.length).toBeGreaterThan(0);
  });

  it("respects depth and is smaller for a leaf", () => {
    const shallow = changeImpact([nodeId("service:payment-service")], 1);
    const deep = changeImpact([nodeId("service:payment-service")], 3);
    expect(shallow.impacted.length).toBeLessThanOrEqual(deep.impacted.length);
    expect(Math.max(...shallow.impacted.map(item => item.depth))).toBeLessThanOrEqual(1);
  });

  it("maps changed file paths to graph nodes and ignores unknown paths", () => {
    const file = "services/payment-service/src/retry.ts";
    const nodes = nodesForPaths(projectId, [`./${file}`]);
    expect(nodes.map(node => node.path)).toContain(file);
    expect(nodesForPaths(projectId, ["does/not/exist.ts"])).toEqual([]);
    const report = changeImpact(nodes.map(node => node.id));
    expect(report.services).toContain("payment-service");
  });

  it("is available to agents as a READ tool with path sandboxing", async () => {
    const result = await runTool("change_impact", { entity: "payment-service" }, { projectId, actor: "web" });
    expect(result.summary).toMatch(/affected \(high risk\)/);
    await expect(runTool("change_impact", { paths: ["../../etc/passwd"] }, { projectId, actor: "web" })).rejects.toThrow();
    const audit = getDb().get<{ risk: string; result: string }>("SELECT risk, result FROM audit_log WHERE tool = 'change_impact' ORDER BY id LIMIT 1");
    expect(audit).toEqual({ risk: "READ", result: "ok" });
  });
});

describe("metrics", () => {
  it("reports nulls instead of invented numbers when there is no data", () => {
    const m = metrics(projectId, 14);
    expect(m.runs.total).toBe(0);
    expect(m.runs.successRate).toBeNull();
    expect(m.runs.p50Ms).toBeNull();
    expect(m.phases.passRate).toBeNull();
    expect(m.checks.passRate).toBeNull();
    expect(m.daily).toHaveLength(14);
  });

  it("counts audited tool calls by risk", () => {
    const m = metrics(projectId, 14);
    expect(m.tools.find(row => row.risk === "READ" && row.result === "ok")?.count).toBeGreaterThan(0);
  });
});
