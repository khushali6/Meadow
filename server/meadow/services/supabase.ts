import { z } from "zod";

/**
 * Facts the engine gathered with the Supabase MCP tools (list_organizations, list_projects, get_cost). Meadow, not
 * the model, decides what to do with them, so the same facts always lead to the same choice.
 */
export const supabaseFacts = z.object({
  organizations: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), plan: z.string().max(40).optional() }).passthrough()).max(50),
  projects: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200), organization_id: z.string().max(100).optional(), status: z.string().max(60).optional(), region: z.string().max(60).optional() }).passthrough()).max(200).default([]),
  cost: z.object({ amount: z.number().min(0), recurrence: z.string().max(40).optional() }).nullable().optional(),
});
export type SupabaseFacts = z.infer<typeof supabaseFacts>;

export type SupabaseDecision =
  | { action: "reuse"; projectId: string; name: string; reason: string }
  | { action: "create"; orgId: string; orgName: string; name: string; requiresApproval: boolean; reason: string }
  | { action: "ask_org"; options: Array<{ id: string; name: string }>; reason: string }
  | { action: "limit"; orgId: string; reusable: Array<{ id: string; name: string }>; reason: string }
  | { action: "need_cost"; orgId: string; reason: string };

const FREE_ACTIVE_LIMIT = 2;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const inactive = (status?: string) => /inactive|paused|removed|deleted|pausing|removing/i.test(status ?? "");

export function decideSupabase(facts: SupabaseFacts, projectName: string, remembered: { orgId: string | null }): SupabaseDecision {
  const wanted = slug(projectName);
  const existing = facts.projects.find(project => slug(project.name) === wanted && !inactive(project.status));
  if (existing) return { action: "reuse", projectId: existing.id, name: existing.name, reason: `A Supabase project named ${existing.name} already exists; reusing it.` };
  if (!facts.organizations.length) return { action: "ask_org", options: [], reason: "Your Supabase account has no organisation yet. Create one at supabase.com/dashboard, then answer here." };
  const org = facts.organizations.find(item => item.id === remembered.orgId) ?? (facts.organizations.length === 1 ? facts.organizations[0] : undefined);
  if (!org) return { action: "ask_org", options: facts.organizations.map(item => ({ id: item.id, name: item.name })), reason: "You have several Supabase organisations; pick one once and Meadow reuses it." };
  const active = facts.projects.filter(project => (project.organization_id ?? org.id) === org.id && !inactive(project.status));
  if (/free/i.test(org.plan ?? "free") && active.length >= FREE_ACTIVE_LIMIT) {
    return { action: "limit", orgId: org.id, reusable: active.map(project => ({ id: project.id, name: project.name })), reason: `The free plan allows ${FREE_ACTIVE_LIMIT} active projects and ${org.name} already has ${active.length}.` };
  }
  if (facts.cost === undefined || facts.cost === null) return { action: "need_cost", orgId: org.id, reason: "Call get_cost (type: project) for this organisation and send the amount, so Meadow can check it's free." };
  const free = facts.cost.amount === 0;
  return { action: "create", orgId: org.id, orgName: org.name, name: wanted || "meadow-app", requiresApproval: !free, reason: free ? "A new project is free on this plan; creating it." : `A new project costs ${facts.cost.amount} ${facts.cost.recurrence ?? ""}; this needs your approval.`.trim() };
}
