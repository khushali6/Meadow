import { isMap, isSeq, LineCounter, parseDocument, type Node as YamlNode } from "yaml";

export type Check =
  | { kind: "cmd"; cmd: string; expectRegex?: string; timeoutS?: number }
  | { kind: "file_exists"; path: string }
  | { kind: "http"; path: string; expectStatus: number };

export type PlanPhase = {
  id: string;
  name: string;
  dependsOn: string[];
  tasks: string[];
  checks: Check[];
  doneWhen: string;
};

export type Preview = { command: string; url: string; readyTimeoutS: number; routes: string[] };

/** Per-project UI design specification provided by the user. */
export type UiConfig = {
  /** Free-text visual direction: mood, references, palette hints, animation style. Max 2000 chars. */
  prompt?: string;
  /** Preferred animation library: "motion" | "gsap" | "anime" | "css". Defaults to "motion". */
  animations?: string;
  /** A URL to a site/screenshot for visual inspiration (just used as a text hint in the design brief). */
  reference?: string;
};

export type Plan = {
  project: string;
  goal: string;
  stack: string[];
  constraints: string[];
  services: string[];
  preview: Preview | null;
  phases: PlanPhase[];
  /** Optional UI design spec. When present, Meadow generates a unique design brief before phase 1. */
  ui: UiConfig | null;
  body: string;
};

export type PlanError = { line: number | null; field: string; message: string };

export type ParseResult = { ok: true; plan: Plan; errors: []; warnings: PlanError[] } | { ok: false; plan: null; errors: PlanError[]; warnings: PlanError[] };

const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
export const KNOWN_SERVICES = ["supabase", "docker", "github"];
export const MAX_PHASES = 12;
export const SERVICES_PHASE_ID = "services";

/** The built-in first phase for plans with a `services:` list: connect them through Meadow and verify locally. */
export function servicesPhase(services: string[]): Record<string, unknown> | null {
  const tasks: string[] = [];
  const checks: Array<Record<string, string>> = [];
  if (services.includes("supabase")) {
    tasks.push(
      "Call the Meadow tool request_cloud_resource with service supabase and action create_or_reuse_project; first gather list_organizations, list_projects and get_cost with the Supabase tools and pass them as details. Follow Meadow's reply exactly",
      "Write SUPABASE_URL and SUPABASE_ANON_KEY to .env.local, make sure .gitignore ignores .env.local, and list both names (without values) in .env.example. Never print, cat or grep .env.local",
      "Create the database tables the app needs with Supabase migrations (apply_migration), never by dropping existing tables",
    );
    checks.push(
      { cmd: "git check-ignore -q .env.local" },
      { cmd: "node -e \"const s=require('fs').readFileSync('.env.local','utf8');process.exit(/^SUPABASE_URL=https:\\/\\/\\S+/m.test(s)&&/^SUPABASE_ANON_KEY=\\S+/m.test(s)?0:1)\"" },
      { cmd: "grep -q SUPABASE_URL .env.example" },
    );
  }
  if (services.includes("docker")) {
    tasks.push("Make sure Docker is running: call request_cloud_resource with service docker and action start if it isn't");
    checks.push({ cmd: "docker info --format '{{.ServerVersion}}'" });
  }
  if (!tasks.length) return null;
  return { id: SERVICES_PHASE_ID, name: "Connect services", tasks, checks, done_when: "Every service in the plan is connected and its settings are saved locally without committing secrets" };
}

/** Adds the built-in services phase at the start of a plan that lists services and doesn't have it yet. */
export function withServicesPhase(markdown: string): string {
  const parsed = parsePlan(markdown);
  if (!parsed.ok || parsed.plan.phases.some(phase => phase.id === SERVICES_PHASE_ID)) return markdown;
  const phase = servicesPhase(parsed.plan.services);
  if (!phase) return markdown;
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(FRONT_MATTER)!;
  const doc = parseDocument(match[1]);
  const phases = doc.get("phases", true);
  if (!isSeq(phases)) return markdown;
  phases.items.unshift(doc.createNode(phase) as (typeof phases.items)[number]);
  return `---\n${doc.toString().trimEnd()}\n---\n${normalized.slice(match[0].length)}`;
}

export function checkLabel(check: Check): string {
  if (check.kind === "cmd") return check.cmd;
  if (check.kind === "file_exists") return `file exists: ${check.path}`;
  return `GET ${check.path} → ${check.expectStatus}`;
}

export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function parsePlan(markdown: string): ParseResult {
  const errors: PlanError[] = [];
  const warnings: PlanError[] = [];
  const match = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").match(FRONT_MATTER);
  if (!match) {
    return { ok: false, plan: null, errors: [{ line: 1, field: "front-matter", message: "PLAN.md must start with YAML front-matter between two `---` lines." }], warnings };
  }
  const lineOffset = 1; // the opening --- line
  const counter = new LineCounter();
  const doc = parseDocument(match[1], { lineCounter: counter, prettyErrors: false });
  const lineOf = (node: unknown): number | null => {
    const range = (node as YamlNode | undefined)?.range;
    return range ? counter.linePos(range[0]).line + lineOffset : null;
  };
  for (const error of doc.errors) {
    errors.push({ line: error.linePos?.[0]?.line ? error.linePos[0].line + lineOffset : null, field: "yaml", message: error.message.split("\n")[0] });
  }
  if (errors.length) return { ok: false, plan: null, errors, warnings };
  const root = doc.contents;
  if (!isMap(root)) return { ok: false, plan: null, errors: [{ line: 2, field: "front-matter", message: "Front-matter must be a YAML mapping." }], warnings };

  const getNode = (map: unknown, key: string) => (isMap(map) ? (map.get(key, true) as YamlNode | undefined) : undefined);
  const data = doc.toJS() as Record<string, unknown>;
  const err = (node: unknown, field: string, message: string) => errors.push({ line: lineOf(node) ?? lineOf(root), field, message });

  const str = (value: unknown, node: unknown, field: string, required = true): string => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    if (required) err(node, field, value === undefined ? `\`${field}\` is required.` : `\`${field}\` must be a non-empty string.`);
    return "";
  };
  const strList = (value: unknown, node: unknown, field: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      err(node, field, `\`${field}\` must be a list.`);
      return [];
    }
    return value.map((item, i) => {
      if (typeof item !== "string" && typeof item !== "number") err(isSeq(node) ? node.items[i] : node, `${field}[${i}]`, "List items must be strings.");
      return String(item);
    });
  };

  const project = str(data.project, getNode(root, "project"), "project");
  const goal = str(data.goal, getNode(root, "goal"), "goal");
  const stack = strList(data.stack, getNode(root, "stack"), "stack");
  const constraints = strList(data.constraints, getNode(root, "constraints"), "constraints");
  const services = [...new Set(strList(data.services, getNode(root, "services"), "services").map(name => name.trim().toLowerCase()))];
  for (const name of services) {
    if (!/^[a-z0-9][\w.-]{0,40}$/.test(name)) err(getNode(root, "services"), "services", `"${name}" is not a valid service name.`);
    else if (!KNOWN_SERVICES.includes(name)) warnings.push({ line: lineOf(getNode(root, "services")), field: "services", message: `Meadow has no setup rules for "${name}"; the engine will ask you how to connect it.` });
  }

  let preview: Preview | null = null;
  if (data.preview !== undefined && data.preview !== null) {
    const node = getNode(root, "preview");
    const p = data.preview as Record<string, unknown>;
    if (typeof p !== "object" || Array.isArray(p)) {
      err(node, "preview", "`preview` must be a mapping with command and url.");
    } else {
      const command = str(p.command, getNode(node, "command") ?? node, "preview.command");
      const url = str(p.url, getNode(node, "url") ?? node, "preview.url");
      if (url && !isLocalUrl(url)) err(getNode(node, "url") ?? node, "preview.url", "Preview URL must be on localhost (http://localhost:<port> or http://127.0.0.1:<port>).");
      const readyTimeoutS = p.ready_timeout === undefined ? 60 : Number(p.ready_timeout);
      if (!Number.isFinite(readyTimeoutS) || readyTimeoutS <= 0) err(getNode(node, "ready_timeout") ?? node, "preview.ready_timeout", "`ready_timeout` must be a positive number of seconds.");
      const routes = p.routes === undefined ? ["/"] : strList(p.routes, getNode(node, "routes"), "preview.routes");
      for (const route of routes) if (!route.startsWith("/")) err(getNode(node, "routes") ?? node, "preview.routes", `Route "${route}" must start with "/".`);
      preview = { command, url, readyTimeoutS, routes };
    }
  }

  const phasesNode = getNode(root, "phases");
  const phases: PlanPhase[] = [];
  if (!Array.isArray(data.phases) || data.phases.length === 0) {
    err(phasesNode ?? root, "phases", "`phases` must be a non-empty list.");
  } else {
    const seen = new Set<string>();
    data.phases.forEach((raw, i) => {
      const node = isSeq(phasesNode) ? phasesNode.items[i] : phasesNode;
      const field = `phases[${i}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        err(node, field, "Each phase must be a mapping.");
        return;
      }
      const ph = raw as Record<string, unknown>;
      const id = ph.id === undefined ? String(i + 1) : String(ph.id);
      if (seen.has(id)) err(getNode(node, "id") ?? node, `${field}.id`, `Duplicate phase id "${id}".`);
      seen.add(id);
      const name = str(ph.name, getNode(node, "name") ?? node, `${field}.name`);
      const tasks = strList(ph.tasks, getNode(node, "tasks") ?? node, `${field}.tasks`);
      if (!tasks.length) err(getNode(node, "tasks") ?? node, `${field}.tasks`, `Phase "${name || id}" needs at least one task.`);
      const doneWhen = str(ph.done_when, getNode(node, "done_when") ?? node, `${field}.done_when`);
      const dependsOn = strList(ph.depends_on, getNode(node, "depends_on") ?? node, `${field}.depends_on`).map(String);
      const checksNode = getNode(node, "checks");
      const checks: Check[] = [];
      if (!Array.isArray(ph.checks) || ph.checks.length === 0) {
        err(checksNode ?? node, `${field}.checks`, `Phase "${name || id}" has no runnable check. Every phase needs at least one check (cmd, file_exists or http).`);
      } else {
        ph.checks.forEach((rawCheck, j) => {
          const checkNode = isSeq(checksNode) ? checksNode.items[j] : checksNode;
          const cf = `${field}.checks[${j}]`;
          if (typeof rawCheck === "string") {
            checks.push({ kind: "cmd", cmd: rawCheck });
            return;
          }
          const c = (rawCheck ?? {}) as Record<string, unknown>;
          if (typeof c.cmd === "string" && c.cmd.trim()) {
            if (c.expect_regex !== undefined) {
              try {
                new RegExp(String(c.expect_regex));
              } catch {
                err(checkNode, `${cf}.expect_regex`, "Invalid regular expression.");
              }
            }
            checks.push({ kind: "cmd", cmd: c.cmd.trim(), expectRegex: c.expect_regex === undefined ? undefined : String(c.expect_regex), timeoutS: c.timeout === undefined ? undefined : Number(c.timeout) });
          } else if (typeof c.file_exists === "string" && c.file_exists.trim()) {
            const file = c.file_exists.trim();
            if (file.startsWith("/") || file.startsWith("\\") || /^[a-zA-Z]:/.test(file) || file.split(/[\\/]/).includes("..")) err(checkNode, `${cf}.file_exists`, "file_exists must be a relative path inside the project.");
            checks.push({ kind: "file_exists", path: file });
          } else if (typeof c.http === "string" && c.http.trim()) {
            const target = c.http.trim();
            if (!target.startsWith("/") && !isLocalUrl(target)) err(checkNode, `${cf}.http`, "http checks must be a route (\"/menu\") or a localhost URL.");
            checks.push({ kind: "http", path: target, expectStatus: c.expect_status === undefined ? 200 : Number(c.expect_status) });
          } else {
            err(checkNode, cf, "Unknown check. Use `cmd: <command>`, `file_exists: <path>` or `http: <route>`. LLM-judged checks are not supported.");
          }
        });
      }
      phases.push({ id, name, dependsOn, tasks, checks, doneWhen });
    });
  }

  const ids = new Set(phases.map(phase => phase.id));
  phases.forEach((phase, i) => {
    const node = isSeq(phasesNode) ? phasesNode.items[i] : phasesNode;
    for (const dep of phase.dependsOn) {
      if (!ids.has(dep)) err(getNode(node, "depends_on") ?? node, `phases[${i}].depends_on`, `Phase "${phase.name}" depends on unknown phase "${dep}".`);
      if (dep === phase.id) err(getNode(node, "depends_on") ?? node, `phases[${i}].depends_on`, `Phase "${phase.name}" cannot depend on itself.`);
    }
    if (!preview && phase.checks.some(check => check.kind === "http")) err(node, `phases[${i}].checks`, "http checks need a `preview` block (command and url).");
    if (phase.checks.every(check => check.kind === "file_exists")) warnings.push({ line: lineOf(node), field: `phases[${i}].checks`, message: `Phase "${phase.name}" only checks that files exist; consider adding a build or test command.` });
  });

  const cycle = findCycle(phases);
  if (cycle) errors.push({ line: lineOf(phasesNode), field: "phases.depends_on", message: `Dependency cycle: ${cycle.join(" → ")}` });

  // Parse optional `ui` field.
  let ui: UiConfig | null = null;
  if (data.ui !== undefined && data.ui !== null) {
    const uiNode = getNode(root, "ui");
    const uiRaw = data.ui as Record<string, unknown>;
    if (typeof uiRaw !== "object" || Array.isArray(uiRaw)) {
      errors.push({ line: lineOf(uiNode), field: "ui", message: "`ui` must be a mapping with optional keys: prompt, animations, reference." });
    } else {
      const uiPrompt = typeof uiRaw.prompt === "string" ? uiRaw.prompt.trim().slice(0, 2000) : undefined;
      const uiAnimations = typeof uiRaw.animations === "string" ? uiRaw.animations.trim().toLowerCase() : "motion";
      const uiReference = typeof uiRaw.reference === "string" ? uiRaw.reference.trim().slice(0, 500) : undefined;
      if (!["motion", "gsap", "anime", "css"].includes(uiAnimations)) {
        warnings.push({ line: lineOf(uiNode), field: "ui.animations", message: `Unknown animation library "${uiAnimations}". Meadow will use "motion". Supported values: motion, gsap, anime, css.` });
      }
      ui = { prompt: uiPrompt, animations: uiAnimations, reference: uiReference };
    }
  }

  if (errors.length) return { ok: false, plan: null, errors, warnings };
  if (phases.length > MAX_PHASES) warnings.push({ line: lineOf(phasesNode), field: "phases", message: `${phases.length} phases is a lot; plans over ${MAX_PHASES} phases are hard to review. Consider splitting the project.` });
  return { ok: true, plan: { project, goal, stack, constraints, services, preview, phases, ui, body: markdown.slice(match[0].length).trim() }, errors: [], warnings };
}

export function findCycle(phases: Pick<PlanPhase, "id" | "dependsOn">[]): string[] | null {
  const deps = new Map(phases.map(phase => [phase.id, phase.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const phase of phases) {
    const found = visit(phase.id);
    if (found) return found;
  }
  return null;
}

/** Phases in an order that respects depends_on, stable with respect to the file order. */
export function executionOrder(phases: PlanPhase[]): PlanPhase[] {
  const done = new Set<string>();
  const ordered: PlanPhase[] = [];
  const remaining = [...phases];
  while (remaining.length) {
    const index = remaining.findIndex(phase => phase.dependsOn.every(dep => done.has(dep)));
    if (index < 0) throw new Error("Plan has a dependency cycle");
    const [next] = remaining.splice(index, 1);
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}

export function formatErrors(errors: PlanError[]): string {
  return errors.map(error => `${error.line ? `line ${error.line}` : "plan"} · ${error.field}: ${error.message}`).join("\n");
}
