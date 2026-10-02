import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getInvestigation, investigate } from "../../server/meadow/atlas/agents";
import { generateAcmePay } from "../../server/meadow/atlas/demo";
import { formatReport, runEval } from "../../server/meadow/atlas/eval";
import { ingestProject, type IngestStats } from "../../server/meadow/atlas/ingest";
import { classify, retrieve } from "../../server/meadow/atlas/retrieve";
import { edgesOf, getNode, GraphWriter, graphStats, shortestPath } from "../../server/meadow/atlas/store";
import { listActions, runTool } from "../../server/meadow/atlas/tools";
import { decide } from "../../server/meadow/core/approvals";
import { getDb } from "../../server/meadow/core/db";
import { createProject } from "../../server/meadow/projects";
import { settled, tempHome } from "../helpers";

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

  it("re-ingests idempotently", async () => {
    const before = graphStats(projectId);
    await ingestProject(projectId);
    const after = graphStats(projectId);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.docs).toBe(before.docs);
  });

  it("never indexes secrets or the benchmark answers", () => {
    const titles = getDb().all<{ path: string | null }>("SELECT DISTINCT path FROM atlas_docs WHERE project_id = ?", projectId).map(row => row.path ?? "");
    expect(titles.some(title => title.includes("eval.json"))).toBe(false);
    expect(new GraphWriter(projectId).find("file", ".atlas/eval.json")).toBeNull();
  });
});

describe("atlas retrieval", () => {
  it("classifies queries and links entities", () => {
    expect(classify(projectId, "Why did payment API timeouts start after release v2.4.0?").type).toBe("multi-hop");
    const callers = classify(projectId, "Which services call payment-service?");
    expect(callers.type).toBe("relationship");
    expect(callers.entities.map(e => e.key)).toContain("service:payment-service");
    expect(callers.relations).toContain("calls");
    expect(classify(projectId, "What changed between v2.3.0 and v2.4.0?").releases.map(r => r.name)).toEqual(["v2.3.0", "v2.4.0"]);
    expect(classify(projectId, "Where is withRetry implemented?").type).toBe("code");
  });

  it("fuses vector, BM25, symbol and graph results", async () => {
    const result = await retrieve(projectId, "Which services call payment-service?", { k: 10 });
    const keys = result.hits.map(hit => hit.node?.key);
    expect(keys).toContain("service:api-gateway");
    expect(keys).toContain("service:order-service");
    expect(result.vectorBackend).toBe("hashed");
    expect(result.hits.some(hit => hit.sources.length > 1)).toBe(true);
    const code = await retrieve(projectId, "Where is withRetry implemented?", { k: 5 });
    expect(code.hits[0].path).toBe("services/payment-service/src/retry.ts");
    expect(code.hits[0].context).toContain("service payment-service");
  });

  it("answers release diffs from the temporal graph", async () => {
    const result = await retrieve(projectId, "What changed between v2.3.0 and v2.4.0?", { k: 10 });
    const keys = result.hits.map(hit => hit.node?.key);
    for (const pr of ["pr:#470", "pr:#478", "pr:#482"]) expect(keys).toContain(pr);
    expect(keys).not.toContain("pr:#431");
  });
});

describe("atlas agents", () => {
  it("finds the planted root cause with a verified, cited answer", async () => {
    const result = await investigate(projectId, "Why did payment API timeouts start after release v2.4.0?");
    expect(result.suspects[0].key).toBe("pr:#482");
    expect(result.suspects[0].files).toContain("services/payment-service/src/retry.ts");
    expect(result.suspects[0].highlights.join(" ")).toContain("maxAttempts 2 → 6");
    expect(result.answer).toContain("#482");
    expect(result.verifier.faithfulness).toBeGreaterThanOrEqual(0.8);
    expect(result.claims.every(claim => claim.citations.length > 0)).toBe(true);
    expect(result.findings.some(f => f.path.some(step => step.kind === "release") && f.path.some(step => step.kind === "pr"))).toBe(true);
    expect(result.actions.map(a => a.tool)).toEqual(["propose_patch", "create_issue"]);
    const stored = getInvestigation(result.id)!;
    expect(stored.trace.map(t => t.agent)).toEqual(expect.arrayContaining(["supervisor", "researcher", "architect", "operator", "writer", "verifier"]));
  });

  it("answers relationship questions from graph facts", async () => {
    const result = await investigate(projectId, "Who owns fraud-service?");
    expect(result.answer).toContain("risk-team");
    expect(result.verifier.faithfulness).toBe(1);
  });

  it("benchmarks all retrieval modes", async () => {
    const report = await runEval(projectId, { modes: ["vector", "hybrid", "agentic"] });
    expect(report.cases).toBe(12);
    expect(report.modes.hybrid!.recall10).toBeGreaterThan(report.modes.vector!.recall10);
    expect(report.modes.agentic!.answerHit).toBeGreaterThanOrEqual(report.modes.hybrid!.answerHit);
    expect(formatReport(report)).toContain("| agentic |");
  }, 60_000);
});

describe("atlas tools", () => {
  const ctx = () => ({ projectId, actor: "mcp" as const });

  it("serves read-only tools", async () => {
    const map = await runTool("get_repository_map", {}, ctx());
    expect((map.data as { services: unknown[] }).services).toHaveLength(6);
    const pr = await runTool("get_pull_request", { number: 482 }, ctx());
    expect((pr.data as { files: string[] }).files).toContain("services/payment-service/src/retry.ts");
    expect((pr.data as { releases: string[] }).releases).toEqual(["v2.4.0"]);
    const owner = await runTool("get_owner", { entity: "services/payment-service/src/retry.ts" }, ctx());
    expect((owner.data as { teams: string[] }).teams).toEqual(["acme/payments-team"]);
    const deps = await runTool("find_dependencies", { entity: "payment-service", direction: "in" }, ctx());
    expect((deps.data as { dependents: Array<{ name: string }> }).dependents.map(d => d.name)).toEqual(expect.arrayContaining(["api-gateway", "order-service"]));
    const incidents = await runTool("find_related_incidents", { service: "payment-service" }, ctx());
    expect((incidents.data as Array<{ key: string }>).map(i => i.key)).toEqual(["INC-2041"]);
    await expect(runTool("get_issue", { key: 5 }, ctx())).rejects.toThrow();
  });

  it("gates write tools behind approval and honours denial", async () => {
    const result = await runTool("create_issue", { title: "Cap payment retries", body: "Follow-up for INC-2041" }, ctx());
    expect(result.pending).toBeDefined();
    expect(listActions(projectId)[0].status).toBe("pending");
    decide(result.pending!.approvalId, "denied", "test");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(listActions(projectId)[0].status).toBe("denied");
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) n FROM notes WHERE source = 'atlas'")!.n).toBe(0);
  });

  it("hands an approved patch to the Meadow harness", async () => {
    const result = await runTool("propose_patch", { title: "Cap payment retries", description: "Cap retries at 3 with jittered backoff and release the pooled connection between attempts.", files: ["services/payment-service/src/retry.ts"] }, ctx());
    const done = settled(projectId);
    decide(result.pending!.approvalId, "approved", "test");
    await done;
    const action = listActions(projectId)[0];
    expect(action.status).toBe("done");
    expect(action.result).toMatch(/Started execution \d+/);
    expect(getDb().get<{ source: string }>("SELECT source FROM plans WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId)!.source).toBe("atlas");
  }, 30_000);
});
