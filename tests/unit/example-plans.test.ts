import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlan } from "../../server/meadow/planning/format";

const root = path.resolve(__dirname, "../../examples");
const plans = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => path.basename(file) === "PLAN.md");

describe("example plans", () => {
  it.each(plans)("%s parses without errors", file => {
    const parsed = parsePlan(fs.readFileSync(path.join(root, file), "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
  });

  it("standup-scribe uses every agent role, a parallel group, browser checks and optional env", () => {
    const parsed = parsePlan(fs.readFileSync(path.join(root, "standup-scribe/PLAN.md"), "utf8"));
    if (!parsed.ok) throw new Error("plan did not parse");
    const { phases, env } = parsed.plan;
    expect(new Set(phases.map(phase => phase.agent).filter(Boolean))).toEqual(new Set(["backend", "ui", "qa"]));
    expect(phases.filter(phase => phase.parallelGroup === "features").map(phase => phase.id)).toEqual(["board", "meetings"]);
    expect(phases.some(phase => phase.checks.some(check => check.kind === "e2e"))).toBe(true);
    expect(env.required).toEqual([]);
    expect(env.optional.map(item => item.name)).toEqual(["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]);
  });
});
