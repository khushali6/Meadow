import { getApproval, requestApproval } from "../core/approvals";
import { audit } from "../core/audit";
import { loadConfig, saveConfig } from "../config";
import { askHuman } from "../guard/broker";
import { getProject } from "../projects";
import { dockerStatus } from "./registry";
import { ensureGithubRepo } from "./github";
import { decideSupabase, supabaseFacts, type SupabaseDecision } from "./supabase";

export type CloudReply = { ok: boolean; message: string; decision?: SupabaseDecision };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitApproval(id: number, pollMs: number): Promise<boolean> {
  while (true) {
    const row = getApproval(id);
    if (!row || row.status === "expired" || row.status === "denied" || (row.status === "pending" && Date.parse(row.expires_at) < Date.now())) return false;
    if (row.status === "approved") return true;
    await sleep(pollMs);
  }
}

function createInstructions(decision: Extract<SupabaseDecision, { action: "create" }>): string {
  return `Approved: create the Supabase project "${decision.name}" in organisation ${decision.orgName} (${decision.orgId}). Use get_cost then confirm_cost, then create_project with that confirmation id and the region closest to the user. Wait until it is ACTIVE_HEALTHY, then get its URL and publishable (anon) key and write them to .env.local as SUPABASE_URL and SUPABASE_ANON_KEY (make sure .env.local is gitignored; never commit keys, never print the service role key). Add the same names without values to .env.example.`;
}

async function supabase(projectId: number, details: unknown, pollMs: number): Promise<CloudReply> {
  const project = getProject(projectId);
  const parsed = supabaseFacts.safeParse(details);
  if (!parsed.success) return { ok: false, message: `Send the facts first: call list_organizations and list_projects with the Supabase MCP tools and pass them as details {organizations, projects, cost?}. Problems: ${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
  let decision = decideSupabase(parsed.data, project.name, { orgId: loadConfig().services.supabase.orgId });
  if (decision.action === "ask_org") {
    if (!decision.options.length) {
      await askHuman({ projectId, question: decision.reason, options: ["Done"], pollMs });
      return { ok: false, message: "Call list_organizations again (the user was asked to create an organisation) and resend the facts.", decision };
    }
    const answer = await askHuman({ projectId, question: "Which Supabase organisation should Meadow use for your projects? (asked once)", options: decision.options.map(option => option.name), pollMs });
    const org = decision.options.find(option => option.name === answer.answer);
    if (!org) return { ok: false, message: "The user didn't pick an organisation. Stop Supabase setup, build with a local database for now, and say so in your report.", decision };
    saveConfig({ services: { supabase: { orgId: org.id, orgName: org.name } } });
    decision = decideSupabase(parsed.data, project.name, { orgId: org.id });
  }
  if (decision.action === "limit") {
    const reuse = decision.reusable.map(item => `Reuse ${item.name}`);
    const answer = await askHuman({ projectId, question: `${decision.reason} Reuse one of them for ${project.name}, or pause one yourself in the Supabase dashboard and tap "I paused one".`, options: [...reuse, "I paused one"], pollMs });
    const picked = decision.reusable.find(item => answer.answer === `Reuse ${item.name}`);
    if (picked) return { ok: true, message: `Reuse the existing Supabase project "${picked.name}" (${picked.id}): read its URL and publishable key and write them to .env.local as SUPABASE_URL and SUPABASE_ANON_KEY. Keep this app's tables separate (prefix them with the project name).`, decision: { action: "reuse", projectId: picked.id, name: picked.name, reason: "Picked by the user" } };
    if (answer.answer === "I paused one") return { ok: false, message: "The user paused a project. Call list_projects again and resend the facts.", decision };
    return { ok: false, message: "No Supabase project is available. Build with a local database for now and say so in your report.", decision };
  }
  if (decision.action === "need_cost" || decision.action === "ask_org") return { ok: false, message: decision.reason, decision };
  if (decision.action === "reuse") return { ok: true, message: `Reuse the existing Supabase project "${decision.name}" (${decision.projectId}): read its URL and publishable key and write them to .env.local as SUPABASE_URL and SUPABASE_ANON_KEY.`, decision };
  if (decision.requiresApproval) {
    const { id } = requestApproval({ projectId, kind: "cloud.supabase", title: `Create a paid Supabase project for ${project.name}?`, detail: `${decision.reason}\nOrganisation: ${decision.orgName}`, risk: "high", detached: true });
    if (!(await waitApproval(id, pollMs))) {
      audit({ projectId, agent: "engine", user: "owner", tool: "broker.cloud.supabase.create_project", risk: "HIGH_WRITE", args: { org: decision.orgId }, approval: "denied", result: "refused", durationMs: 0, detail: decision.reason });
      return { ok: false, message: "The user did not approve a paid project. Build with a local database instead and say so in your report.", decision };
    }
  }
  audit({ projectId, agent: "engine", user: decision.requiresApproval ? "owner" : "policy", tool: "broker.cloud.supabase.create_project", risk: "HIGH_WRITE", args: { org: decision.orgId, name: decision.name }, approval: decision.requiresApproval ? "approved" : "not_required", result: "ok", durationMs: 0, detail: decision.reason });
  return { ok: true, message: createInstructions(decision), decision };
}

async function docker(projectId: number, pollMs: number): Promise<CloudReply> {
  if ((await dockerStatus()).status === "ready") return { ok: true, message: "Docker is running." };
  const status = await dockerStatus();
  if (status.status === "not_installed") {
    const answer = await askHuman({ projectId, question: "This project wants Docker, which isn't installed. Install Docker Desktop and tap Done, or tap Skip to build without containers.", options: ["Done", "Skip"], pollMs });
    if (answer.answer !== "Done") return { ok: false, message: "Docker isn't available. Build without containers (for example a local SQLite or an in-process server) and say so in your report." };
  } else {
    await askHuman({ projectId, question: "Docker is installed but not running. Start Docker Desktop on your computer, then tap Done.", options: ["Done", "Skip"], pollMs });
  }
  for (let i = 0; i < 40; i++) {
    if ((await dockerStatus()).status === "ready") return { ok: true, message: "Docker is running now." };
    await sleep(3000);
  }
  return { ok: false, message: "Docker still isn't running. Build without containers for now and say so in your report." };
}

/** The broker's `request_cloud_resource`: Meadow decides, asks the user when the rules say so, and tells the engine what to do. */
export async function requestCloudResource(input: { projectId: number; service: string; action: string; details?: unknown; pollMs?: number }): Promise<CloudReply> {
  const pollMs = input.pollMs ?? 1500;
  switch (input.service) {
    case "supabase":
      return supabase(input.projectId, input.details ?? {}, pollMs);
    case "github": {
      const result = await ensureGithubRepo(getProject(input.projectId));
      return { ok: result.status !== "skipped", message: `${result.detail}${result.status !== "skipped" ? " Meadow pushes passed phases itself; don't push." : ""}` };
    }
    case "docker":
      return docker(input.projectId, pollMs);
    default:
      return { ok: false, message: `Meadow has no rules for "${input.service}". Use ask_human to ask the user how to get it, or build without it.` };
  }
}
