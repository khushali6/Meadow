import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { saveConfig, resetConfigCache } = await import("../../server/meadow/config");
const { addSkill, installSkills, listSkills, parseSkill, removeSkill, skillsSection } = await import("../../server/meadow/harness/skills");
const { compileFixPrompt, compilePhasePrompt, rulesFileContent } = await import("../../server/meadow/harness/prompts");

const UI_SKILL = "---\n\nname: ui\ndescription: Build premium editorial interfaces with GSAP, Anime.js and Motion. Use whenever creating the product UI.\n------------------------------------------\n\n# UI\nUse amber sparingly.\n";
const TEST_SKILL = "---\nname: testing\ndescription: Write table-driven tests with clear names.\n---\n# Testing\n";

let env: { cleanup: () => void };
let sources: string;
let project: string;
const web = { project: "x", goal: "A habit tracker web app", stack: ["react", "vite"], constraints: [], services: [], preview: { command: "npm run dev", url: "http://127.0.0.1:5173", routes: ["/"] }, phases: [], env: { required: [], optional: [] }, body: "" } as never;
const cli = { ...(web as object), goal: "A command-line tool", stack: ["go"], preview: undefined } as never;
const phase = (agent?: string) => ({ id: "p", name: "Screens", tasks: ["Build it"], checks: [], dependsOn: [], doneWhen: "done", agent }) as never;

beforeEach(() => {
  env = tempHome();
  resetConfigCache();
  sources = fs.mkdtempSync(path.join(os.tmpdir(), "skills-src-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "skills-proj-"));
  fs.mkdirSync(path.join(sources, "ui"));
  fs.writeFileSync(path.join(sources, "ui", "SKILL.md"), UI_SKILL);
  fs.writeFileSync(path.join(sources, "testing.md"), TEST_SKILL);
});
afterEach(() => {
  fs.rmSync(sources, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  env.cleanup();
});

describe("skills", () => {
  it("reads front matter, including a long dashed closing fence", () => {
    expect(parseSkill(UI_SKILL, "x")).toEqual({ name: "ui", description: expect.stringContaining("GSAP, Anime.js and Motion") });
  });

  it("adds skills from a folder or a file and classifies UI skills", () => {
    addSkill(path.join(sources, "ui"));
    addSkill(path.join(sources, "testing.md"));
    expect(listSkills().map(skill => [skill.name, skill.scope])).toEqual([["testing", "all"], ["ui", "ui"]]);
    removeSkill("testing");
    expect(listSkills().map(skill => skill.name)).toEqual(["ui"]);
  });

  it("refuses files that look like they hold a secret", () => {
    fs.writeFileSync(path.join(sources, "leak.md"), `---\nname: leak\n---\nkey: sk-ant-api03-${"a".repeat(80)}\n`);
    expect(() => addSkill(path.join(sources, "leak.md"))).toThrow(/secret/);
  });

  it("installs UI skills only for projects with a UI, and names them in UI phases but not backend ones", () => {
    addSkill(path.join(sources, "ui"));
    addSkill(path.join(sources, "testing.md"));
    expect(installSkills(project, web).map(skill => skill.name)).toEqual(["testing", "ui"]);
    expect(fs.readFileSync(path.join(project, ".meadow/skills/ui/SKILL.md"), "utf8")).toBe(UI_SKILL);
    expect(skillsSection(web, phase("ui"))).toContain(".meadow/skills/ui/SKILL.md");
    expect(skillsSection(web, phase("backend"))).not.toContain("skills/ui/");
    expect(skillsSection(web, phase("backend"))).toContain("skills/testing/");
    expect(installSkills(project, cli).map(skill => skill.name)).toEqual(["testing"]);
    expect(fs.existsSync(path.join(project, ".meadow/skills/ui"))).toBe(false);
  });

  it("puts active skills in the phase, fix and rules prompts and respects disabled ones", () => {
    addSkill(path.join(sources, "ui"));
    const input = { plan: web, phase: phase("ui"), projectPath: project, projectRules: "", previousSummaries: [], context: "" };
    expect(compilePhasePrompt(input as never)).toContain(".meadow/skills/ui/SKILL.md");
    expect(compileFixPrompt({ plan: web, phase: phase("ui"), projectPath: project, failing: { check: { kind: "cmd", cmd: "npm test" }, exitCode: 1, output: "fail" } } as never)).toContain(".meadow/skills/ui/SKILL.md");
    expect(rulesFileContent(web, "", project)).toContain(".meadow/skills/ui/SKILL.md");
    saveConfig({ harness: { skills: { disabled: ["ui"] } } });
    expect(compilePhasePrompt(input as never)).not.toContain("skills/ui/");
  });
});
