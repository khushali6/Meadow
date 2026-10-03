import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { designIssues } = await import("../../server/meadow/visual/design");
const { DESIGN_STANDARD, designBrief, designSection, isWebPlan } = await import("../../server/meadow/harness/design");
const { compilePhasePrompt, compileFixPrompt, rulesFileContent } = await import("../../server/meadow/harness/prompts");
const { acceptancePhase } = await import("../../server/meadow/harness/acceptance");
const { saveConfig, homePath } = await import("../../server/meadow/config");

let env: ReturnType<typeof tempHome> & { home: string };
beforeEach(() => { env = Object.assign(tempHome(), { home: process.env.MEADOW_HOME! }); });
afterEach(() => env.cleanup());

const designed = { bodyFont: "Inter, system-ui, sans-serif", bodyMargin: "0px", cssRules: 120, hoverRules: 6, focusRules: 3, interactive: 4, nativeControls: [], bodySize: 16, largestText: 48, colors: 8, contentWidth: 1280, viewportWidth: 1280, deviceWidth: 1280, viewportMeta: true };
const phase = { id: "ui", name: "Screens", dependsOn: [], tasks: ["Build the list"], checks: [{ kind: "cmd" as const, cmd: "npm test" }], doneWhen: "List works" };
const plan = (web: boolean) => ({ project: "p", goal: web ? "Track habits" : "A CLI that converts CSV to JSON", stack: web ? ["react", "vite"] : ["python"], constraints: [], services: [], preview: null, phases: [phase] }) as never;

describe("the design audit", () => {
  it("passes a designed page", () => {
    expect(designIssues(designed)).toEqual([]);
  });

  it("names every browser default that is left", () => {
    const issues = designIssues({ bodyFont: "Times", bodyMargin: "8px", cssRules: 3, hoverRules: 0, focusRules: 0, interactive: 2, nativeControls: ["Add", "Add", "New habit"], bodySize: 16, largestText: 18, colors: 2, contentWidth: 1280, viewportWidth: 1280, deviceWidth: 1280, viewportMeta: false }).join("\n");
    expect(issues).toMatch(/browser's default font \(Times\)/);
    expect(issues).toMatch(/almost no styling \(3 CSS rules\)/);
    expect(issues).toMatch(/default 8px margin/);
    expect(issues).toMatch(/unstyled browser defaults: "Add", "New habit"\./);
    expect(issues).toMatch(/no visual hierarchy: the largest text is 18px/);
    expect(issues).toMatch(/only 2 colours/);
    expect(issues).toMatch(/Nothing reacts on hover/);
    expect(issues).toMatch(/no focus styles/);
  });

  it("only checks sideways scrolling on a phone", () => {
    const phone = { ...designed, contentWidth: 390, viewportWidth: 390, deviceWidth: 390 };
    expect(designIssues({ ...phone, bodyFont: "serif" }, "mobile")).toEqual([]);
    expect(designIssues({ ...phone, contentWidth: 510, viewportWidth: 510 }, "mobile")[0]).toMatch(/scrolls sideways by 120px on a 390px wide screen/);
    expect(designIssues({ ...phone, contentWidth: 980, viewportWidth: 980, viewportMeta: false }, "mobile")[0]).toMatch(/renders 980px wide and zoomed out.*name="viewport"/);
    expect(designIssues({ ...designed, contentWidth: 1400 })[0]).toMatch(/scrolls sideways by 120px on a 1280px wide screen/);
  });
});

describe("the design standard in prompts", () => {
  it("applies to web plans only", () => {
    expect(isWebPlan({ preview: null, stack: ["Next"] })).toBe(true);
    expect(isWebPlan({ preview: { command: "x", url: "http://localhost:3000" } as never, stack: [] })).toBe(true);
    expect(isWebPlan({ preview: null, stack: ["python", "click"] })).toBe(false);
    expect(isWebPlan({ preview: null, stack: ["expo"] })).toBe(true);
    expect(isWebPlan({ preview: null, stack: ["typescript"], goal: "A dashboard for team expenses" })).toBe(true);
    expect(isWebPlan({ preview: null, stack: ["typescript"], goal: "A CLI app that renames photos" })).toBe(false);
    expect(isWebPlan({ preview: null, stack: ["go"], goal: "A library for parsing dates" })).toBe(false);
  });

  it("goes into phase, fix and rules prompts for web projects", () => {
    const input = { plan: plan(true), phase, projectPath: env.home, projectRules: "", previousSummaries: [], context: "" };
    expect(compilePhasePrompt(input)).toContain("# Design standard (required for every screen you touch)");
    expect(compilePhasePrompt(input)).toContain("Design tokens first");
    expect(compileFixPrompt({ plan: plan(true), phase, projectPath: env.home, failing: { check: phase.checks[0], exitCode: 1, output: "boom" } })).toContain("Design tokens first");
    expect(rulesFileContent(plan(true), "", env.home)).toContain("Design standard for every screen");
    expect(acceptancePhase(plan(true)).tasks.join("\n")).toMatch(/checks the design in the browser/);
  });

  it("stays out of non-web projects and when turned off", () => {
    expect(compilePhasePrompt({ plan: plan(false), phase, projectPath: env.home, projectRules: "", previousSummaries: [], context: "" })).not.toContain("Design standard");
    expect(rulesFileContent(plan(false), "", env.home)).not.toContain("Design standard");
    saveConfig({ harness: { design: false } });
    expect(designSection(plan(true), env.home)).toBe("");
    expect(acceptancePhase(plan(true)).tasks.join("\n")).not.toMatch(/checks the design/);
  });

  it("uses the project's own brief, then the user's, then the built-in one", () => {
    const project = path.join(env.home, "proj");
    fs.mkdirSync(path.join(project, ".meadow"), { recursive: true });
    expect(designBrief(project)).toBe(DESIGN_STANDARD);
    fs.writeFileSync(homePath("design.md"), "Dark, brutalist, monospace everywhere.");
    expect(designBrief(project)).toBe("Dark, brutalist, monospace everywhere.");
    fs.writeFileSync(path.join(project, ".meadow", "design.md"), "Playful pastel brand.");
    expect(designBrief(project)).toBe("Playful pastel brand.");
  });
});
