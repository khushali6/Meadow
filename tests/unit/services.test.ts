import { describe, expect, it } from "vitest";
import { mcpTool, parseCursorLine } from "../../server/meadow/engines/cursor";
import { classifyMcpCall } from "../../server/meadow/guard/policy";
import { parseMcpList } from "../../server/meadow/services/registry";
import { decideSupabase, supabaseFacts } from "../../server/meadow/services/supabase";

const personal = { id: "org-a", name: "Personal", plan: "free" };
const work = { id: "org-b", name: "Work", plan: "pro" };

describe("Supabase decision", () => {
  it("reuses a live project with the same name", () => {
    const decision = decideSupabase({ organizations: [personal], projects: [{ id: "p1", name: "Expense App", organization_id: "org-a", status: "ACTIVE_HEALTHY" }] }, "expense-app", { orgId: null });
    expect(decision).toMatchObject({ action: "reuse", projectId: "p1" });
  });

  it("does not reuse a paused project with the same name", () => {
    const decision = decideSupabase({ organizations: [personal], projects: [{ id: "p1", name: "expense-app", status: "INACTIVE" }], cost: { amount: 0 } }, "expense-app", { orgId: null });
    expect(decision.action).toBe("create");
  });

  it("uses the only organisation without asking", () => {
    expect(decideSupabase({ organizations: [personal], projects: [], cost: { amount: 0 } }, "app", { orgId: null })).toMatchObject({ action: "create", orgId: "org-a", requiresApproval: false });
  });

  it("asks when there are several organisations and none is remembered", () => {
    expect(decideSupabase({ organizations: [personal, work], projects: [] }, "app", { orgId: null })).toMatchObject({ action: "ask_org", options: [{ id: "org-a" }, { id: "org-b" }] });
  });

  it("uses the remembered organisation, and asks again if it no longer exists", () => {
    expect(decideSupabase({ organizations: [personal, work], projects: [], cost: { amount: 0 } }, "app", { orgId: "org-b" })).toMatchObject({ action: "create", orgId: "org-b" });
    expect(decideSupabase({ organizations: [personal, work], projects: [] }, "app", { orgId: "org-gone" }).action).toBe("ask_org");
  });

  it("asks the user to create an organisation when there is none", () => {
    expect(decideSupabase({ organizations: [], projects: [] }, "app", { orgId: null })).toMatchObject({ action: "ask_org", options: [] });
  });

  it("stops at the free plan's two active projects, counting only that organisation", () => {
    const projects = [
      { id: "1", name: "one", organization_id: "org-a", status: "ACTIVE_HEALTHY" },
      { id: "2", name: "two", organization_id: "org-a", status: "COMING_UP" },
      { id: "3", name: "three", organization_id: "org-b", status: "ACTIVE_HEALTHY" },
    ];
    expect(decideSupabase({ organizations: [personal], projects, cost: { amount: 0 } }, "app", { orgId: null })).toMatchObject({ action: "limit", reusable: [{ id: "1" }, { id: "2" }] });
    expect(decideSupabase({ organizations: [personal], projects: [projects[0], { ...projects[1], status: "INACTIVE" }], cost: { amount: 0 } }, "app", { orgId: null }).action).toBe("create");
    expect(decideSupabase({ organizations: [work], projects, cost: { amount: 0 } }, "app", { orgId: null }).action).toBe("create");
  });

  it("requires the cost before creating, and approval when it isn't free", () => {
    expect(decideSupabase({ organizations: [personal], projects: [] }, "app", { orgId: null }).action).toBe("need_cost");
    expect(decideSupabase({ organizations: [work], projects: [], cost: { amount: 10, recurrence: "monthly" } }, "app", { orgId: null })).toMatchObject({ action: "create", requiresApproval: true });
  });

  it("names the new project after the Meadow project", () => {
    expect(decideSupabase({ organizations: [personal], projects: [], cost: { amount: 0 } }, "My Expense App!", { orgId: null })).toMatchObject({ name: "my-expense-app" });
  });

  it("validates the facts the engine sends", () => {
    expect(supabaseFacts.safeParse({ organizations: "x" }).success).toBe(false);
    expect(supabaseFacts.safeParse({ organizations: [{ id: "", name: "x" }] }).success).toBe(false);
    expect(supabaseFacts.safeParse({ organizations: [personal], cost: { amount: -1 } }).success).toBe(false);
    expect(supabaseFacts.parse({ organizations: [personal] }).projects).toEqual([]);
  });
});

describe("MCP calls the engine made", () => {
  it("reads server and tool from the Cursor CLI's tool call", () => {
    expect(mcpTool({ providerIdentifier: "supabase", toolName: "create_project" })).toEqual({ server: "supabase", tool: "create_project" });
    expect(mcpTool({ name: "supabase-list_projects" })).toEqual({ server: "supabase", tool: "list_projects" });
    expect(parseCursorLine(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { mcpToolCall: { args: { providerIdentifier: "supabase", toolName: "execute_sql" } } } }))[0].title).toBe("MCP supabase:execute_sql");
  });

  it("refuses denied tools, and allows brokered ones only as often as Meadow approved them", () => {
    const used = new Map<string, number>();
    expect(classifyMcpCall("supabase:delete_project", () => 5, used)).toMatchObject({ level: "forbidden", rule: "mcp-denied" });
    expect(classifyMcpCall("supabase:list_projects", () => 0, used)).toMatchObject({ level: "allowed", rule: "mcp" });
    expect(classifyMcpCall("supabase:create_project", () => 1, used)).toMatchObject({ level: "allowed", rule: "mcp-brokered" });
    expect(classifyMcpCall("supabase:create_project", () => 1, used)).toMatchObject({ level: "forbidden", rule: "mcp-unbrokered" });
    expect(classifyMcpCall("project-0-supabase:create_branch", () => 0, new Map())).toMatchObject({ level: "forbidden" });
  });
});

describe("MCP status parsing", () => {
  it("reads the Cursor CLI's mcp list output", () => {
    expect(parseMcpList("\x1b[32msupabase\x1b[0m: requires_authentication\nlinear: ready\nfigma: disabled\n")).toEqual({ supabase: "needs_login", linear: "ready", figma: "not_configured" });
  });
});
