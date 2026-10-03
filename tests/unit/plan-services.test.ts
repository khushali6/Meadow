import { describe, expect, it } from "vitest";
import { MAX_PHASES, parsePlan, SERVICES_PHASE_ID, withServicesPhase } from "../../server/meadow/planning/format";

const plan = (frontMatter: string, phases = 1) => `---
project: app
goal: Test
${frontMatter}
phases:
${Array.from({ length: phases }, (_, i) => `  - id: ${i + 1}
    name: Phase ${i + 1}
    tasks: [Do it]
    checks: [npm test]
    done_when: Done`).join("\n")}
---

# Notes
Keep me.
`;

describe("services in PLAN.md", () => {
  it("parses an optional services list, normalised and de-duplicated", () => {
    const parsed = parsePlan(plan("services: [Supabase, docker, supabase]"));
    expect(parsed.ok && parsed.plan.services).toEqual(["supabase", "docker"]);
    const none = parsePlan(plan(""));
    expect(none.ok && none.plan.services).toEqual([]);
  });

  it("warns about services Meadow has no rules for, and rejects invalid names", () => {
    const unknown = parsePlan(plan("services: [stripe]"));
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings.map(warning => warning.message).join()).toMatch(/stripe/);
    expect(parsePlan(plan('services: ["rm -rf /"]')).ok).toBe(false);
    expect(parsePlan(plan("services: supabase")).ok).toBe(false);
  });

  it("warns past the phase limit", () => {
    expect(parsePlan(plan("", MAX_PHASES)).warnings).toEqual([]);
    expect(parsePlan(plan("", MAX_PHASES + 1)).warnings.map(warning => warning.message).join()).toMatch(/hard to review/);
  });
});

describe("built-in Connect services phase", () => {
  it("is added first, with local verification checks, keeping the notes", () => {
    const raw = withServicesPhase(plan("services: [supabase, docker]", 2));
    const parsed = parsePlan(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.phases.map(phase => phase.id)).toEqual([SERVICES_PHASE_ID, "1", "2"]);
    const services = parsed.plan.phases[0];
    expect(services.tasks.join(" ")).toMatch(/request_cloud_resource/);
    expect(services.checks.map(check => (check.kind === "cmd" ? check.cmd : ""))).toEqual(expect.arrayContaining(["git check-ignore -q .env.local", "grep -q SUPABASE_URL .env.example", "docker info --format '{{.ServerVersion}}'"]));
    expect(raw).toContain("Keep me.");
  });

  it("is idempotent and leaves plans without hosted services alone", () => {
    const once = withServicesPhase(plan("services: [supabase]"));
    expect(withServicesPhase(once)).toBe(once);
    const local = plan("services: [github]");
    expect(withServicesPhase(local)).toBe(local);
    expect(withServicesPhase("not a plan")).toBe("not a plan");
  });

  it("checks the Supabase settings without printing them", () => {
    const parsed = parsePlan(withServicesPhase(plan("services: [supabase]")));
    const node = parsed.ok ? parsed.plan.phases[0].checks.find(check => check.kind === "cmd" && check.cmd.startsWith("node")) : undefined;
    expect(node && node.kind === "cmd" && node.cmd).toMatch(/process\.exit/);
    expect(node && node.kind === "cmd" && node.cmd).not.toMatch(/console\.log|cat /);
  });
});
