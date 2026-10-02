import { getDb } from "../core/db";
import { git } from "../core/git";
import { registerSecret } from "../core/redact";
import { getSecret, loadConfig } from "../config";
import { getProject } from "../projects";
import { nameVariants } from "./parse";
import { clearProjectGraph, GraphWriter, nodesByKind, type NodeKind } from "./store";

type Progress = (step: string, detail?: string) => void;
type Ticket = { key: string; title: string; body: string; state: string; url: string; createdAt: string | null; closedAt: string | null; labels: string[]; author: string | null; kind: "issue" | "pr" | "incident"; mergeSha?: string | null; references?: string[] };

const TIMEOUT_MS = 20_000;

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  return (await response.json()) as T;
}

export async function githubRepo(projectId: number): Promise<string | null> {
  const configured = loadConfig().atlas.connectors.github.repo;
  if (configured) return configured;
  try {
    const url = (await git(getProject(projectId).path, "remote", "get-url", "origin")).trim();
    return url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function github(projectId: number): Promise<Ticket[]> {
  const token = getSecret("GITHUB_TOKEN");
  const repo = await githubRepo(projectId);
  if (!token || !repo) return [];
  registerSecret(token);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "meadow-atlas" };
  type Item = { number: number; title: string; body: string | null; state: string; html_url: string; created_at: string; closed_at: string | null; labels: Array<{ name: string }>; user: { login: string } | null; pull_request?: unknown; merge_commit_sha?: string | null };
  const [issues, pulls] = await Promise.all([
    fetchJson<Item[]>(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, { headers }),
    fetchJson<Item[]>(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=100`, { headers }),
  ]);
  const toTicket = (item: Item, kind: Ticket["kind"]): Ticket => ({
    key: `#${item.number}`, title: item.title, body: (item.body ?? "").slice(0, 6000), state: item.state, url: item.html_url, createdAt: item.created_at, closedAt: item.closed_at,
    labels: item.labels.map(label => label.name), author: item.user?.login ?? null, kind, mergeSha: item.merge_commit_sha ?? null,
    references: Array.from((item.body ?? "").matchAll(/(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs?)\s+#(\d+)/gi), match => `#${match[1]}`),
  });
  return [
    ...issues.filter(item => !item.pull_request).map(item => toTicket(item, item.labels.some(label => /incident|outage|sev/i.test(label.name)) ? "incident" : "issue")),
    ...pulls.map(item => toTicket(item, "pr")),
  ];
}

async function jira(): Promise<Ticket[]> {
  const settings = loadConfig().atlas.connectors.jira;
  const token = getSecret("JIRA_API_TOKEN");
  if (!token || !settings.baseUrl || !settings.email) return [];
  registerSecret(token);
  const base = settings.baseUrl.replace(/\/$/, "");
  type Issue = { key: string; fields: { summary: string; description: unknown; status: { name: string }; created: string; resolutiondate: string | null; labels: string[]; issuetype: { name: string }; reporter: { displayName: string } | null } };
  const data = await fetchJson<{ issues: Issue[] }>(`${base}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${settings.email}:${token}`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jql: settings.jql, maxResults: 100, fields: ["summary", "description", "status", "created", "resolutiondate", "labels", "issuetype", "reporter"] }),
  });
  const flatten = (node: unknown): string => (!node || typeof node !== "object" ? (typeof node === "string" ? node : "") : "text" in node && typeof node.text === "string" ? node.text : "content" in node && Array.isArray(node.content) ? node.content.map(flatten).join(" ") : "");
  return data.issues.map(issue => ({
    key: issue.key, title: issue.fields.summary, body: flatten(issue.fields.description).slice(0, 6000), state: issue.fields.status.name, url: `${base}/browse/${issue.key}`,
    createdAt: issue.fields.created, closedAt: issue.fields.resolutiondate, labels: issue.fields.labels, author: issue.fields.reporter?.displayName ?? null,
    kind: /incident/i.test(issue.fields.issuetype.name) || issue.fields.labels.some(label => /incident|outage/i.test(label)) ? "incident" : "issue",
  }));
}

async function linear(): Promise<Ticket[]> {
  const settings = loadConfig().atlas.connectors.linear;
  const token = getSecret("LINEAR_API_KEY");
  if (!token) return [];
  registerSecret(token);
  const filter = settings.teamKey ? `(filter: { team: { key: { eq: ${JSON.stringify(settings.teamKey)} } } }, first: 100)` : "(first: 100)";
  type Issue = { identifier: string; title: string; description: string | null; url: string; createdAt: string; completedAt: string | null; state: { name: string }; labels: { nodes: Array<{ name: string }> }; creator: { name: string } | null };
  const data = await fetchJson<{ data: { issues: { nodes: Issue[] } } }>("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ issues${filter} { nodes { identifier title description url createdAt completedAt state { name } labels { nodes { name } } creator { name } } } }` }),
  });
  return data.data.issues.nodes.map(issue => ({
    key: issue.identifier, title: issue.title, body: (issue.description ?? "").slice(0, 6000), state: issue.state.name, url: issue.url, createdAt: issue.createdAt, closedAt: issue.completedAt,
    labels: issue.labels.nodes.map(label => label.name), author: issue.creator?.name ?? null, kind: issue.labels.nodes.some(label => /incident|outage/i.test(label.name)) ? "incident" : "issue",
  }));
}

/** Pulls PRs, issues and incidents from enabled trackers into the graph. Returns the connectors that ran. */
export async function ingestConnectors(projectId: number, onProgress: Progress): Promise<string[]> {
  const settings = loadConfig().atlas.connectors;
  const sources: Array<[string, () => Promise<Ticket[]>]> = [];
  if (settings.github.enabled) sources.push(["github", () => github(projectId)]);
  if (settings.jira.enabled) sources.push(["jira", jira]);
  if (settings.linear.enabled) sources.push(["linear", linear]);
  const ran: string[] = [];
  const services = nodesByKind(projectId, ["service"]).map(node => ({ id: node.id, names: nameVariants(node.name) }));
  for (const [name, load] of sources) {
    onProgress("connectors", `Fetching from ${name}`);
    let tickets: Ticket[];
    try {
      tickets = await load();
    } catch (error) {
      onProgress("connectors", `${name}: ${(error as Error).message}`);
      continue;
    }
    const db = getDb();
    db.raw.exec("BEGIN");
    try {
      clearProjectGraph(projectId, name);
      const g = new GraphWriter(projectId);
      for (const ticket of tickets) {
        const kind: NodeKind = ticket.kind;
        const id = g.node(kind, ticket.key, ticket.kind === "pr" ? `PR ${ticket.key}` : `${ticket.key} ${ticket.title.slice(0, 60)}`, { validFrom: ticket.createdAt, validTo: ticket.kind === "incident" ? null : ticket.closedAt, source: name, props: { title: ticket.title, state: ticket.state, url: ticket.url, labels: ticket.labels } });
        if (ticket.author) g.edge(g.node("person", `${name}:${ticket.author}`, ticket.author, { source: name }), id, "authored", { validFrom: ticket.createdAt });
        if (ticket.mergeSha) {
          const commit = g.find("commit", ticket.mergeSha);
          if (commit) g.edge(id, commit, "includes");
        }
        for (const ref of ticket.references ?? []) {
          const target = g.find("issue", ref) ?? g.find("incident", ref);
          if (target) g.edge(id, target, "fixes");
        }
        const lower = `${ticket.title}\n${ticket.body}`.toLowerCase();
        for (const service of services) if (service.names.some(variant => lower.includes(variant))) g.edge(id, service.id, ticket.kind === "pr" ? "changes" : "affects", { validFrom: ticket.createdAt });
        g.doc(id, ticket.kind, `${ticket.kind === "pr" ? "PR" : ticket.kind === "incident" ? "Incident" : "Issue"} ${ticket.key}: ${ticket.title}`, `${ticket.title}\nState: ${ticket.state}\nLabels: ${ticket.labels.join(", ")}\n${ticket.url}\n\n${ticket.body}`, { ts: ticket.createdAt, meta: { source: name, url: ticket.url } });
      }
      db.raw.exec("COMMIT");
      ran.push(name);
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }
  }
  return ran;
}
