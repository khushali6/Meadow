# Meadow

Meadow is a local agent that turns a plain-language request (typed in the dashboard or sent to a Telegram bot, by text or voice) or a `PLAN.md` file into finished, tested code. It drives a coding engine — Cursor CLI or Claude Code — one phase at a time, runs real checks after every phase, and reports back with what changed, what passed, and screenshots.

Everything runs on your machine. The agent's own thinking (clarifying questions, specs, plans, summaries, embeddings, voice transcription) goes through your local FreeLLMAPI gateway, not a hosted service.

## How it works

1. **Request.** You describe what you want. Meadow classifies it (new app, feature, bug, question), looks at the project, and asks up to five short questions.
2. **Spec and plan.** It writes `SPEC.md` and a phased `PLAN.md`. Every phase has at least one check that can actually fail (`cmd`, `file_exists`, or `http`).
3. **Approval.** Nothing touches code until you approve the plan.
4. **Build.** Each phase runs on its own branch (`meadow/phase-<id>-<slug>`). The engine works, guards inspect the diff, checks run, and failures go back to the engine with the real error output — up to three attempts.
5. **Receipts.** A passing phase is committed and fast-forwarded onto your main branch, with a summary, diff stats, check results and (for web projects) desktop and mobile screenshots. A stuck phase stops and tells you why; you can retry with a hint, skip, or roll back.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`)
- git
- FreeLLMAPI running locally (default `http://127.0.0.1:3001/v1`) and its unified API key
- At least one coding engine:
  - Cursor CLI (`cursor-agent`), logged in with `cursor-agent login`, or
  - Claude Code (`claude`), logged in, or routed through FreeLLMAPI
- Optional: Playwright + Chromium for screenshots, a Telegram bot token, `piper` + `ffmpeg` for spoken replies

## Quick start

```bash
pnpm install
pnpm build
node dist/cli.js init      # FreeLLMAPI key, default engine, optional Telegram pairing
node dist/cli.js doctor    # checks everything and says how to fix what's missing
node dist/cli.js start     # prints http://127.0.0.1:7777/?token=…
```

Open the printed link. The token in the URL is your dashboard session; it changes every time Meadow starts.

To link the command globally: `pnpm link --global`, then use `meadow …`.

Run a plan without the dashboard or Telegram:

```bash
meadow plan validate examples/PLAN.md
meadow run examples/PLAN.md --project my-app
```

Try the whole flow with no engine or LLM at all using the built-in fake engine:

```bash
MEADOW_ENGINE=fake meadow run examples/DEMO-PLAN.md
```

## Commands

| Command | What it does |
| --- | --- |
| `meadow init` | Guided setup |
| `meadow doctor` | Checks Node, git, FreeLLMAPI, engines, Playwright, Telegram, voice |
| `meadow start [--port N]` | Starts the daemon: dashboard, Telegram, recovery of interrupted runs |
| `meadow run <PLAN.md> [--engine E] [--project P]` | Runs a plan from the terminal |
| `meadow plan validate <PLAN.md>` | Validates a plan with line-numbered errors |
| `meadow status [project]` | Shows progress |
| `meadow pair` | Prints a new Telegram pairing code |
| `meadow export-run <project> [--out file]` | Exports plans, phases, runs, checks and events as JSON |

In Telegram (and in the dashboard's Request page) you can also use `/new`, `/projects`, `/project`, `/plan`, `/status`, `/phase`, `/pause`, `/resume`, `/stop`, `/retry`, `/skip`, `/rollback`, `/logs`, `/engine`, `/ask`, `/remember`, `/index`, `/notify`, `/budget`, `/shot` and `/help`.

## Plan format

`PLAN.md` starts with YAML front matter; anything after it is passed to the engine as context. See [`examples/PLAN.md`](examples/PLAN.md).

```yaml
---
project: habit-tracker
goal: A small web app to track daily habits
stack: [react, vite]
preview:
  command: npm run dev -- --port 5173
  url: http://127.0.0.1:5173
  routes: ["/"]
phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - Create a Vite + React app with Vitest
    checks:
      - cmd: npm run build
      - cmd: npm test
    done_when: The app builds and tests run
---
```

Check types:

- `cmd: <command>` passes on exit code 0. Optional `expect_regex` and `timeout`.
- `file_exists: <relative path>`
- `http: <route or localhost URL>` — needs a `preview` block; Meadow starts the preview server itself.

## Configuration

Settings live in `~/.meadow/config.json` and are editable from the dashboard's Settings page. Secrets live only in environment variables or `~/.meadow/secrets.env` (created with owner-only permissions), never in config files or project folders.

| Variable | Purpose |
| --- | --- |
| `FREELLMAPI_API_KEY` | Unified key for your local gateway |
| `FREELLMAPI_BASE_URL` | Gateway URL (default `http://127.0.0.1:3001/v1`) |
| `MEADOW_LLM_MODEL` | Model name sent to the gateway (default `auto`) |
| `MEADOW_ALLOW_REMOTE_LLM=1` | Allow a non-localhost gateway (off by default) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` | Optional engine credentials if you don't use their logins |
| `MEADOW_HOME` | Data folder (default `~/.meadow`) |
| `MEADOW_PROJECTS_DIR` | Where projects are created (default `~/meadow-projects`) |
| `MEADOW_PORT` | Dashboard port (default `7777`) |
| `MEADOW_ENGINE` | Default engine: `cursor`, `claude_code` or `fake` |
| `MEADOW_CURSOR_BIN` / `MEADOW_CLAUDE_BIN` | Engine binary paths if not on `PATH` |
| `MEADOW_PIPER_MODEL` | Piper voice model for spoken replies |

Prompt templates can be overridden by placing files in `<project>/.meadow/templates/` or `~/.meadow/templates/`.

## Security

- The dashboard listens on `127.0.0.1` only, rejects requests whose `Host` header isn't a loopback name (DNS-rebinding guard), and requires a per-start session token on every API call. There is no CORS.
- Outbound traffic goes only to the coding engine, your FreeLLMAPI gateway, and Telegram (if configured).
- Secrets, tokens and chat contents are never placed in prompts; logs and events are redacted.
- Engines run with a minimal environment allowlist and are killed as a whole process group on timeout, silence, or stop.
- Guards revert edits to `PLAN.md`, `SPEC.md` and `.meadow/`, revert symlinks that escape the project, block commits that add secrets or credential files, and pause for approval before mass deletions. Approvals that aren't answered in time are denied.
- Screenshots only capture the project's own localhost preview, and pages showing secrets are skipped.
- `.env` files, keys and credentials are never indexed for search.

See [SECURITY.md](SECURITY.md) for the full model and how to report issues.

## Honest limits

- Meadow verifies what the checks measure. A weak check (only `file_exists`) proves little; the validator warns about it.
- Engines are external tools. Meadow can't make Cursor or Claude Code smarter, only keep them on task and catch their failures.
- One engine run at a time across all projects.
- Screenshots need Playwright; without it, web phases still pass on their checks but have no images.
- The CLI flags of `cursor-agent` and `claude` change between versions. Meadow detects them from `--help` and ignores unknown output, but a major CLI change can still need an adapter update. `meadow doctor` shows what was detected.

## Development

```bash
pnpm dev        # daemon with Vite hot reload
pnpm check      # TypeScript
pnpm test       # unit, conformance and integration tests (fake engine, mocked Telegram and LLM)
pnpm build      # dist/public (dashboard) + dist/cli.js
```

Data used by tests is isolated in temporary `MEADOW_HOME` folders. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
