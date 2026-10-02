import { describe, expect, it } from "vitest";
import { executionOrder, parsePlan } from "../../server/meadow/planning/format";
import { THREE_PHASE_PLAN } from "../helpers";

const SPEC_EXAMPLE = `---
project: bakery-site
goal: Online ordering site for a neighborhood bakery
stack: [nextjs, typescript, sqlite]
constraints:
  - Do not add paid services
  - Keep dependencies minimal
preview:
  command: npm run dev
  url: http://localhost:3000
  ready_timeout: 60
  routes: ["/", "/menu", "/cart"]
phases:
  - id: 1
    name: Scaffold and base layout
    tasks:
      - Initialise the project with the chosen stack
      - Create the shared layout and navigation
    checks:
      - cmd: npm run build
      - cmd: npm run lint
    done_when: The site builds and shows a home page
  - id: 2
    name: Menu and cart
    depends_on: [1]
    tasks:
      - Menu page with items from a JSON file
      - Cart with add/remove and totals
    checks:
      - cmd: npm test -- cart
      - file_exists: src/app/menu/page.tsx
      - http: /menu
    done_when: A user can add items to a cart and see the total
---
`;

describe("PLAN.md parser", () => {
  it("parses the reference plan from the spec", () => {
    const result = parsePlan(SPEC_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.phases).toHaveLength(2);
    expect(result.plan.preview?.routes).toEqual(["/", "/menu", "/cart"]);
    expect(result.plan.phases[1].checks.map(check => check.kind)).toEqual(["cmd", "file_exists", "http"]);
  });

  it("parses the test plan and orders phases by dependency", () => {
    const result = parsePlan(THREE_PHASE_PLAN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(executionOrder(result.plan.phases).map(phase => phase.id)).toEqual(["1", "2", "3"]);
    expect(result.plan.body).toBe("Human notes.");
  });

  it("rejects a phase without checks and names the line", () => {
    const plan = SPEC_EXAMPLE.replace("    checks:\n      - cmd: npm run build\n      - cmd: npm run lint\n", "");
    const result = parsePlan(plan);
    expect(result.ok).toBe(false);
    const error = result.errors.find(item => item.field === "phases[0].checks");
    expect(error?.message).toMatch(/no runnable check/);
    expect(error?.line).toBeGreaterThan(10);
  });

  it("rejects LLM-judged and unknown checks", () => {
    const result = parsePlan(SPEC_EXAMPLE.replace("- cmd: npm run lint", "- llm_judge: looks nice"));
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Unknown check/);
  });

  it("detects dependency cycles", () => {
    const result = parsePlan(SPEC_EXAMPLE.replace("  - id: 1\n    name: Scaffold", "  - id: 1\n    depends_on: [2]\n    name: Scaffold"));
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => /cycle/i.test(error.message))).toBe(true);
  });

  it("rejects unknown dependencies, duplicate ids and non-local preview URLs", () => {
    expect(parsePlan(SPEC_EXAMPLE.replace("depends_on: [1]", "depends_on: [9]")).errors[0].message).toMatch(/unknown phase "9"/);
    expect(parsePlan(SPEC_EXAMPLE.replace("  - id: 2", "  - id: 1")).errors.some(error => /Duplicate/.test(error.message))).toBe(true);
    expect(parsePlan(SPEC_EXAMPLE.replace("http://localhost:3000", "https://example.com")).errors[0].field).toBe("preview.url");
  });

  it("requires a preview for http checks", () => {
    const plan = SPEC_EXAMPLE.replace(/preview:\n(  .*\n)+/, "");
    const result = parsePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => /preview/.test(error.message))).toBe(true);
  });

  it("reports YAML syntax errors and missing front-matter", () => {
    expect(parsePlan("# just a title").errors[0].field).toBe("front-matter");
    const broken = parsePlan("---\nproject: x\n  goal: : :\nphases: [\n---\n");
    expect(broken.ok).toBe(false);
    expect(broken.errors[0].field).toBe("yaml");
  });

  it("rejects file_exists paths that escape the project", () => {
    const result = parsePlan(SPEC_EXAMPLE.replace("file_exists: src/app/menu/page.tsx", "file_exists: ../../etc/passwd"));
    expect(result.ok).toBe(false);
  });
});
