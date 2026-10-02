# Contributing

## Setup

```bash
pnpm install
pnpm check
pnpm test
pnpm dev     # daemon + dashboard with hot reload on http://127.0.0.1:7777
```

Use a throwaway data folder while developing so you don't touch your real projects:

```bash
MEADOW_HOME=/tmp/meadow-dev MEADOW_PROJECTS_DIR=/tmp/meadow-dev/projects MEADOW_ENGINE=fake pnpm dev
```

## Layout

- `server/cli.ts` — the `meadow` command.
- `server/_core/` — HTTP daemon (Express, tRPC, SSE, static dashboard).
- `server/routers.ts` — the dashboard API.
- `server/relay/` — the Telegram relay for the shared Meadow bot (`dist/relay.js`).
- `server/meadow/` — everything else:
  - `harness/` — phase loop, verifier, guards, prompts, summaries
  - `engines/` — Cursor, Codex, Gemini, custom and fake adapters (Claude Code coming soon), process supervisor
  - `intake/` — classify, clarify, spec, plan, conversation state (shared by Telegram and the dashboard)
  - `planning/` — `PLAN.md` parser and validator
  - `channels/` — Telegram and notifications
  - `llm/` — agent model providers (OpenAI-compatible and Anthropic), endpoint policy, health checks
  - `memory/` — local embeddings and embedding spaces
  - `brief/` — project brief, status and plan-next-steps
  - `atlas/` — CodeAtlas graph, retrieval, agents, tools, change impact, MCP
  - `setup/` — project detection, provider and MCP discovery, repository analysis, baseline checks, live graph, preflight impact, health and repair, onboarding
  - `rag/`, `visual/`, `core/` (db and migrations with backup and rollback, events, git, exec, redaction, approvals, signed updates)
- `client/` — React dashboard.
- `tests/` — unit, conformance (engine stream parsing against recorded sessions) and integration tests.

## Rules of thumb

- No network calls in tests. Use the fake engine, a scripted `LlmClient` (`setLlm`), and mocked `fetch` for Telegram.
- Every engine adapter change needs a recorded session fixture in `tests/fixtures/sessions/` and a conformance test.
- Never log or emit a secret. Route new output through `redact()`.
- Child processes get `minimalEnv()`, never `process.env`.
- Database changes are new numbered migrations in `server/meadow/core/db.ts`; never edit an existing one. Existing databases are backed up before migrating and restored if a migration or the integrity check fails, so a migration must be safe to run inside one transaction.
- Anything automatic (setup, live updates, repair, auto-resume) may index, check and draft, but must never approve a plan or run a write tool. Those stay behind the approval queue.

## Pull requests

Run `pnpm check && pnpm test && pnpm build` before opening a PR, and describe how you verified the change.
