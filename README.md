# Meadow — A local-first Agentic Engineering OS with a living software knowledge graph

Meadow turns a plain-language request (typed in the dashboard or sent to a Telegram bot, by text or voice) or a `PLAN.md` file into finished, tested code, and keeps a living knowledge graph of your system so it can explain why things break and what a change will affect.

- **It builds.** Meadow drives a coding engine on your machine (Cursor CLI, Codex CLI, Gemini CLI, or any command-line tool you configure; Claude Code is coming soon) one phase at a time, runs real checks after every phase, and reports back with what changed, what passed, and screenshots.
- **It remembers.** Every project has a local memory: a search index, notes, a knowledge graph and embeddings, all stored on your machine. The agent always works from a compact brief of the whole plan, not just the current step.
- **It understands.** CodeAtlas builds a temporal graph of services, APIs, tables, owners, releases and incidents, answers questions with cited evidence, and traces the impact of a change before you make it.
- **It asks before it acts.** Every tool has a risk level, writes wait for your approval, and every tool call is recorded in an audit log.

The agent's own thinking (clarifying questions, specs, plans, summaries) uses the model provider you choose: a local gateway such as FreeLLMAPI, Ollama or LM Studio, or a cloud provider such as OpenAI, Anthropic, Gemini or OpenRouter. Memory never leaves your machine.

## How it works

1. **Request.** You describe what you want. Meadow classifies it (new app, feature, bug, question), looks at the project, and asks up to five short questions.
2. **Spec and plan.** It writes `SPEC.md` and a phased `PLAN.md`. Every phase has at least one check that can actually fail (`cmd`, `file_exists`, or `http`).
3. **Approval.** Nothing touches code until you approve the plan.
4. **Build.** Each phase runs on its own branch (`meadow/phase-<id>-<slug>`). The engine works, guards inspect the diff, checks run, and failures go back to the engine with the real error output — up to three attempts.
5. **Receipts.** A passing phase is committed and fast-forwarded onto your main branch, with a summary, diff stats, check results and (for web projects) desktop and mobile screenshots. A stuck phase stops and tells you why; you can retry with a hint, skip, or roll back.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`)
- git
- A model provider for the agent (see [Agent model providers](#agent-model-providers)): a local gateway (FreeLLMAPI, Ollama, LM Studio) or a key for OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible API
- At least one coding engine:
  - Cursor CLI (`cursor-agent`), logged in with `cursor-agent login`
  - Claude Code: coming soon. It shows in the dashboard but can't be selected yet; projects that used it keep their settings and run on your default engine until the adapter ships
  - Codex CLI (`codex`), logged in with `codex login`
  - Gemini CLI (`gemini`), signed in or with `GEMINI_API_KEY`
  - Anything else (aider, opencode, a script) through the custom engine: set `engine.custom.command` in `~/.meadow/config.json`. It receives the prompt as `$MEADOW_PROMPT` and `$MEADOW_PROMPT_FILE`, runs in the project folder, and its exit code decides success.
- Optional: Playwright + Chromium for screenshots, a Telegram bot token, `piper` + `ffmpeg` for spoken replies, `whisper.cpp` + `ffmpeg` for local voice transcription

## Quick start

```bash
pnpm install
pnpm build
node dist/cli.js init      # agent provider and key, default engine, optional Telegram pairing
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
| `meadow doctor` | Checks Node, git, the agent provider, memory, engines, Playwright, Telegram, voice |
| `meadow start [--port N]` | Starts the daemon: dashboard, Telegram, recovery of interrupted runs |
| `meadow run <PLAN.md> [--engine E] [--project P]` | Runs a plan from the terminal |
| `meadow plan validate <PLAN.md>` | Validates a plan with line-numbered errors |
| `meadow status [project]` | Shows progress |
| `meadow pair` | Prints a new Telegram pairing code |
| `meadow export-run <project> [--out file]` | Exports plans, phases, runs, checks and events as JSON |
| `meadow atlas demo` | Generates the AcmePay demo repo (six services, releases, a planted incident) and indexes it |
| `meadow atlas ingest <project>` | Builds or refreshes the CodeAtlas knowledge graph |
| `meadow atlas ask <project> "<question>" [--mode agentic\|hybrid\|graph\|vector]` | Runs an investigation and streams the agent trace |
| `meadow atlas eval <project> [--json file]` | Benchmarks the retrieval modes against `.atlas/eval.json` |
| `meadow atlas tools` / `meadow atlas mcp-config` | Lists the tools / prints the MCP config for Cursor and Claude Code |
| `meadow mcp [--project P]` | Runs the CodeAtlas MCP server over stdio |

In Telegram (and in the dashboard's Request page) you can also use `/new`, `/projects`, `/project`, `/plan`, `/status`, `/phase`, `/pause`, `/resume`, `/stop`, `/retry`, `/skip`, `/rollback`, `/logs`, `/engine`, `/next`, `/ask`, `/remember`, `/index`, `/notify`, `/budget`, `/shot`, `/investigate` (also `/why`) and `/help`.

## Connect Telegram

Open **Runtime settings → Telegram** and click **Connect Telegram**. Telegram opens on the Meadow bot; tap **Start** and you're connected. There's no bot to create and no token to copy. `meadow init` offers the same thing as a link you can open on your phone.

Under the hood the link carries a one-time, random code that is valid for 15 minutes. The first account that taps Start with it becomes the only one that can control your Meadow. **Disconnect** forgets the link on both sides.

If you prefer, **Advanced → My own bot** still works the old way: paste a token from @BotFather and send the pairing code to your bot. In that mode Meadow talks to Telegram directly.

### How the shared bot works (and hosting it)

One bot can serve many people only if something routes each chat to the right computer, so the Meadow bot sits behind a small **relay** (`server/relay/`, built to `dist/relay.js`):

- The relay holds the bot token and is the only thing that talks to Telegram as the bot. Your Meadow never sees the bot token; it gets its own device token, stored in `~/.meadow/secrets.env` as `TELEGRAM_RELAY_TOKEN`.
- A chat is attached to a device only through the one-time Start link that device requested. A device can read updates only from its own chat and can send messages, screenshots and voice notes only to its own chat. It can download only files sent in its own chat, and it can't call anything outside a short list of Bot API methods.
- Messages pass through the relay's memory on the way to your computer. The relay writes only device bindings (a hash of each device token, plus the chat and user ID) to disk.
- Strangers who message the bot get a short "connect from Meadow" reply and never reach anyone's computer.

To run the bot for your users:

1. Create the bot once with @BotFather (name, picture, description).
2. Deploy the relay anywhere that can serve HTTPS:

   ```bash
   pnpm build
   TELEGRAM_BOT_TOKEN=123456:ABC... PORT=8787 RELAY_DATA=./relay-data/devices.json node dist/relay.js
   # or: docker build -f deploy/relay.Dockerfile -t meadow-relay . && docker run -e TELEGRAM_BOT_TOKEN=... -p 8787:8787 -v meadow-relay:/data meadow-relay
   ```

3. Put its public HTTPS URL in `HOSTED_RELAY_URL` in `server/meadow/channels/relay.ts` and rebuild, so every install connects to it out of the box. Users can also point to a different relay with `MEADOW_RELAY_URL` or Settings → Telegram → Advanced → Relay URL.

The relay must be served over HTTPS; Meadow refuses plain HTTP except on localhost. Run a single instance, because Telegram delivers each bot's updates to one consumer.

## Progress on Telegram

Once connected, Meadow reports every run as it happens:

- **Run started**, with Pause and Stop buttons.
- **A live progress card per phase**, edited in place (no notification spam): current stage (preparing, engine working, running checks, fixing), attempt number, engine, elapsed time, each check with ✓/✗, and the latest engine activity (files edited, commands run, messages). It refreshes every 30 seconds during long engine steps.
- **Fix attempts, guard reverts and harness errors** as short silent messages.
- **Phase passed** cards with checks, diff stats, new dependencies and screenshots; **blocked** cards with Retry with hint / Retry / Skip / Roll back / Stop; **approvals** that default to Deny; **run finished**.

Notification levels: *Everything* (default, includes the live card), *Phase starts and results*, or *Only problems*. Quiet hours hold non-urgent messages until the window ends; blocked phases and approvals always come through.

## CodeAtlas: ask your system

CodeAtlas is Meadow's engineering-intelligence layer. It builds a **temporal knowledge graph** of each project and answers questions like *"Why did payment-service start timing out after v2.4.0?"* with cited, verified evidence. It can then hand the fix to the Meadow harness.

**What gets indexed (locally):** services (from package/go/python markers or `services/`, `apps/` and similar folders), files, functions and classes, imports and calls, HTTP routes and OpenAPI specs, SQL/Prisma tables with reads and writes, service-to-service calls (URLs, env vars, compose `depends_on`), Terraform resources, CI deploy pipelines, dependencies, CODEOWNERS teams, Markdown docs and ADRs, incident and postmortem files, and git history: commits, authors, PRs parsed from merge messages, and tags as releases. Nodes and edges carry `valid_from`/`valid_to`, so "what changed between v2.3.0 and v2.4.0" is a graph query. GitHub issues/PRs, Jira and Linear are optional connectors, off until you enable them and save a token.

**How a question is answered:**

1. **Supervisor**: classifies the query (semantic, entity, exact, relationship, code, temporal, multi-hop), then plans sub-questions and tool calls. It uses your agent model when one is configured and rules otherwise.
2. **Researcher**: hybrid retrieval. Vector, BM25 (SQLite FTS5), symbol and graph retrievers are fused with reciprocal rank fusion using per-query-type weights. Results get release windows, parent context (function → file → service), snippet compression and optional LLM reranking.
3. **Architect**: graph paths between entities and, for incidents, a ranking of suspect PRs and commits scored against their actual diffs.
4. **Operator**: calls internal read tools and any external MCP tools you configure that declare themselves read-only.
5. **Writer**: an answer where every sentence cites evidence `[n]`.
6. **Verifier**: checks each claim against its sources, re-retrieves once for unsupported claims, and marks the rest *unverified*.

**Where you use it:**

- **Dashboard → CodeAtlas**: ask questions and watch the live agent trace, the answer with citations, verifier scores, ranked suspects, graph evidence and sources.
- **Dashboard → System map**: architecture, API, history and code layers. Click nodes, find the path between any two, or overlay an investigation's evidence path.
- **Telegram**: `/investigate <question>` edits one live card as the agents work, then sends the answer with **Fix with Meadow** and **Create issue** buttons.
- **Cursor, Claude Code and other MCP clients**: `meadow atlas mcp-config` prints the snippet. The server runs locally over stdio and exposes `search_code`, `get_repository_map`, `find_dependencies`, `trace_service`, `find_related_incidents`, `get_recent_deployments`, `get_pull_request`, `get_issue`, `query_architecture`, `get_owner`, `change_impact`, `investigate`, `run_tests`, `create_issue` and `propose_patch`.

**Write tools are gated.** `run_tests`, `create_issue` and `propose_patch` only create a pending action and an approval request. Nothing runs until you approve it in the dashboard or on Telegram, and unanswered approvals expire as denied. Approved actions run inside the Meadow daemon, even when an MCP client requested them. `propose_patch` turns the root cause into a one-phase plan with your project's test command as its check (or, if there isn't one, a check that the suspect files actually changed) and runs it through the normal harness, with the same guards, branches and progress reporting.

**Change impact.** Select any node on the System map and press **Change impact**, or call the `change_impact` tool with an entity or a list of files. Meadow walks the graph from that node to everything that depends on it (callers, importers, handlers, deploy pipelines, exposed APIs and written tables) up to three hops, then reports the services, APIs and tables affected, their owners, related past incidents, the tests among the affected code, and a risk level with its reasons. Every entry shows the relation that put it there, for example `order-service ─calls→ payment-service`. It is a graph traversal, not a model guess.

**Benchmark.** `meadow atlas eval` scores each retrieval mode against `.atlas/eval.json` (questions plus the graph node keys that answer them). On the bundled AcmePay demo (12 questions, LLM off, local hashed vectors):

| Mode | Recall@5 | Recall@10 | MRR | nDCG@10 | Answer hit | Faithfulness | Latency avg / p95 |
|---|---|---|---|---|---|---|---|
| vector | 0.48 | 0.65 | 0.48 | 0.45 | 0.64 | 0.98 | 3 / 13 ms |
| graph | 0.77 | 0.90 | 0.74 | 0.76 | 0.89 | 1.00 | 2 / 4 ms |
| hybrid | 0.90 | 0.98 | 0.78 | 0.80 | 0.97 | 1.00 | 2 / 5 ms |
| agentic | 0.90 | 0.96 | 0.78 | 0.80 | 1.00 | 1.00 | 8 / 58 ms |

These numbers come from a small synthetic repo that the same code generates, so treat them as a regression baseline rather than a general claim. Add your own `.atlas/eval.json` to measure your codebase.

## Agent model providers

The agent model writes questions, specs, plans and summaries, and helps CodeAtlas plan and write answers. Pick it in Settings → Agent model or with `meadow init`. **Test connection** checks credentials, the endpoint, that the model exists, a real chat reply and embeddings, and shows each step.

| Provider | Kind | Key | Notes |
| --- | --- | --- | --- |
| FreeLLMAPI | local gateway | `FREELLMAPI_API_KEY` | Default `http://127.0.0.1:3001/v1` |
| Ollama | local | none | Default `http://127.0.0.1:11434/v1` |
| LM Studio | local | none | Default `http://127.0.0.1:1234/v1` |
| OpenAI | cloud | `AGENT_OPENAI_API_KEY` | Chat, embeddings, transcription |
| Google Gemini | cloud | `AGENT_GEMINI_API_KEY` | Chat, embeddings |
| Anthropic | cloud | `AGENT_ANTHROPIC_API_KEY` | Native Messages API, chat only |
| OpenRouter | cloud | `OPENROUTER_API_KEY` | Chat only |
| OpenAI-compatible | custom | `LLM_API_KEY` (optional) | Groq, Mistral, DeepSeek, vLLM and others |

**Agent keys are separate from engine keys.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `CURSOR_API_KEY` are only passed to coding engines. The agent uses the `AGENT_*` keys above, so a cloud key you give the agent is never handed to an engine and the reverse.

**Endpoint policy.** Local providers must use a loopback address. Cloud providers always use their official HTTPS endpoint, which can't be changed. A custom endpoint must be loopback unless you turn on *allow remote* for it, and remote custom endpoints must use HTTPS. `MEADOW_ALLOW_REMOTE_LLM=1` lifts the loopback rule for local and custom providers.

**Errors.** Provider failures are classified (authentication, rate limit, model not found, unreachable, bad response). Rate limits are retried with backoff; authentication and model errors stop at once with the fix.

**Voice.** Telegram voice notes are transcribed by the provider when it supports it (OpenAI, FreeLLMAPI). Otherwise Meadow uses a local `whisper.cpp` (`whisper-cli` or `whisper-cpp` plus `ffmpeg`, model in `MEADOW_WHISPER_MODEL`) if installed, and tells you how to enable either one if neither is available.

## Memory and embeddings

Each project's memory (the context index of code and docs, your notes, the CodeAtlas graph and all embeddings) lives in Meadow's local SQLite database and never leaves your machine.

- **Local embeddings by default.** Meadow ships a deterministic local embedding (`local:meadow:hashed-512:v2`: feature hashing over words and word pairs). It needs no model or network, and search fuses it with keyword (FTS5) ranking.
- **Optional model embeddings** come only from a local provider (Ollama, LM Studio, FreeLLMAPI, or a loopback custom endpoint). Cloud providers are never used for embeddings, so your code is not sent anywhere to be indexed.
- **Versioned.** Every stored vector records the embedding space it came from. When you change the embedding setting, Memory shows how many chunks are stale, and **Re-embed stale chunks** rebuilds them atomically (search keeps working on the old vectors until the new ones are complete).
- What goes to a cloud chat provider is only the prompt text and the snippets selected for that prompt.

## Project brief and next steps

Every engine prompt includes a **project brief**: the goal, constraints, stack, the whole roadmap with status, the current phase, recent failures, recently changed files, notes and pending approvals. The brief is compressed to a token budget by dropping the least important sections first, so the engine always knows where the phase fits in the full plan and stays inside it. Fix attempts get the attempt number, the phase tasks and the real check output.

Repository content (files, issues, check output, search results) is wrapped and marked as untrusted data, and prompts tell the model to treat it as information, never as instructions.

The **status panel** on the Live console shows progress through the roadmap, what's blocking, and suggested next actions. **Plan next steps** (also `/next [focus]` on Telegram) asks the agent to extend a finished or stalled plan from the brief; the result is a new plan version that waits for your approval like any other.

## Tool risk levels and audit log

Every CodeAtlas and MCP tool has a risk level, enforced on the server:

| Risk | Examples | Policy |
| --- | --- | --- |
| `READ` | search, graph queries, `change_impact`, `investigate` | Runs directly |
| `LOW_WRITE` | `create_issue` | Needs approval |
| `HIGH_WRITE` | `run_tests`, `propose_patch` | Needs approval (high) |
| `DESTRUCTIVE` | none exposed today | Needs approval; never callable over MCP |

Tool arguments are validated strictly (unknown fields are rejected, file paths must stay inside the project). External MCP tools are offered to agents only if they declare themselves read-only.

Every tool call, including refused ones and approval outcomes, is written to the **audit log** (Policy gates page): time, agent, tool, risk, user, a hash of the arguments, the approval outcome, the result and the duration. Arguments themselves are never stored, and details are redacted.

## Rate limits

When an engine run fails because of a rate limit, Meadow doesn't spend a fix attempt on it. It pauses the phase, waits (30 s, 1 min, 2 min, 5 min by default; set `MEADOW_RATE_LIMIT_WAITS`, in seconds, comma-separated), and retries the same attempt. If the limit persists after the last wait, the run is paused and you can resume it later. Stopping or pausing interrupts a wait immediately.

## Observability

The Observability page shows numbers computed only from Meadow's own records, per project or across all projects, over 7 to 90 days: engine runs (completion rate, median and p95 duration, tokens, cost as reported by engines, failure reasons, rate-limit waits), phase pass rate and first-try rate, check pass rate and the slowest checks, approvals by outcome, tool calls by risk and result, and CodeAtlas investigation latency. Where there is no data, it shows a dash rather than a number.

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
| `MEADOW_LLM_PROVIDER` | Agent provider: `freellmapi`, `ollama`, `lmstudio`, `openai`, `gemini`, `anthropic`, `openrouter` or `custom` |
| `MEADOW_LLM_MODEL` | Agent model for the active provider |
| `FREELLMAPI_API_KEY` / `AGENT_OPENAI_API_KEY` / `AGENT_GEMINI_API_KEY` / `AGENT_ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `LLM_API_KEY` | Agent provider keys (separate from engine keys) |
| `FREELLMAPI_BASE_URL` | FreeLLMAPI gateway URL (default `http://127.0.0.1:3001/v1`) |
| `MEADOW_ALLOW_REMOTE_LLM=1` | Allow a non-loopback local or custom endpoint (off by default) |
| `MEADOW_RATE_LIMIT_WAITS` | Seconds to wait between rate-limit retries, e.g. `30,60,120,300` |
| `MEADOW_WHISPER_MODEL` | Path to a whisper.cpp model for local voice transcription |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional engine credentials if you don't use their logins (never given to the agent) |
| `MEADOW_HOME` | Data folder (default `~/.meadow`) |
| `MEADOW_PROJECTS_DIR` | Where projects are created (default `~/meadow-projects`) |
| `MEADOW_PORT` | Dashboard port (default `7777`) |
| `MEADOW_ENGINE` | Default engine: `cursor`, `codex`, `gemini`, `custom` or `fake` (`claude_code` is coming soon) |
| `MEADOW_CURSOR_BIN` / `MEADOW_CLAUDE_BIN` / `MEADOW_CODEX_BIN` / `MEADOW_GEMINI_BIN` | Engine binary paths if not on `PATH` |
| `MEADOW_RELAY_URL` | Telegram relay for the shared Meadow bot (defaults to the built-in one) |
| `MEADOW_PIPER_MODEL` | Piper voice model for spoken replies |
| `GITHUB_TOKEN` / `JIRA_API_TOKEN` / `LINEAR_API_KEY` | CodeAtlas connectors, used only when enabled in Settings → CodeAtlas |
| `MEADOW_ATLAS_NO_LLM=1` | Force CodeAtlas to its rule-based planner and writer |

Each engine can have its own model (Settings → Coding engine, or `engine.models` in `config.json`). If an engine reports that it isn't logged in or can't use the chosen model, the phase stops at once with the fix instead of retrying.

External MCP servers for the CodeAtlas operator go in `atlas.mcpServers` in `config.json` (`{ "name", "command", "args", "secrets": ["NAME"] }`). They are spawned with a minimal environment plus only the secrets you list.

Prompt templates can be overridden by placing files in `<project>/.meadow/templates/` or `~/.meadow/templates/`.

## Security

- The dashboard listens on `127.0.0.1` only, rejects requests whose `Host` header isn't a loopback name (DNS-rebinding guard), and requires a per-start session token on every API call. There is no CORS.
- Outbound traffic goes only to the coding engine, the agent model provider you chose, Telegram (directly with your own bot, or through the Meadow bot relay), and connectors you enable. Memory (index, notes, graph, embeddings) stays local; cloud providers never compute embeddings.
- Secrets, tokens and chat contents are never placed in prompts; logs and events are redacted.
- Engines run with a minimal environment allowlist and are killed as a whole process group on timeout, silence, or stop. Claude Code runs with `--strict-mcp-config`, so your global MCP servers (browsers, remote tools) are not available inside project runs.
- Guards revert edits to `PLAN.md`, `SPEC.md` and `.meadow/`, revert symlinks that escape the project, block commits that add secrets or credential files, and pause for approval before mass deletions. Approvals that aren't answered in time are denied.
- Screenshots only capture the project's own localhost preview, and pages showing secrets are skipped.
- `.env` files, keys and credentials are never indexed for search, by the context index or by CodeAtlas. Files that look like they contain a secret are skipped, and every trace, answer and tool result is redacted.
- CodeAtlas write tools (tests, issues, patches) only queue approvals. The MCP server cannot execute them itself; the daemon runs them after you approve. Destructive tools can never be called over MCP, and every call is audited with an argument hash, never the arguments.
- Repository content in prompts is marked as untrusted data, not instructions.
- Keys are never stored in the database, events, logs, traces or the UI.

See [SECURITY.md](SECURITY.md) for the full model and how to report issues.

## Honest limits

- CodeAtlas parsing is regex-based, not a full compiler front end. It handles the common TypeScript/JavaScript, Python, Go, SQL, Terraform and OpenAPI shapes, but dynamic dispatch, generated code and unusual layouts are missed or approximated. Without an agent model, answers come from templates, which are accurate but terse.

- Meadow verifies what the checks measure. A weak check (only `file_exists`) proves little; the validator warns about it.
- Engines are external tools. Meadow can't make them smarter, only keep them on task and catch their failures. Small local models (around 14B parameters) usually can't drive an agentic CLI reliably; Meadow will block those phases rather than pretend.
- The Codex and Gemini adapters follow those CLIs' documented JSON output but haven't been run against every version; `meadow doctor` shows what was detected.
- One engine run at a time across all projects.
- The local embedding is a hashed bag of words and word pairs. It finds lexical and near-lexical matches well but has no real semantic understanding; configure a local embedding model (for example `nomic-embed-text` in Ollama) for better recall.
- Change impact follows the edges CodeAtlas extracted. Calls made through dynamic dispatch, reflection or configuration it couldn't parse won't appear.
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
