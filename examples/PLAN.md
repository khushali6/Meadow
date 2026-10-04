---
project: habit-tracker
goal: A small web app to track daily habits with streaks
stack: [react, vite, vitest]

# ui: Meadow generates a unique design system from this prompt before phase 1 runs.
# Every phase prompt will include the resulting palette, typography, and motion spec.
ui:
  prompt: >
    Dark, focused productivity tool. Think Bear meets Streaks — a near-black canvas
    (#0D0D0D), warm cream text (#F5F0E8), muted sage dividers, a single amber-gold
    accent for active streaks and primary actions. Monospace font for numbers and
    dates. Micro-animations only: a gentle fade-up on card mount, a satisfying
    scale-pop when a habit is checked, and a soft glow pulse on the active streak
    count. No gradients, no blur, no shadows larger than 1px.
  animations: motion   # motion | gsap | anime | css
  reference: https://linear.app  # visual mood reference — not fetched, just a hint

preview:
  command: npm run dev -- --port 5173 --strictPort
  url: http://127.0.0.1:5173
  routes: ["/"]

phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - Create a Vite + React + TypeScript app in the project root
      - Add Vitest with one passing smoke test
      - Add npm scripts build and test
      - Read .meadow/design.md (generated from the ui.prompt above) and implement
        the full design system in src/styles/tokens.css — every CSS variable for
        palette, fonts, type scale, spacing, radii and motion durations exactly
        as specified, no stray hex values anywhere else in the codebase
      - Create src/components/ui/motion.tsx with ready-to-use motion primitives
        (FadeIn, SlideUp, StaggerList, ScalePop) using the motion package
      - App shell — header with product name, today's date in monospace, a max-width
        main column, styled buttons (primary dark-fill, secondary outline) and inputs
        with focus rings; all values from tokens.css
    checks:
      - file_exists: package.json
      - file_exists: src/styles/tokens.css
      - file_exists: src/components/ui/motion.tsx
      - cmd: npm install --no-audit --no-fund
        timeout: 300
      - cmd: npm run build
      - cmd: npm test -- --run
    done_when: The app builds, tests pass, and the design tokens are in place

  - id: habits
    name: Habit list with streaks
    agent: ui                # backend | ui | qa — the specialist the engine plays
    depends_on: [scaffold]
    tasks:
      - Add a form to create habits (inline validation for blank or duplicate names)
      - Show habits in a list; each row uses the design tokens for spacing and borders
      - Mark a habit done for today — use the ScalePop motion primitive on check
      - Compute current streak; display in monospace with the amber-gold accent when
        streak > 0; show a glow-pulse animation via the motion spec from design.md
      - Persist habits in localStorage
      - Unit-test the streak calculation (gaps, today/yesterday edges)
      - Add browser test cases for "/" to meadow.e2e.json (add a habit, check it off,
        reject a blank name)
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - e2e: /                # runs the meadow.e2e.json cases for "/" in a real browser
    done_when: Habits can be added, checked off, and survive a reload; streak tests pass

  - id: export
    name: Export and import
    agent: backend
    parallel_group: features  # runs at the same time as "weekly", in its own git worktree
    depends_on: [habits]
    tasks:
      - Export all habits and check-ins to a JSON file; import validates the shape
        and reports a clear error for a bad file
      - Unit-test export/import round-trips and invalid files
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
    done_when: Data survives an export and re-import; bad files are rejected clearly

  - id: weekly
    name: Weekly view
    agent: ui
    parallel_group: features
    depends_on: [habits]
    tasks:
      - Show the last seven days per habit as a row of cells with weekday labels
      - Today's cell uses the accent colour; completed cells use a filled variant
      - Use StaggerList to animate the cells in on mount (50ms stagger, FadeIn)
      - Recompose for 390px phone — full-width rows, nothing scrolls sideways
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /
    done_when: The weekly grid renders correctly on desktop and mobile with animations
---

# Notes for the engine

- The design system is in `.meadow/design.md` — generated automatically by Meadow
  from the `ui.prompt` above before phase 1. Always read it before writing any CSS.
- Animation library: `motion` (the "motion" package, not "framer-motion").
  Import: `import { motion, AnimatePresence } from "motion/react"`.
- Keep dependencies small: React, motion. No component libraries.
- Prefer small pure functions for date math so they are easy to unit-test.
