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
4. **Build.** Each phase runs on its own branch (`meadow/phase-<id>-<slug>`). The engine works, guards inspect the diff, checks run, and failures go back to the engine with the real error output — up to three attempts. The engine (for example the Cursor CLI) does all of the coding, headless; the agent model only plans and summarises. When a run starts, Meadow opens the project in your editor (Cursor for the Cursor CLI) so you see files change, and a terminal window following the engine's live output (`~/.meadow/logs/live/<project>.log`). **Watch** on the Live console opens them again; **Settings → Watch runs** turns them off.
5. **Receipts.** A passing phase is committed and fast-forwarded onto your main branch, with a summary, diff stats, check results and (for web projects) desktop and mobile screenshots. A stuck phase stops and tells you why; you can retry with a hint, skip, or roll back.
6. **End-to-end tests in a browser.** After the last phase, Meadow adds one built-in phase. The coding engine writes `meadow.e2e.json`, with one test case per main user flow (fill a field by its label, click a button, expect some text, take a screenshot). Meadow then starts the app exactly as you would (the `dev`/`start` script, nothing overridden; or the plan's `preview` block, Django, FastAPI, Flask, Streamlit, Rails, PHP or a built `index.html`) and runs every case in a real headless browser. A case fails on crashes, console errors, failed requests, API calls answered by an HTML page, error messages on screen, or a missing expected text. Failures go back to the engine with the failing step, the errors, the page text, a screenshot path and the app's output, and the engine fixes the app until every case passes. Deleting test cases doesn't count as a fix. Only then does Telegram get one card per test case with its screenshots, followed by the completion report with a "run it yourself" command. The browser uses a throwaway profile and can only reach localhost. Turn it off in Settings → Harness → End-to-end tests; projects with no web page (CLIs, libraries) skip it and get the plain finished-app screenshots instead (**Screenshot again** or `/shot` repeats those).

Every new plan, whether it came from the dashboard, setup, CodeAtlas or a request, is also sent to Telegram for review with **Approve and start**, **Edit** and **Improve checks** buttons. Plans are written for the tools this machine has (Node, pnpm, Python, Go…), so their checks can actually run here.

## Requirements

- macOS, Linux or Windows (native or WSL), on x64 or arm64
- Node.js 22.16+ or 24+ (Meadow uses the built-in `node:sqlite` with full-text search; Node 23 and earlier 22.x releases don't ship it). The `meadow` command checks this first and tells you what to install.
- git
- A model provider for the agent (see [Agent model providers](#agent-model-providers)): a local gateway (FreeLLMAPI, Ollama, LM Studio) or a key for OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible API
- At least one coding engine. Setup's **Coding engine** step finds what's installed (also in `~/.local/bin`, Homebrew, npm and pnpm folders that a desktop-launched Meadow may not have on PATH), notes desktop apps such as Cursor or VS Code, and lets you pick one. **Connect** runs the engine's own browser sign-in and finishes on its own; **Install** runs the vendor's install command, only when you click it; or paste the engine's API key. Runs refuse to start until the chosen engine is installed and signed in.
  - Cursor CLI (`cursor-agent` / `agent`): Install and Connect from Setup, or `CURSOR_API_KEY`
  - Claude Code: coming soon. It shows in the dashboard but can't be selected yet; projects that used it keep their settings and run on your default engine until the adapter ships
  - Codex CLI (`codex`): Install and Connect from Setup, or an OpenAI API key
  - Gemini CLI (`gemini`): Install from Setup, then sign in once by running `gemini`, or paste a `GEMINI_API_KEY`
  - Anything else (aider, opencode, a script) through the custom engine: set `engine.custom.command` in `~/.meadow/config.json`. It receives the prompt as `$MEADOW_PROMPT` and `$MEADOW_PROMPT_FILE` (`%MEADOW_PROMPT_FILE%` on Windows, where the command runs in `cmd.exe`), runs in the project folder, and its exit code decides success.
- For screenshots: any Chromium-based browser already installed (Chrome, Edge, Chromium, Brave; or Playwright's Chromium). Set `MEADOW_BROWSER` to use a specific one.
- Optional: a Telegram bot token, `piper` + `ffmpeg` for spoken replies, `whisper.cpp` + `ffmpeg` for local voice transcription

## Quick start

From a checkout, one command does everything before your first project:

```bash
./startup.sh                        # macOS, Linux, WSL, Git Bash
powershell -ExecutionPolicy Bypass -File .\startup.ps1   # Windows
```

It checks Node.js (and offers to install Node 24 through fnm, nvm, Volta, Homebrew or winget), installs dependencies, builds, then runs `meadow setup`:

1. **Keys**: saves any `TELEGRAM_BOT_TOKEN`, `CURSOR_API_KEY`, `FREELLMAPI_API_KEY`, `AGENT_*`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, ... found in your environment or in `--env-file keys.env` to `~/.meadow/secrets.env` (mode 600). It can also reuse your GitHub CLI login, if you say yes.
2. **Agent model**: uses the best detected server and tests it with a real request. If Ollama is installed but stopped, it starts it. If Ollama has no usable model, it offers to download one that fits your RAM. Otherwise it asks for one API key and works out the provider from it.
3. **Coding engine**: lists what's installed and signed in, asks which engine to use, installs it if needed, and runs its browser sign-in. You can paste a key instead.
4. **Telegram**: opens @BotFather, validates the token you paste with Telegram, then opens your bot with a pairing link and waits until you tap Start.

Then it starts Meadow and opens the dashboard. Run it again any time; working parts are kept. Options: `--yes` (no questions; also accepts installs and downloads), `--env-file F`, `--no-start`, `--skip-model`, `--skip-engine`, `--skip-telegram`. Without a terminal and without `--yes`, it never installs, downloads or opens a sign-in.

Meadow isn't on the npm registry yet. Install it from a release tarball:

```bash
npm install -g ./meadow-1.0.0.tgz   # from the GitHub release
meadow doctor                        # platform, Node, git, data folder, engines, model provider
```

Or from source:

```bash
pnpm install
pnpm build
cd ~/code/your-repo
node /path/to/meadow/dist/cli.js init    # detects the repo and model servers, builds the graph, runs checks, drafts a plan
node /path/to/meadow/dist/cli.js start   # prints http://127.0.0.1:7777/?token=…
```

Open the printed link. The token in the URL is your dashboard session; it changes every time Meadow starts. On first launch with no projects, the dashboard opens **Setup**, which does the same as `init` step by step in the browser. The whole path is: install, open a project, connect Telegram, approve the plan.

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

On Windows PowerShell: `$env:MEADOW_ENGINE="fake"; meadow run examples/DEMO-PLAN.md`.

## Platform support

The same build runs on macOS, Linux and Windows. CI tests every change on all three with Node 22.16, 24 and 26.

- **Windows (native):** engine shims such as `codex.cmd` are started safely without a shell, stopping a run kills the whole process tree (`taskkill /T /F`), and `cmd:` checks run in `cmd.exe`. Checks Meadow generates use `node -e`, so they work in any shell; hand-written POSIX checks (`test -f`, `grep`) won't run in `cmd.exe`.
- **WSL:** behaves like Linux. Keep repositories in the Linux filesystem (`~/code`), not `/mnt/c`, and install engines inside WSL. Open the dashboard from Windows at the printed `127.0.0.1` URL.
- **Paths:** Setup accepts `~/code/app`, `C:\code\app`, UNC paths and quoted paths. Spaces, quotes, `$`, `%` and non-ASCII characters in paths are handled.
- **Monorepos:** languages, frameworks and databases are detected in sub-folders (`services/*`, `apps/*`, `packages/*`). Verify commands come from the root; for kinds the root lacks, package commands are added as `cd "services/x" && …`. Dependency installs run per package.

[docs/EDGE-CASES.md](docs/EDGE-CASES.md) lists the situations that can still fail (old Node, proxies, network drives, ports, engines not logged in, Telegram blocked, clock skew, and more) with the fix for each.

## Commands

| Command | What it does |
| --- | --- |
| `meadow init` | Guided setup: detects the current repo and model providers, registers the project, builds CodeAtlas and memory, runs the baseline checks, drafts a first plan |
| `meadow update [--yes]` | Checks for a signed update, verifies signature and checksum, backs up the database, installs |
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

## Automatic setup and self-maintenance

Meadow sets itself up from what is already in the repository and keeps itself working without supervision. It never executes a plan, a write tool or a destructive action without your approval.

**Setup** (dashboard on first launch, or `meadow init` in a repo):

1. **Find the repository.** Type just its name (`acmepay`), a path, `owner/repo` or a git URL. Meadow searches the folder it was started from, your projects folder and the usual code folders for this OS (`~/code`, `~/Developer`, `~/projects`, `~/source/repos`, `Documents/GitHub`, `C:\dev`, WSL's `/mnt/c/Users/...`), within a 2.5-second budget. For `owner/repo` or a URL it clones (with `gh` when installed, otherwise `git`, never prompting for a password) into the right place: `MEADOW_PROJECTS_DIR`, else the folder that already holds most of your repositories, else the platform default (`~/Developer` on macOS, `~/code` on Linux, `~/source/repos` on Windows). If nothing matches, it offers to create the folder there.
   Then it reads `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Dockerfile`, Compose files, `.git`, `.github/workflows`, editor MCP configs and the *key names* in `.env.example`, and infers languages, frameworks, package manager, test framework, build, CI, databases and the typecheck, lint, test and build commands. `.env` is never read.
2. **Pick a model.** Probes `localhost:3001` (FreeLLMAPI), `:11434` (Ollama) and `:1234` (LM Studio) and checks agent keys. When a local server is running, Meadow reads its installed models (size, parameter count, family), drops embedding, vision and image models, and picks the strongest instruction-tuned chat model that fits in about 60% of this machine's RAM (for example `qwen2.5:14b` on 24 GB, `qwen2.5-coder:32b` on 64 GB). If an embedding model such as `nomic-embed-text` is installed, memory search uses it. It then runs a real chat and embedding request and shows each result, with no click needed. Every provider has a key field: paste a FreeLLMAPI, OpenAI, Gemini, Anthropic or OpenRouter key and Meadow saves it to `~/.meadow/secrets.env` and immediately re-probes, so a rejected key is reported right away. Engine keys (`OPENAI_API_KEY` and friends) are reported but never borrowed for the agent.
3. **Build knowledge.** Builds the CodeAtlas graph and the local memory index, with progress.
4. **Connect tools.** Lists MCP servers from `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json`. **Connect** copies the command; secret *values* are never copied, only names of secrets Meadow manages.
5. **Connect Telegram** with one click (below).
6. **Learn what "working" means.** **Install dependencies** (one click, never automatic, since install scripts run) uses the tool each package's lockfile asks for: pnpm, yarn, bun or npm; uv or poetry; a project-local `.venv` plus pip for plain Python (never the system interpreter); `go mod download`, `cargo fetch`, `bundle install`, `composer install`. Missing tools are listed with where to get them instead of failing. Then the detected commands run once as a baseline. Commands that pass are enforced after every phase; ones that already fail don't block agents until fixed; ones whose tool isn't installed ("command not found") are shown as skipped and never become plan tasks.
7. **Draft a first plan** from the analysis: services ranked by callers, APIs and tables; hotspots; services without tests; tables written by several services; TODO/FIXME debt; past incidents. Every phase gets a check that fails today and passes when the work is done. The plan is a draft until you approve it.

**While running:**

- **Live graph.** Every 20 s Meadow compares git HEAD and the working tree with the last indexed state, re-chunks the changed files and rebuilds the graph in one transaction (debounced to once every 30 s, skipped while a run is active on that project).
- **Impact before changes.** Before each phase, the services, APIs, tables, owners and incidents the phase is likely to touch go into the engine's context and the event log.
- **Next step.** When a run completes, Meadow suggests the next action (for example, plan the next phases). Executing it still needs your approval.
- **Self-check and repair.** Every two minutes Meadow checks the database, memory, CodeAtlas, the agent model, MCP servers and Telegram. It reconnects Telegram and MCP servers and re-embeds stale memory on its own, and tells you only when something changed. **Settings → Health and data → Diagnose and repair** runs it on demand; a banner appears when something needs you.
- **Telegram reconnects** after network failures with backoff (1 s, 2 s, 5 s, 10 s, 30 s, 60 s, with jitter), without pairing again. Settings shows *Reconnecting…* and the next retry time.
- **Crash recovery.** Interrupted runs are marked at startup. With **Resume interrupted runs on restart** on (off by default), they continue from the last verified phase.
- **Safe upgrades.** Before a schema migration, the database is copied to `~/.meadow/backups/` (the newest five are kept). Each migration runs in a transaction, an integrity check runs afterwards, and on any failure the backup is restored and Meadow refuses to start with a clear message.
- **Signed updates.** `meadow update` and the dashboard banner trust only a release manifest signed (Ed25519) by the publisher key built into Meadow, download over HTTPS, verify the SHA-256, back up the database and install with npm. Migrations and `meadow doctor` run on the next start.

All of these can be switched off in **Settings → Automation**.

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

Tool arguments are validated strictly (unknown fields are rejected, file paths must stay inside the project).

Tools from external MCP servers are classified when listed: **READ** if the server marks them read-only, **DESTRUCTIVE** if they are marked destructive or their name says delete, remove, drop, merge, force, purge, reset, revoke and similar (this wins over a read-only claim), otherwise **WRITE**. Read tools run automatically; write tools go through the same approval queue as Meadow's own; destructive tools always need approval and are refused when requested by an MCP client.

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
| `MEADOW_UPDATE_URL` | HTTPS URL of the signed release manifest (empty: update checks are off) |
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
- The live graph re-chunks changed files individually, but the knowledge graph itself is rebuilt in full (inside one transaction) rather than patched per file. On very large repositories that rebuild takes longer; it is debounced and skipped while a run is active.
- The first plan is generated from the graph and the baseline with fixed rules, not by a model, so it is predictable but generic. Edit it, or use **Plan next steps** with a model for something more tailored.
- Signed updates need the maintainer to publish signed manifests and set the publisher key and `MEADOW_UPDATE_URL`. Until then, update checks say "not configured" and you upgrade with your package manager. Installing replaces the global npm package; it doesn't swap binaries in place.
- Self-repair can reconnect and re-index, but it can't fix a wrong API key, a stopped model server or a corrupted database; it tells you what to do instead.
- Change impact follows the edges CodeAtlas extracted. Calls made through dynamic dispatch, reflection or configuration it couldn't parse won't appear.
- Hand-written `cmd:` checks run in the platform shell (`/bin/sh` or `cmd.exe`). A plan written with POSIX commands won't pass on native Windows; use `node -e` or tool commands (`npm test`) for plans you share across platforms.
- End-to-end tests and screenshots need a Chromium-based browser (Playwright's, Chrome, Edge, Chromium or Brave). Without one, runs still pass on their checks but skip browser tests and images.
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
