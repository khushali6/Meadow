---
project: standup-scribe
goal: Paste meeting notes, get a board of action items with owners and due dates, keep a history of meetings and export them as Markdown
stack: [react, vite, typescript, express, vitest]

ui:
  prompt: >
    Calm editorial notebook. Off-white paper canvas (#F7F5F0), graphite ink text
    (#1C1B19), hairline warm-grey rules, one ink-blue accent (#2747D6) for owners,
    focus rings and the primary action. Serif display face for meeting titles,
    a clean grotesk for body, monospace for dates and counts. Cards are flat with
    a 1px rule, no shadows, no gradients. Motion is quiet: items slide up in a
    40ms stagger after extraction, a card lifts 2px while dragged, and a done
    item strikes through with a short ink-draw animation. Respect reduced motion.
  animations: motion
  reference: https://read.cv

env:
  optional:
    - LLM_BASE_URL: "OpenAI-compatible endpoint, e.g. http://127.0.0.1:3001/v1 (FreeLLMAPI) or http://127.0.0.1:11434/v1 (Ollama)"
    - LLM_API_KEY: "Key for that endpoint; leave empty for Ollama"
    - LLM_MODEL: "Model name, e.g. auto (FreeLLMAPI) or qwen2.5-coder:14b (Ollama)"

preview:
  command: npm run dev
  url: http://127.0.0.1:5173
  routes: ["/", "/api/health"]

phases:
  - id: scaffold
    name: App and API scaffold
    tasks:
      - Create a Vite + React + TypeScript client in the project root and an Express
        API in server/ (TypeScript, run with tsx) on port 8787
      - Vite dev server on 127.0.0.1:5173 with strictPort and a proxy from /api to
        the API; `npm run dev` starts both with concurrently
      - GET /api/health returns JSON with ok set to true
      - Vitest for client and server, one passing test each; npm scripts dev, build, test
      - Read .meadow/design.md and implement every token in src/styles/tokens.css;
        no hex values outside that file
      - src/components/ui/motion.tsx with FadeIn, SlideUp, StaggerList using "motion/react"
      - App shell — header with product name and today's date in monospace, a
        two-column layout (meetings rail + main), styled buttons and inputs
      - Add .env.local to .gitignore and list the three LLM_ names, without values,
        in .env.example
    checks:
      - file_exists: package.json
      - file_exists: server/index.ts
      - file_exists: src/styles/tokens.css
      - cmd: npm install --no-audit --no-fund
        timeout: 300
      - cmd: npm run build
      - cmd: npm test -- --run
      - cmd: git check-ignore -q .env.local
      - http: /api/health
    done_when: Client and API run together, build and tests pass, tokens are in place

  - id: extractor
    name: Action-item extractor
    agent: backend
    depends_on: [scaffold]
    tasks:
      - server/extract/rules.ts — a pure rule-based extractor that finds action items
        in notes (TODO lines, Action lines, unchecked Markdown boxes, "Name will …"
        sentences, @mentions), the owner,
        and due dates ("by Friday", "tomorrow", "2026-10-12") resolved against a
        given meeting date
      - server/extract/llm.ts — when LLM_BASE_URL is set, ask that OpenAI-compatible
        endpoint for JSON items (title, owner, due) with a 20s timeout; validate
        the reply and fall back to the rules on any error. Never log the notes or the key
      - POST /api/extract takes notes and meetingDate and returns the items plus
        a source field (llm or rules); 400 with a clear message for empty notes or
        notes over 20,000 characters
      - Unit tests for the rules (owners, relative dates, no false positives on plain
        sentences) and for the LLM fallback with the endpoint mocked
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /api/health
    done_when: Notes in, clean action items out, with or without an LLM configured

  - id: board
    name: Action board
    agent: ui
    parallel_group: features
    depends_on: [extractor]
    tasks:
      - Paste area with a meeting title and date; the Extract button calls /api/extract and
        shows a quiet loading state, then items animate in with StaggerList
      - Board with To do / Doing / Done columns; move items by drag or by keyboard
        (arrow buttons with labels); owner chip in the accent colour, due date in mono
      - Edit an item inline; delete with undo
      - Show whether items came from the LLM or the rules in a small caption
      - Empty, error and loading states designed, not default
      - Add browser test cases for "/" to meadow.e2e.json (paste notes, extract,
        move an item to Done, reject empty notes)
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - e2e: /
    done_when: A pasted standup becomes a working board you can rearrange

  - id: meetings
    name: Meeting history API
    agent: backend
    parallel_group: features
    depends_on: [extractor]
    tasks:
      - Store meetings (title, date, notes, items with status) as JSON files in
        server/data/ (gitignored), written atomically
      - GET /api/meetings (newest first, without notes), GET /api/meetings/:id,
        POST /api/meetings, PATCH /api/meetings/:id/items/:itemId, DELETE /api/meetings/:id
      - Validate ids and bodies; 404 for unknown meetings
      - GET /api/meetings/:id/export.md returns the meeting as Markdown (title, date,
        items grouped by owner as checkboxes)
      - Supertest tests for every route and the Markdown export
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /api/meetings
    done_when: Meetings and item status survive a server restart and export as Markdown

  - id: history
    name: History rail and export
    agent: ui
    depends_on: [board, meetings]
    tasks:
      - Saving a board creates a meeting; the left rail lists meetings (title, date,
        open-item count) and opening one restores its board
      - Moving an item persists through PATCH; failures roll back with a toast
      - Copy-as-Markdown and Download .md buttons using the export route
      - At 390px the rail becomes a top sheet; nothing scrolls sideways
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - e2e: /
    done_when: Past meetings reopen with their board and export cleanly, on desktop and phone

  - id: qa
    name: Real user flows
    agent: qa
    depends_on: [history]
    tasks:
      - Extend meadow.e2e.json with the full journey — paste notes, extract, move
        items, save, reload, reopen from history, export
      - Edge cases — empty notes, very long notes, notes with no action items,
        LLM endpoint down (rules fallback caption shows)
      - Fix every failure in the app code, not in the tests
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - e2e: /
    done_when: Every flow passes in a real browser
---

# Notes for the engine

- The design system is in `.meadow/design.md`, generated from `ui.prompt`. Read it before writing CSS.
- Animation: the `motion` package, `import { motion, AnimatePresence } from "motion/react"`.
- The LLM variables are optional and live only in `.env.local`. Read them with
  `process.env` on the server; never send them to the client, log them, or commit them.
  Every feature must work with the rules extractor alone.
- Keep dependencies small: React, motion, Express, concurrently, tsx, supertest. No UI kits.
- Date math in small pure functions so it is easy to unit-test.
