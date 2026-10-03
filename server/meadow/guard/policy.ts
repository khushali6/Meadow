import os from "node:os";
import path from "node:path";
import { isInside } from "../core/paths";

/**
 * forbidden: never runs, from the engine or the broker. approval: only through Meadow's broker after the user
 * approves on Telegram or the dashboard. allowed: the engine may run it inside the project.
 */
export type PolicyLevel = "forbidden" | "approval" | "allowed";
export type Verdict = { level: PolicyLevel; rule: string; reason: string };

type Rule = { level: Exclude<PolicyLevel, "allowed">; rule: string; reason: string; test: (segment: string, ctx: { projectPath: string; whole: string }) => boolean };

const HOME_SECRET = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+|%USERPROFILE%)[\\/](\.ssh|\.aws|\.gnupg|\.meadow|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.config\/gh|\.kube|Library\/Keychains|\.cursor\/(mcp\.json|cli-config\.json))/i;
const ENV_FILE = /(^|[\s"'=/])\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?(?=$|[\s"';|&)])/;

const word = (name: string) => new RegExp(`(^|[\\s;&|(])${name}(?=$|\\s)`);

/** Paths a command would delete, for rm-like commands. */
function deletionTargets(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/);
  const index = tokens.findIndex(token => /^(rm|rmdir|unlink|shred|del|rd|Remove-Item)$/i.test(token));
  if (index < 0) return [];
  return tokens.slice(index + 1).filter(token => !token.startsWith("-")).map(token => token.replace(/^["']|["']$/g, ""));
}

function outsideProject(target: string, projectPath: string): boolean {
  if (!target) return false;
  const expanded = target.replace(/^\$\{?PWD\}?/, projectPath);
  // Allow $1–$9, $@, $*, $#, $?, $!, $_, $$ (positional/special shell params in function bodies).
  // Block anything else that looks like a named env-var expansion: $HOME, $VAR, ${VAR}, etc.
  if (/^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)/.test(expanded) || /[`]/.test(expanded) || /\$(?![0-9@*#?!_\-$])/.test(expanded)) return true;
  const resolved = path.resolve(projectPath, expanded.replace(/[*?[].*$/, "") || ".");
  const temp = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders"].some(dir => isInside(dir, resolved) && path.resolve(dir) !== resolved);
  return !temp && !isInside(projectPath, resolved);
}

const RULES: Rule[] = [
  { level: "forbidden", rule: "privilege", reason: "Running as an administrator (sudo, su, doas, runas) is never allowed.", test: segment => word("(sudo|doas|su|runas|pkexec)").test(segment) },
  { level: "forbidden", rule: "delete-outside", reason: "Deleting files outside the project folder is never allowed.", test: (segment, ctx) => deletionTargets(segment).some(target => outsideProject(target, ctx.projectPath)) },
  { level: "forbidden", rule: "secrets", reason: "Reading keys, tokens, keychains or Meadow's own data is never allowed.", test: segment => HOME_SECRET.test(segment) || /\bsecurity\s+(find|dump|export)-/.test(segment) || /\b(cat|less|more|head|tail|type|Get-Content|grep|rg|cp|scp|curl\s+-F|base64)\b/.test(segment) && ENV_FILE.test(segment) },
  { level: "forbidden", rule: "git-remote", reason: "Changing git remotes, force-pushing or rewriting published history is never allowed; Meadow pushes for you.", test: segment => /\bgit\s+remote\s+(add|set-url|remove|rm|rename)\b/.test(segment) || /\bgit\s+push\b.*(\s--force(-with-lease)?\b|\s-f\b|\s--mirror\b|\s--delete\b|\s:\S)/.test(segment) },
  { level: "forbidden", rule: "pipe-to-shell", reason: "Piping a download straight into a shell is never allowed.", test: (_segment, ctx) => /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b|\b(curl|wget)\b[^|]*\|\s*(python3?|node|ruby|perl|iex)\b/.test(ctx.whole) },
  { level: "forbidden", rule: "system-damage", reason: "Commands that can damage the system (disk formatting, raw device writes, shutdown, fork bombs) are never allowed.", test: segment => /\b(mkfs(\.\w+)?|fdisk|diskutil\s+(erase|partition)|format\s+[a-z]:)\b/i.test(segment) || /\bdd\b.*\bof=\/dev\//.test(segment) || word("(shutdown|reboot|halt|poweroff)").test(segment) || /:\(\)\s*\{\s*:\|:&\s*\};:/.test(segment) || /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/.test(segment) },
  { level: "forbidden", rule: "persistence", reason: "Installing background services, login items or scheduled jobs is never allowed.", test: segment => /\b(crontab|launchctl\s+(load|bootstrap|submit|enable)|systemctl\s+(enable|--user\s+enable)|schtasks\s+\/create|reg\s+add)\b/i.test(segment) },
  { level: "forbidden", rule: "exfiltration", reason: "Sending files to outside servers is never allowed.", test: segment => /\b(curl|wget)\b.*(\s(-T|--upload-file|-d\s*@|--data-binary\s*@|-F\s*\S*=@))/.test(segment) || /\b(nc|ncat|netcat)\b\s+\S+\s+\d+/.test(segment) || /\bscp\b|\brsync\b.*\S+@\S+:/.test(segment) },
  { level: "approval", rule: "system-package", reason: "Installing system software changes your computer outside the project.", test: segment => /\b(brew|port)\s+(install|reinstall|upgrade|uninstall|remove|tap)\b/.test(segment) || /\b(apt|apt-get|yum|dnf|pacman|zypper|apk|snap)\s+(install|remove|upgrade|-S)\b/.test(segment) || /\b(winget|choco|scoop)\s+(install|uninstall|upgrade)\b/.test(segment) },
  { level: "approval", rule: "global-install", reason: "Global installs change tools for every project on this computer.", test: segment => /\b(npm|pnpm)\s+(i|install|add)\b.*\s(-g|--global)\b/.test(segment) || /\byarn\s+global\s+add\b/.test(segment) || /\b(pipx|cargo|gem|go)\s+install\b/.test(segment) || /\bpip3?\s+install\b.*\s--user\b/.test(segment) || /\bnpm\s+link\b/.test(segment) || /\bcorepack\s+enable\b/.test(segment) },
  { level: "approval", rule: "docker", reason: "Docker starts containers and downloads images on your computer.", test: segment => /\bdocker(-compose)?\s+(?!(ps|version|info|images|logs|inspect)\b)\w+/.test(segment) || /\bpodman\s+(?!(ps|version|info|images)\b)\w+/.test(segment) },
  { level: "approval", rule: "deploy", reason: "Deploying or changing a hosted service affects things outside this computer.", test: segment => /\b(vercel|netlify|fly|flyctl|railway|heroku|firebase)\s+(deploy|--prod|up|launch|apps\s+create|projects\s+create)\b/.test(segment) || /\bsupabase\s+(db\s+push|projects\s+(create|delete)|link|functions\s+deploy|secrets\s+set)\b/.test(segment) || /\bgh\s+(repo\s+(create|delete|edit)|release\s+create|secret\s+set)\b/.test(segment) },
  { level: "approval", rule: "git-push", reason: "Pushing code to a remote; Meadow pushes passed phases itself.", test: segment => /\bgit\s+push\b/.test(segment) },
];

/** Splits a shell line into the commands it runs (`a && b; c | d`), keeping the whole line for pipe rules. */
export function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\n|\|(?!\|)/).map(part => part.trim()).filter(Boolean);
}

export function classifyCommand(command: string, projectPath: string): Verdict {
  const ctx = { projectPath, whole: command };
  let approval: Verdict | null = null;
  for (const segment of commandSegments(command)) {
    for (const rule of RULES) {
      if (!rule.test(segment, ctx)) continue;
      if (rule.level === "forbidden") return { level: "forbidden", rule: rule.rule, reason: rule.reason };
      approval ??= { level: "approval", rule: rule.rule, reason: rule.reason };
    }
  }
  return approval ?? { level: "allowed", rule: "project", reason: "Runs inside the project." };
}

/** Destructive MCP tools the engine may never call; Meadow's broker handles creation with cost checks. */
export const DENIED_MCP_TOOLS: Record<string, string[]> = {
  supabase: ["delete_project", "pause_project", "restore_project", "delete_branch", "reset_branch", "merge_branch", "rebase_branch", "create_branch"],
  // GitHub: deleting repos, force-pushing and secrets manipulation are never allowed through the engine.
  github: ["delete_repository", "update_file", "push_files", "create_or_update_file", "delete_file", "set_secret", "delete_secret", "merge_pull_request"],
};

/** MCP tools the engine may only call after Meadow's broker approved it (request_cloud_resource); checked after each run. */
export const BROKERED_MCP_TOOLS: Record<string, { tool: string; brokerAudit: string }[]> = {
  supabase: [{ tool: "create_project", brokerAudit: "broker.cloud.supabase.create_project" }],
  // GitHub: creating repos must go through the broker so Meadow's guardrails (private-only, no force) apply.
  github: [{ tool: "create_repository", brokerAudit: "broker.cloud.github.create_repository" }],
};

/**
 * An MCP call (`server:tool`) the engine made. `approvals(brokerAudit)` is how many times Meadow's broker approved
 * that action during the run; each approval covers one call, tracked in `used`.
 */
export function classifyMcpCall(call: string, approvals: (brokerAudit: string) => number, used: Map<string, number>): Verdict {
  const [server = "", tool = ""] = call.toLowerCase().split(":");
  const match = (name: string) => server === name || server.endsWith(`-${name}`) || server.startsWith(`${name}-`);
  for (const [name, tools] of Object.entries(DENIED_MCP_TOOLS)) {
    if (match(name) && tools.includes(tool)) return { level: "forbidden", rule: "mcp-denied", reason: `${name}'s ${tool} can delete data or cost money; Meadow never lets the engine call it.` };
  }
  for (const [name, entries] of Object.entries(BROKERED_MCP_TOOLS)) {
    const entry = entries.find(item => match(name) && item.tool === tool);
    if (!entry) continue;
    const count = (used.get(entry.brokerAudit) ?? 0) + 1;
    used.set(entry.brokerAudit, count);
    if (count > approvals(entry.brokerAudit)) return { level: "forbidden", rule: "mcp-unbrokered", reason: `The engine called ${name}'s ${tool} without Meadow's approval (request_cloud_resource).` };
    return { level: "allowed", rule: "mcp-brokered", reason: "Approved by Meadow's broker." };
  }
  return { level: "allowed", rule: "mcp", reason: "MCP tool call." };
}

/**
 * Cursor CLI permissions for the project (`.cursor/cli.json`). `--force` still honours `deny`, so these hold even in
 * fully automatic runs. Meadow also checks every command the engine ran afterwards, so a rule the CLI misses is caught.
 */
export function cliPermissions(): { permissions: { allow: string[]; deny: string[] } } {
  const shellDeny = ["sudo", "su", "doas", "pkexec", "brew", "port", "apt", "apt-get", "yum", "dnf", "pacman", "snap", "winget", "choco", "scoop", "docker", "docker-compose", "podman", "launchctl", "crontab", "systemctl", "security", "mkfs", "diskutil", "dd", "shutdown", "reboot", "halt", "poweroff", "pipx", "vercel", "netlify", "flyctl", "railway", "heroku", "nc", "ncat", "netcat", "scp", "git remote", "git push"];
  const home = os.homedir();
  const readDeny = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.meadow/**", "~/.config/gh/**", "~/.netrc", "~/.npmrc", "~/.docker/config.json", "~/Library/Keychains/**", "~/.cursor/mcp.json", "~/.cursor/cli-config.json", "**/.env", "**/.env.local", "**/.env.production", "**/*.pem", "**/id_rsa", "**/id_ed25519"];
  const writeDeny = ["~/.ssh/**", "~/.meadow/**", "~/.zshrc", "~/.bashrc", "~/.bash_profile", "~/.profile", "~/.gitconfig", "~/Library/LaunchAgents/**", "PLAN.md", "SPEC.md", ".meadow/**", ".cursor/cli.json", ".cursor/mcp.json", ".git/**"];
  const mcpDeny = Object.entries(DENIED_MCP_TOOLS).flatMap(([server, tools]) => tools.map(tool => `Mcp(${server}:${tool})`));
  // Also deny the short-name variants the GitHub MCP may expose.
  const githubExtra = ["Mcp(github:delete_repository)", "Mcp(github:push_files)", "Mcp(github:set_secret)", "Mcp(github:delete_secret)", "Mcp(github:merge_pull_request)"];
  return {
    permissions: {
      allow: ["Shell(ls)", "Shell(cat)", "Shell(node)", "Shell(npm)", "Shell(pnpm)", "Shell(yarn)", "Shell(npx)", "Shell(git status)", "Shell(git diff)", "Shell(git log)", "Mcp(meadow:*)", "Mcp(github:get_*)", "Mcp(github:list_*)", "Mcp(github:search_*)", "Mcp(github:create_issue)", "Mcp(github:create_pull_request)", "Mcp(github:get_pull_request)", "Mcp(github:list_pull_requests)"],
      deny: [...shellDeny.map(name => `Shell(${name})`), ...readDeny.map(glob => `Read(${glob.replace(/^~/, home)})`), ...writeDeny.map(glob => `Write(${glob.replace(/^~/, home)})`), ...mcpDeny, ...githubExtra],
    },
  };
}

/** What the engine is told about the rules, so it routes privileged work through Meadow instead of failing. */
export const POLICY_PROMPT = [
  "Guardrails (enforced by Meadow; breaking them blocks the phase):",
  "- Never use sudo/su, delete outside the project, read ~/.ssh, ~/.meadow, keychains or .env files, change git remotes, push, force-push, pipe downloads into a shell, or install background services.",
  "- For system installs (brew, apt, winget), global installs (npm -g, pipx, cargo install), Docker, deployments or creating cloud resources, call the Meadow MCP tool `request_system_action` or `request_cloud_resource` with the exact command and why. Meadow asks the user and runs it for you.",
  "- If you need a decision only the user can make (a product choice, an account, a missing credential), call the Meadow MCP tool `ask_human` instead of guessing. To send a status update or milestone without waiting for a reply, call `notify_human` (fire-and-forget).",
  "- Install project dependencies locally (npm/pnpm/yarn install, a Python virtualenv inside the project).",
].join("\n");
