import { redact } from "../core/redact";
import { bus } from "../core/events";
import { getInvestigation, investigate, type InvestigationResult } from "./agents";
import { ingestProject } from "./ingest";
import { graphStats } from "./store";
import { runTool, type ToolActor } from "./tools";

type ChatButton = { label: string; action: string };
export type ChatAnswer = { text: string; buttons?: ChatButton[][] };

const AGENT_ICON: Record<string, string> = { supervisor: "🧭", researcher: "🔎", architect: "🏗", operator: "🛠", writer: "✍️", verifier: "✅" };
const MAX_TRACE_LINES = 8;

export function formatAnswer(result: InvestigationResult): ChatAnswer {
  if (result.status === "failed") return { text: `Investigation #${result.id} failed: ${result.error ?? "unknown error"}` };
  const v = result.verifier;
  const lines = [
    `🔍 CodeAtlas #${result.id} · ${result.mode} · ${v.supported}/${v.total} claims verified`,
    "",
    result.answer.replace(/\*\*/g, "").replace(/`/g, "'"),
  ];
  if (result.suspects[0]) lines.push("", `Top suspect: ${result.suspects[0].title}`, ...result.suspects[0].highlights.slice(0, 3).map(line => `  ${line}`));
  lines.push("", "Sources:", ...result.evidence.slice(0, 6).map(item => `[${item.n}] ${item.title}${item.path ? ` (${item.path})` : ""}`));
  const buttons = result.actions.map(action => ({ label: action.tool === "propose_patch" ? "🛠 Fix with Meadow" : "📝 Create issue", action: `atlas:${result.id}:${action.tool === "propose_patch" ? "patch" : "issue"}` }));
  return { text: redact(lines.join("\n")).slice(0, 3900), buttons: buttons.length ? [buttons] : undefined };
}

/** Runs an investigation, calling onProgress with a compact trace card as agents report in. */
export async function chatInvestigate(projectId: number, question: string, actor: ToolActor, onProgress?: (card: string) => void): Promise<ChatAnswer> {
  if (!graphStats(projectId).lastIngest) {
    onProgress?.("📚 Building the knowledge graph first (one-time)…");
    await ingestProject(projectId);
  }
  const trace: string[] = [];
  let investigationId = 0;
  const unsubscribe = bus.onEvent(event => {
    if (event.type !== "atlas_trace" || (event.payload as { investigationId?: number } | undefined)?.investigationId !== investigationId) return;
    const agent = String((event.payload as { agent?: string }).agent ?? "");
    trace.push(`${AGENT_ICON[agent] ?? "•"} ${event.title}${event.detail ? ` — ${event.detail.split("\n")[0].slice(0, 120)}` : ""}`);
    onProgress?.([`🔍 Investigating: ${question.slice(0, 200)}`, "", ...trace.slice(-MAX_TRACE_LINES)].join("\n"));
  });
  try {
    const result = await investigate(projectId, question, { actor, onStart: id => (investigationId = id) });
    return formatAnswer(result);
  } finally {
    unsubscribe();
  }
}

/** Handles the "atlas:<investigationId>:patch|issue" buttons. Write tools only queue an approval. */
export async function chatAction(investigationId: number, which: string, actor: ToolActor): Promise<string> {
  const result = getInvestigation(investigationId);
  if (!result) return "That investigation no longer exists.";
  const tool = which === "patch" ? "propose_patch" : "create_issue";
  const action = result.actions?.find(item => item.tool === tool);
  if (!action) return "That action is not available for this investigation.";
  const outcome = await runTool(tool, action.args, { projectId: result.projectId, actor, investigationId });
  return outcome.pending ? `${outcome.summary}\nApprove it when the approval card arrives.` : outcome.summary;
}
