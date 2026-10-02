import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { handleAction, handleText } from "../../server/meadow/intake/conversation";
import { setLlm, type ChatMessage, type LlmClient } from "../../server/meadow/llm/client";
import { parsePlan } from "../../server/meadow/planning/format";
import { findProject, getPlan, latestPlan } from "../../server/meadow/projects";
import { settled, tempHome } from "../helpers";

const planFor = (project: string, extraPhase = "") => `---
project: ${project}
goal: Recipe site
stack: [node]
phases:
  - id: 1
    name: Scaffold
    tasks: [Create index]
    checks:
      - file_exists: src/index.js
    done_when: index exists
${extraPhase}---
`;

const BUG_PHASE = `  - id: 2
    name: Fix search crash
    depends_on: [1]
    tasks:
      - Reproduce the bug with a failing automated test
      - Fix the crash
    checks:
      - cmd: test -f src/index.js
    done_when: The regression test passes
`;

/** A scripted stand-in for the FreeLLMAPI gateway, keyed off the system prompt. */
class ScriptedLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  classifyAs = "new_project";
  confidence = 0.9;
  badPlansFirst = 0;

  async chat(messages: ChatMessage[]) {
    this.calls.push(messages);
    const system = messages[0].content;
    const reply = (text: string) => ({ text, model: "test", tokensIn: 1, tokensOut: 1 });
    if (system.includes("You classify requests")) return reply(JSON.stringify({ intent: this.classifyAs, confidence: this.confidence, needs_clarification: true, project_hint: this.classifyAs === "new_project" ? "recipe-site" : "recipe-site" }));
    if (system.includes("clarifying questions")) return reply(JSON.stringify({ questions: [{ id: "stack", text: "Use plain Node?", options: ["Yes", "Something else"], default: "Yes" }, { id: "auth", text: "Do users need accounts?", options: ["No", "Yes"], default: "No" }] }));
    if (system.includes("You write SPEC.md")) return reply("# recipe-site\n## Goal\nRecipes\n## Assumptions (made without asking)\n- No accounts");
    if (system.includes("Extend an existing PLAN.md")) return reply(planFor("recipe-site", BUG_PHASE));
    if (system.includes("Meadow's planner")) {
      if (this.badPlansFirst > 0) {
        this.badPlansFirst -= 1;
        return reply("---\nproject: recipe-site\ngoal: x\nphases:\n  - id: 1\n    name: No checks\n    tasks: [a]\n    done_when: b\n---\n");
      }
      return reply(planFor("recipe-site"));
    }
    if (system.includes("kebab-case project name")) return reply("recipe-site");
    if (system.includes("factual engineering summaries")) return reply("Scaffolded the index.");
    return reply("ok");
  }
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0]);
  }
  async transcribe() {
    return "make me a recipe site";
  }
  async models() {
    return ["auto"];
  }
}

let env: ReturnType<typeof tempHome>;
let llm: ScriptedLlm;

beforeEach(() => {
  env = tempHome();
  llm = new ScriptedLlm();
  setLlm(llm);
  setEngine(new FakeEngine());
  process.env.MEADOW_ENGINE = "fake";
});

afterEach(async () => {
  await harness.shutdown();
  delete process.env.MEADOW_ENGINE;
  env.cleanup();
});

describe("request to plan", () => {
  it("asks clarifying questions, writes a spec and a valid plan, then runs after approval", async () => {
    const first = await handleText("test", "1", "make me a recipe site");
    expect(first.text).toMatch(/Question 1 of 2: Use plain Node\?/);
    expect(first.buttons?.flat().some(button => button.action === "decide")).toBe(true);

    const second = await handleAction("test", "1", "answer:0", "tester");
    expect(second.text).toMatch(/Question 2 of 2/);

    const review = await handleText("test", "1", "No accounts needed");
    expect(review.text).toMatch(/Nothing runs until you approve/);
    expect(review.planId).toBeDefined();
    const plan = getPlan(review.planId!);
    expect(parsePlan(plan.raw_md).ok).toBe(true);
    expect(plan.spec_md).toContain("Assumptions");

    const project = findProject("recipe-site")!;
    expect(project).toBeDefined();
    const done = settled(project.id);
    const approved = await handleAction("test", "1", `approve:${review.planId}`, "tester");
    expect(approved.text).toMatch(/approved/);
    expect((await done).payload?.status).toBe("completed");
    expect(fs.readFileSync(path.join(project.path, "SPEC.md"), "utf8")).toContain("recipe-site");
  });

  it("'just decide' records defaults as assumptions", async () => {
    await handleText("test", "2", "a recipe site please");
    const review = await handleAction("test", "2", "decide", "tester");
    expect(review.planId).toBeDefined();
    const specCall = llm.calls.find(call => call[0].content.includes("You write SPEC.md"))!;
    expect(specCall[1].content).toContain("(assumed)");
  });

  it("feeds validation errors back to the planner and retries", async () => {
    llm.badPlansFirst = 2;
    await handleText("test", "3", "recipe site");
    const review = await handleAction("test", "3", "decide", "tester");
    expect(review.planId).toBeDefined();
    const retries = llm.calls.filter(call => call.some(message => message.content.startsWith("The plan is invalid")));
    expect(retries.length).toBe(2);
    expect(retries[0].at(-1)!.content).toMatch(/no runnable check/);
  });

  it("asks instead of guessing when classification confidence is low", async () => {
    llm.confidence = 0.2;
    const reply = await handleText("test", "4", "hmm the thing");
    expect(reply.text).toMatch(/not sure/);
    expect(reply.buttons?.flat().map(button => button.action)).toContain("intent:new_project");
  });

  it("appends a reproduce-first bug phase without touching finished phases", async () => {
    await handleText("test", "5", "recipe site");
    const review = await handleAction("test", "5", "decide", "tester");
    const project = findProject("recipe-site")!;
    const done = settled(project.id);
    await handleAction("test", "5", `approve:${review.planId}`, "tester");
    await done;

    llm.classifyAs = "fix_bug";
    await handleText("test", "5", "search crashes on empty input");
    const bugReview = await handleAction("test", "5", "decide", "tester");
    expect(bugReview.text).toMatch(/failing test first/);
    const plan = parsePlan(latestPlan(project.id)!.raw_md);
    expect(plan.ok && plan.plan.phases[1].tasks[0]).toMatch(/Reproduce the bug with a failing automated test/);
    expect(plan.ok && plan.plan.phases[0].name).toBe("Scaffold");
  });

  it("imports a pasted PLAN.md after validation and rejects invalid ones with line numbers", async () => {
    const bad = await handleText("test", "6", "---\nproject: imported\ngoal: x\nphases:\n  - id: 1\n    name: A\n    tasks: [t]\n    done_when: d\n---\n");
    expect(bad.text).toMatch(/line \d+ · phases\[0\]\.checks/);
    const good = await handleText("test", "6", planFor("imported"));
    expect(good.text).toMatch(/Imported your plan/);
    expect(findProject("imported")).toBeDefined();
  });

  it("answers status and help commands", async () => {
    expect((await handleText("test", "7", "/help")).text).toMatch(/\/rollback/);
    expect((await handleText("test", "7", "/status")).text).toMatch(/No project selected|no approved plan/);
  });
});
