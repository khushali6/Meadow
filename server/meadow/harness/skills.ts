import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import { containsSecret } from "../core/redact";
import type { Plan, PlanPhase } from "../planning/format";
import { isWebPlan } from "./design";

export type Skill = { name: string; description: string; scope: "ui" | "all"; file: string; bytes: number };

const MAX_SKILL_BYTES = 120_000;
const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const UI_SKILL = /\b(ui|ux|design|interface|front-?end|animation|animations|motion|css|visual|typography|layout)\b/i;
/** Where skills live inside a project; engines read them from here. */
export const PROJECT_SKILLS_DIR = ".meadow/skills";

export const skillsHome = () => homePath("skills");

/** name/description from SKILL.md front matter (closing fence may be a long run of dashes), else the folder name. */
export function parseSkill(text: string, fallbackName: string): { name: string; description: string } {
  const front = text.match(/^---\s*\n([\s\S]*?)\n-{3,}\s*(?:\n|$)/)?.[1] ?? "";
  const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
  const name = (field("name") || fallbackName).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48);
  const description = field("description") || text.replace(/^---[\s\S]*?\n-{3,}\s*\n/, "").split("\n").find(line => line.trim() && !line.startsWith("#"))?.trim() || "";
  return { name, description: description.slice(0, 400) };
}

/** Skills installed in ~/.meadow/skills/<name>/SKILL.md. Unreadable, oversized or secret-bearing files are skipped. */
export function listSkills(): Skill[] {
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(skillsHome(), { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !NAME.test(dir.name)) continue;
    const file = path.join(skillsHome(), dir.name, "SKILL.md");
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;
      const text = fs.readFileSync(file, "utf8");
      if (containsSecret(text)) continue;
      const { description } = parseSkill(text, dir.name);
      skills.push({ name: dir.name, description, scope: UI_SKILL.test(`${dir.name} ${description}`) ? "ui" : "all", file, bytes: stat.size });
    } catch {
      // Skip unreadable skills.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Copies a SKILL.md (or a folder containing one) into ~/.meadow/skills/<name>/. */
export function addSkill(source: string): Skill {
  const resolved = path.resolve(source.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, "SKILL.md") : resolved;
  if (!/\.md$/i.test(file)) throw new Error("A skill is a SKILL.md file (or a folder that contains one).");
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`No skill found at ${file}.`);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`That skill is ${Math.round(stat.size / 1000)} KB; the limit is ${MAX_SKILL_BYTES / 1000} KB.`);
  const text = fs.readFileSync(file, "utf8");
  if (containsSecret(text)) throw new Error("That file looks like it contains a secret, so Meadow won't copy it.");
  const { name } = parseSkill(text, path.basename(path.dirname(file)));
  if (!NAME.test(name)) throw new Error("The skill needs a short name (letters, numbers, dashes) in its front matter.");
  const dir = path.join(skillsHome(), name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text, { mode: 0o600 });
  return listSkills().find(skill => skill.name === name)!;
}

export function removeSkill(name: string) {
  if (!NAME.test(name)) throw new Error("Unknown skill.");
  fs.rmSync(path.join(skillsHome(), name), { recursive: true, force: true });
}

/** Skills that apply to this plan: UI skills only when it has a UI and the design standard is on. */
export function activeSkills(plan: Pick<Plan, "preview" | "stack"> & { goal?: string }): Skill[] {
  const config = loadConfig().harness;
  if (!config.skills?.enabled) return [];
  const disabled = new Set(config.skills.disabled ?? []);
  const web = config.design && isWebPlan(plan);
  return listSkills().filter(skill => !disabled.has(skill.name) && (skill.scope === "all" || web));
}

/** Writes the active skills into <dir>/.meadow/skills/ and removes ones that no longer apply. Returns what was written. */
export function installSkills(dir: string, plan: Pick<Plan, "preview" | "stack"> & { goal?: string }): Skill[] {
  const skills = activeSkills(plan);
  const target = path.join(dir, PROJECT_SKILLS_DIR);
  const keep = new Set(skills.map(skill => skill.name));
  for (const entry of fs.existsSync(target) ? fs.readdirSync(target) : []) if (!keep.has(entry)) fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  for (const skill of skills) {
    fs.mkdirSync(path.join(target, skill.name), { recursive: true });
    fs.writeFileSync(path.join(target, skill.name, "SKILL.md"), fs.readFileSync(skill.file, "utf8"));
  }
  return skills;
}

/** The prompt section telling the engine which skills to read for this phase. QA and backend phases skip UI skills. */
export function skillsSection(plan: Pick<Plan, "preview" | "stack"> & { goal?: string }, phase?: Pick<PlanPhase, "agent">): string {
  const skills = activeSkills(plan).filter(skill => skill.scope === "all" || !phase || !phase.agent || phase.agent === "ui");
  if (!skills.length) return "";
  const lines = skills.map(skill => `- ${PROJECT_SKILLS_DIR}/${skill.name}/SKILL.md — ${skill.description || skill.name}`);
  return `\n# Skills (read before you start; follow them where they are more specific than the design standard)\n${lines.join("\n")}`;
}
