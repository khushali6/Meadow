/**
 * docs.ts — Generates .meadow/docs/{PRD,DESIGN_SYSTEM,ARCHITECTURE,AGENTS}.md from a project's PLAN.md.
 *
 * Called once, after all phases pass. Uses the project's configured LLM (the same planner model).
 * The files are committed to the base branch and will be pushed to GitHub on the next pushBase call.
 */
import fs from "node:fs";
import path from "node:path";
import { getLlm } from "../llm/client";
import type { Plan } from "../planning/format";

const DOCS_DIR = ".meadow/docs";

type DocSpec = { filename: string; title: string; systemPrompt: string; userPrompt: (plan: Plan, planMd: string) => string };

const DOCS: DocSpec[] = [
  {
    filename: "PRD.md",
    title: "Product Requirements Document",
    systemPrompt:
      "You are a senior product manager. Write precise, engineering-ready product specifications. Use Markdown headings, bullet lists, and tables. Do not pad the document—every sentence must add information.",
    userPrompt: (plan, planMd) => `
Given the PLAN.md below, write a complete Product Requirements Document (PRD) for **${plan.project}**.

Include:
1. **Executive Summary** — one-paragraph elevator pitch
2. **Problem & Opportunity** — what user pain does this solve?
3. **Goals & Non-Goals** — numbered, explicit
4. **User Journeys** — 2-4 end-to-end flows as numbered steps (actor → action → outcome)
5. **Feature Specifications** — one section per phase, with acceptance criteria derived from the phase's checks
6. **Constraints & Dependencies** — tech stack, services, time
7. **Success Metrics** — 3-5 measurable KPIs

PLAN.md:
\`\`\`markdown
${planMd}
\`\`\`
`.trim(),
  },
  {
    filename: "DESIGN_SYSTEM.md",
    title: "Design System",
    systemPrompt:
      "You are a senior UI/UX designer and front-end engineer. Write a concrete, code-ready design system document. Include actual CSS values, not vague descriptions.",
    userPrompt: (plan, planMd) => `
Given the PLAN.md below, write a Design System document for **${plan.project}**.

Stack: ${plan.stack.join(", ")}

Include:
1. **Design Philosophy** — 3-5 guiding principles (e.g. editorial, high-contrast, minimal)
2. **Colour Tokens** — a table of CSS variable names → hex values for brand, surface, text, border, success/warn/error
3. **Typography** — font families (Google Fonts or @fontsource), size scale (sm/base/lg/xl/2xl/3xl), line-heights, weights
4. **Spacing Scale** — 8-pt or 4-pt grid in rem
5. **Border Radius & Shadow** — all values as CSS vars
6. **Motion** — duration, easing presets; when to animate (micro-interactions vs navigation)
7. **Component Patterns** — naming, base class patterns for Button, Input, Card, Badge, Table
8. **Accessibility Rules** — WCAG 2.1 AA targets: contrast ratios, focus ring, ARIA labels

PLAN.md:
\`\`\`markdown
${planMd}
\`\`\`
`.trim(),
  },
  {
    filename: "ARCHITECTURE.md",
    title: "Architecture",
    systemPrompt:
      "You are a principal software architect. Write a clear, decision-record-style architecture document. Be specific about data flow, component boundaries, and trade-offs.",
    userPrompt: (plan, planMd) => `
Given the PLAN.md below, write an Architecture document for **${plan.project}**.

Stack: ${plan.stack.join(", ")}
Services: ${plan.services.length ? plan.services.join(", ") : "none"}

Include:
1. **System Overview** — one-paragraph description of the deployed system
2. **Tech Stack Decisions** — table: component → choice → reason (what alternatives were rejected)
3. **Component Diagram** — ASCII block diagram of the key components and their relationships
4. **Data Flow** — numbered step-by-step walkthrough of the primary happy-path request
5. **Data Model** — key entities, their fields, and relationships (table or ERD notation)
6. **API Surface** — public routes / endpoints and their contracts (method, path, request, response shape)
7. **State Management** — where state lives: server DB, client store, local storage, URL params
8. **Error Handling Strategy** — how failures propagate and what the user sees
9. **Security Boundaries** — auth, CORS, secret handling, input validation
10. **Scalability & Deployment** — known bottlenecks and how to address them

PLAN.md:
\`\`\`markdown
${planMd}
\`\`\`
`.trim(),
  },
  {
    filename: "AGENTS.md",
    title: "AI Agents Guide",
    systemPrompt:
      "You are a senior AI engineer who writes crystal-clear instructions for coding agents. Be explicit, use numbered rules, and avoid ambiguity.",
    userPrompt: (plan, planMd) => `
Given the PLAN.md below, write an AI Agents Guide (AGENTS.md) for **${plan.project}**.

This document is read by the coding agent (Cursor, Claude Code, etc.) at the start of every phase.

Include:
1. **Project Identity** — name, goal, tech stack in one block
2. **Ground Rules** — numbered mandatory constraints the agent must never violate (security, secrets, file scope, etc.)
3. **Code Style** — language-specific conventions, naming, file organisation
4. **Architecture Patterns** — which patterns to follow (e.g. server components, repository pattern, functional-core/imperative-shell)
5. **Testing Requirements** — what to test, what coverage targets, which framework
6. **Forbidden Actions** — explicit list of things the agent must never do (global installs, env-var exposure, DB drops, etc.)
7. **Phase-Specific Guidance** — one bullet per phase: what the agent should focus on
8. **How to Report** — the expected format of the agent's completion message

PLAN.md:
\`\`\`markdown
${planMd}
\`\`\`
`.trim(),
  },
];

export type DocsResult = {
  generated: string[];
  skipped: string[];
  dir: string;
};

/**
 * Generate .meadow/docs/ for a project. Safe to call more than once — existing files are overwritten.
 * Returns the list of files generated and any that were skipped due to errors.
 */
export async function generateProjectDocs(projectPath: string, plan: Plan, planMd: string): Promise<DocsResult> {
  const docsDir = path.join(projectPath, DOCS_DIR);
  fs.mkdirSync(docsDir, { recursive: true });

  const llm = getLlm();
  const generated: string[] = [];
  const skipped: string[] = [];

  for (const spec of DOCS) {
    const filePath = path.join(docsDir, spec.filename);
    try {
      const result = await llm.chat(
        [
          { role: "system", content: spec.systemPrompt },
          { role: "user", content: spec.userPrompt(plan, planMd) },
        ],
      );
      const header = `# ${spec.title} — ${plan.project}\n\n> Auto-generated by Meadow from PLAN.md. Edit freely.\n\n`;
      fs.writeFileSync(filePath, header + result.text.trim() + "\n", "utf8");
      generated.push(spec.filename);
    } catch {
      skipped.push(spec.filename);
    }
  }

  // Write an index README so the directory is self-describing.
  const index = [
    `# .meadow/docs`,
    "",
    "Auto-generated project documentation. Regenerated after every completed run.",
    "",
    "| File | Purpose |",
    "| ---- | ------- |",
    "| [PRD.md](PRD.md) | Product Requirements Document — scope, journeys, acceptance criteria |",
    "| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | UI tokens, typography, motion, component patterns |",
    "| [ARCHITECTURE.md](ARCHITECTURE.md) | Tech stack decisions, data flow, API surface |",
    "| [AGENTS.md](AGENTS.md) | Ground rules and instructions for the coding agent |",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(docsDir, "README.md"), index, "utf8");
  generated.push("README.md");

  return { generated, skipped, dir: DOCS_DIR };
}
