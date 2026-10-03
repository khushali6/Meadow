# Where Meadow can fail, and what to do

Meadow runs on macOS, Linux and Windows (native or WSL). This page lists the situations that still break a first setup or a run, how Meadow reacts, and the fix. Run `meadow doctor` first: most of these show up there with a fix line.

## Installing and starting

| Situation | What happens | Fix |
| --- | --- | --- |
| Node older than 22.16, or Node 23 | The launcher stops with "Meadow needs Node.js 22.16+ or 24+" before loading anything. | Install the current LTS (`nvm install 24`, `fnm install 24`, `volta install node@24`, or nodejs.org). |
| Node built against a system SQLite without FTS5 (some Linux distro packages) | The launcher stops with "This Node.js build can't run Meadow's database". | Use the official Node build (nodejs.org, nvm, fnm, volta) instead of the distro package. |
| `startup.sh` on a machine without a usable Node | It runs the same version and FTS5 check, then offers Node 24 through fnm, nvm, Volta or Homebrew. With none of those, it installs nvm per user (no sudo). `startup.ps1` uses winget, fnm or Chocolatey. | Answer yes, or install Node 24 yourself and run the script again. After a fresh install, a new terminal may be needed for PATH. |
| `startup.sh` while Meadow is already running | The running daemon keeps its old settings, and two processes would poll the same Telegram bot. The script offers to restart it. If you decline, setup doesn't start its own Telegram listener; the running daemon receives the pairing message instead. | Accept the restart, or restart Meadow later to apply new keys. |
| Meadow's own folder picked as a project (for example after running `startup.sh` from the Meadow checkout) | The coding engine has write access to the whole project, so it would rewrite Meadow itself and merge into Meadow's main branch. Setup no longer suggests the folder Meadow runs from, repository search skips Meadow checkouts, and registering or starting a run on a folder that is, contains or sits inside Meadow is refused. | Pick or create a separate folder for the project (for example `~/code/my-app`). |
| No screenshots of the finished app | Meadow needs a Chromium-based browser: Playwright's, or Chrome, Edge, Chromium or Brave in their usual places. Headless Linux servers often have none. CLIs and libraries have no page to open, so the run completes without screenshots. | Install Chrome, Edge or Chromium, or set `MEADOW_BROWSER` to the browser's full path. `meadow doctor` shows which browser is used. |
| The finished app doesn't start for screenshots | Apps that need a database, API keys or other services may exit or never answer. Meadow waits up to 3 minutes (installing dependencies first when `node_modules` is missing), reports the last lines of the app's output in the event log, and still marks the run completed. | Add a `preview` block to the plan with the exact command and URL, or make the dev script work without external services. Then tap **Screenshot again**. |
| The app works for the engine but shows errors for you (for example "unexpected response" from its API) | Usually a port problem: the API listens on one port while the dev proxy points at another, or another program (Docker, an old server) already owns the port. Meadow now runs the app exactly as you would, without setting `PORT`, and its end-to-end tests fail on API calls answered by an HTML page, so the engine has to fix it. | Nothing to do; the run stays in the end-to-end phase until the app works. If it gets stuck, **Retry with hint** and name the program holding the port. |
| End-to-end phase says `meadow.e2e.json` is missing or invalid | The engine hasn't written the test file yet, or wrote steps Meadow doesn't know. The exact problem and the file format go back to the engine as the failing check. | Nothing to do; the next fix attempt writes it. |
| The engine deletes test cases instead of fixing the app | Meadow compares the case count with the last commit and fails the phase when it drops. | Nothing to do. |
| End-to-end tests add data to the app's database | The tests use the running app like a person would, so expenses, users and so on they create stay in the app's dev database. Test cases are told never to assume an empty database. | Delete the dev database (for example `expenses.db`) if you want a clean start. |
| Telegram cards arrive out of order | Cards and their photos are sent one at a time, so each test case's screenshots follow its card. | Nothing to do. |
| Desktop Chrome keeps running after a headless screenshot (macOS) | Its updater and helper processes hold it open. Meadow watches for the screenshot file, then kills the whole browser process group and removes the temporary profile. | Nothing to do. |
| No editor or terminal window appears when a run starts | Meadow looks for Cursor (for the Cursor CLI), then VS Code and Windsurf, as apps or as `cursor`/`code`/`windsurf` commands, and opens Terminal (macOS), PowerShell (Windows) or the first terminal it finds on Linux. Headless servers have none. Windows also stay closed under `MEADOW_NO_WINDOWS`, CI and tests. | Click **Watch** on the Live console, or follow `~/.meadow/logs/live/<project>.log` yourself. The dashboard and Telegram show the same progress. |
| `startup.sh` without a terminal (CI, piped) | Nobody can answer, so setup takes safe defaults: it saves keys from the environment and `--env-file`, uses detected local model servers, and tests a `TELEGRAM_BOT_TOKEN` if one is set. It never installs software, downloads models, copies the GitHub CLI login or opens a sign-in. | Pass `--yes` to accept those too, or run it once in a terminal. Exit code 2 means the coding engine still needs connecting. |
| Telegram bot token pasted wrong | Setup checks its shape, then asks Telegram (`getMe`) before saving it. It allows three tries. | Copy the whole token from @BotFather, including the digits before the colon. |
| Pairing link opened on a different device | The link (`t.me/<bot>?start=<code>`) works from any device signed in to your Telegram account, for 15 minutes. | If it expired, run `meadow pair` and send the new code to your bot. |
| Meadow isn't on the npm registry yet | `npm install -g meadow` installs someone else's package or fails. | Install from a release tarball (`npm install -g ./meadow-1.0.0.tgz`) or from source (`pnpm install && pnpm build && pnpm link --global`). |
| `npm install -g` fails with EACCES (Linux/macOS system Node) | Permission error writing to `/usr/lib/node_modules`. | Use a version manager, or `npm config set prefix ~/.npm-global` and add its `bin` to PATH. Don't use `sudo`. |
| Corporate network blocks the npm registry or GitHub | Install hangs or fails. | Configure the npm registry mirror your company uses (`npm config set registry …`). |
| Port 7777 is in use | Meadow tries the next nine ports and prints the one it used. With `--port N` or `MEADOW_PORT` set, it stops with "Port N is in use". | Pick a free port with `--port`. |
| Port below 1024 | "needs elevated permissions". | Use a port above 1024. |
| Meadow is already running for this data folder | The second `meadow start` refuses, naming the PID and URL of the first. | Stop the first one, or set a different `MEADOW_HOME` for a separate instance. |
| Meadow crashed and left `daemon.json` behind | Ignored automatically when the PID is dead. In the rare case the OS reused that PID for another process, start refuses. | Delete `~/.meadow/daemon.json`. |
| Apple Silicon Mac running the Intel build of Node | Works under Rosetta, but slower; `doctor` warns. | Install the arm64 Node build (version managers do this automatically). |
| Windows SmartScreen or antivirus | Can quarantine engine CLIs or slow file scans enough to trip run timeouts. | Allow the engine binaries; exclude your repo folder and `%USERPROFILE%\.meadow` from real-time scanning if runs time out. |

## Platform specifics

| Situation | What happens | Fix |
| --- | --- | --- |
| Windows, native | Supported. Engine shims (`codex.cmd`, `gemini.cmd`) are launched safely through cross-spawn, stopping a run kills the whole process tree with `taskkill /T /F`, and check commands run in `cmd.exe`. | Plan `cmd:` checks must be valid `cmd.exe` commands. Generated checks use `node -e` so they work everywhere; hand-written `test -f`, `grep` or `&&`-heavy POSIX lines won't. |
| Windows, custom engine | The command runs in `cmd.exe`, so variables are `%MEADOW_PROMPT_FILE%`, not `$MEADOW_PROMPT_FILE`. | Write the command for the shell on that machine; `doctor` shows the right syntax. |
| Windows paths | `C:\code\app`, `\\server\share\app`, quoted paths and `~\code\app` are accepted in Setup and `meadow init`. | — |
| WSL | Supported as Linux. Repos under `/mnt/c/...` are slow for git and file watching; `doctor` warns. The dashboard opens from Windows at the printed `127.0.0.1` URL. | Keep repos in the Linux filesystem (`~/code`). Install engines inside WSL, not on the Windows side. |
| Paths with spaces, quotes, `$`, `%` or non-ASCII characters | Handled: Meadow passes arguments without a shell, and generated checks carry paths base64-encoded. | — |
| Line endings | Plans and checks are read with either LF or CRLF. Mixed line endings can make engine diffs noisy. | Set `core.autocrlf` consistently (the repo ships a `.gitattributes`). |
| `SIGTERM` on Windows | Windows has no SIGTERM; Ctrl+C still shuts Meadow down cleanly. Killing the process from Task Manager skips cleanup, so the next start resumes interrupted runs. | Use Ctrl+C. |

## Data folder and database

| Situation | What happens | Fix |
| --- | --- | --- |
| Home directory not writable (locked-down machines, some containers) | `doctor` reports "Data folder … is not writable". | Set `MEADOW_HOME` to a writable local folder. |
| `MEADOW_HOME` on a network drive (SMB/NFS, synced folders like Dropbox or OneDrive) | SQLite WAL mode needs shared memory, which network filesystems don't provide reliably: "database is locked" errors or corruption. | Keep `MEADOW_HOME` on a local disk. Back up with `meadow export-run`, or by copying the backups folder. |
| Disk full | SQLite writes and backups fail; `doctor` warns below 1 GB free. A failed migration restores the pre-migration backup. | Free space, then restart. |
| Read-only repository (mounted image, CI cache) | Indexing works; runs fail when the engine or git tries to write. | Clone to a writable folder. |
| Downgrading Meadow after a newer version migrated the database | The older version refuses to open the newer schema ("written by a newer Meadow") instead of writing to it. | Reinstall the newer version, or restore a backup from `~/.meadow/backups`. |
| Two machines sharing one `MEADOW_HOME` | Not supported (see network drives). | One data folder per machine. |

## Repositories

| Situation | What happens | Fix |
| --- | --- | --- |
| Monorepo (services/*, apps/*, packages/*) | Languages, frameworks and databases are detected one and two levels deep. Root commands win; for kinds the root lacks, up to 10 package commands are added as `cd "pkg" && …`. A package's test command never stands in for the whole project's test suite in plan phases. | Add root scripts that run each package's tests (`pnpm -r test`, a Makefile target) if you want one gate. |
| Repository typed by name isn't found | The search covers the launch folder, the projects folder and the usual code folders for the OS, two to three levels deep, within 8,000 folders or 2.5 seconds. Repos on other drives, deep inside unusual folders, or in skipped folders (`Downloads`, `Library`, `AppData`, `node_modules`) aren't found. | Type the full path once, or set `MEADOW_PROJECTS_DIR` to the folder that holds your code. |
| Several repositories with the same name | All matches are listed, exact names first, then already-added projects, then most recently changed. | Pick the right one; the path is shown on each row. |
| Clone fails | Private repo without access, no network or proxy, or a host that wants a password: git never prompts (`GIT_TERMINAL_PROMPT=0`), so it fails fast with the reason, and the half-cloned folder is removed. | `gh auth login` for GitHub, set up SSH keys or a credential helper, or clone yourself and type the path. Proxies come from `HTTPS_PROXY`. |
| New repositories go to an unexpected folder | Placement order: `MEADOW_PROJECTS_DIR`, a projects folder set in Settings, the folder holding most of your repos, then `~/Developer` (macOS), `~/code` (Linux) or `~/source/repos` (Windows). The chosen folder and the reason are shown before you click. | Set `MEADOW_PROJECTS_DIR`. |
| Dependency install fails | Each step's output is kept; the row shows the last line and the full output on hover. Typical causes: private registries without credentials, native modules without build tools, a Python version the requirements don't support. | Fix the cause and click **Install again**; registry settings (`npm_config_registry`, `PIP_INDEX_URL`, `GOPROXY`, CA bundles) are passed through. |
| A language's tool isn't installed (no Go, no Python, no pnpm) | Its install step is skipped with where to get it; its checks are shown as "tool not installed" and never become plan tasks. | Install the tool and run checks again. |
| Very large repository (hundreds of thousands of files) | Indexing and graph rebuilds take minutes; the live graph debounces and skips while a run is active. | Make sure `node_modules`, build output and vendored code are in `.gitignore`. Point Meadow at the sub-project you actually work on. |
| Not a git repository | Meadow runs `git init` and makes an initial commit when the project is registered; phases need git for branches and rollback. | — |
| git older than 2.28 (old enterprise Linux) | `git init -b` isn't supported; Meadow falls back to `git init` plus `symbolic-ref`. Other commands work with git 2.x. | Upgrade git if a command fails. |
| git not installed | `doctor` fails the git check with a platform-specific install hint. | Install git (Xcode tools, Git for Windows, or your package manager). |
| git worktree or submodule (`.git` is a file) | Detected; branch and remote are read from the linked git directory. | — |
| Dirty working tree before a run | Meadow refuses to start a phase on top of uncommitted changes. | Commit or stash first. |
| No test command and no tests | The first plan adds "Add a test suite" with a check that fails until test files exist. | — |
| Checks that need services (a database, Docker) | They fail in the baseline and are not enforced until they pass. | Start the services, then re-run the baseline from Setup. |

## Engines and models

| Situation | What happens | Fix |
| --- | --- | --- |
| No coding engine installed | Setup → Coding engine shows each engine as "Not installed" with the vendor's install command, and notes desktop apps it found (Cursor, VS Code, Windsurf, Zed, Claude, Codex). Install runs only on a click. Codex and Gemini install through npm, so they need Node's npm. | Click Install, or install it yourself and click Scan again. If the install worked but the command isn't found, restart Meadow from a new terminal. |
| Engine installed but not signed in | Setup shows "Not signed in". Connect runs the engine's own sign-in (`agent login`, `codex login`), opens your browser, shows the sign-in link in case no browser opens (SSH, WSL, headless), and marks the engine ready once its status says signed in. Sign-in gives up after 5 minutes. Approve and start, Resume and Retry refuse to start until the engine is ready, so no attempts or branches are wasted. If the login lapses mid-run, the phase blocks on the first attempt with the same instructions. | Click Connect and finish in the browser, or paste the engine's API key. Gemini CLI only signs in from its own terminal UI: run `gemini` once, or use a key. A saved Cursor key is checked on the first run, because `agent status` can't verify keys. |
| Engine installed in a folder that isn't on PATH for GUI-launched Meadow | Meadow also looks in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, npm-global, pnpm, Bun and Volta folders (`%LOCALAPPDATA%`/`%APPDATA%\npm` on Windows). | For other locations, set `MEADOW_CURSOR_BIN`, `MEADOW_CODEX_BIN` or `MEADOW_GEMINI_BIN` to the full path. |
| Engine CLI changed its flags | Meadow detects flags from `--help`; a large CLI change can still need an adapter update. | `doctor` shows what was detected; pin the engine version until Meadow is updated. |
| Ollama or LM Studio picks a model you don't want | The pick is the strongest known instruction-tuned family that fits in ~60% of RAM; unknown fine-tunes rank lower, and 128k-context variants slightly lower (they need more memory). The reason is shown next to the choice. | Choose another model in the list and click **Use and test**. |
| Only embedding, vision or image models installed | Setup says no chat model is installed and suggests one to pull. | `ollama pull qwen2.5:7b` (or larger if RAM allows). |
| Local model server not running (Ollama, LM Studio, FreeLLMAPI) | `doctor` and Runtime settings show "Not running" for that provider. Features that need the agent model (intake questions, plan improvement, agentic answers) fail with that message; engine runs don't use it and keep working. | Start the server, or pick another provider in Runtime settings. |
| Wrong or expired API key | Saving a key re-probes the provider at once, so a rejected key shows "rejected the saved key" in Setup; the health check fails with "Credentials". Repair can't fix it. | Click **Replace** in Setup, or update Runtime settings or `~/.meadow/secrets.env`. |
| Rate limits or quota | Meadow pauses that provider (10 minutes for quota) and resumes. | Wait, or switch providers. |
| Small local model (~14B and under) driving an agentic CLI | Usually can't finish phases; Meadow blocks them instead of passing them. | Use a stronger model for the engine. |

## Network

| Situation | What happens | Fix |
| --- | --- | --- |
| Corporate proxy | Node ignores `HTTPS_PROXY` by default, so cloud providers and Telegram time out; `doctor` warns. | Set `NODE_USE_ENV_PROXY=1` and add `127.0.0.1,localhost` to `NO_PROXY`. |
| TLS inspection proxy with a private CA | "unable to get local issuer certificate". | Set `NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem`. |
| Offline | Local models, the dashboard, indexing and local embeddings keep working. Cloud providers, Telegram and update checks fail and say so. | — |
| Dashboard from another machine, or Meadow inside Docker | Refused by design: Meadow binds to 127.0.0.1 and rejects non-localhost Host headers. | Use an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 host`) and open the URL locally. |

## Telegram

| Situation | What happens | Fix |
| --- | --- | --- |
| One-click connect, but no relay is configured in this build | "Connect Telegram" explains that the hosted relay isn't set up. | Host the relay (`node dist/relay.js`, see README) and set `MEADOW_RELAY_URL`, or use your own bot token. |
| Relay unreachable | Telegram messages can't be delivered while it's down. Runs continue, and their progress and approvals stay in the dashboard. | Check the relay URL and your network. |
| Telegram blocked in your country or network | Neither the relay nor your own bot can reach Telegram. | Use the dashboard; Telegram is optional. |
| Own bot token used by another program too | Telegram returns 409 Conflict for polling. | Use one bot per Meadow install. |

## Approvals and time

| Situation | What happens | Fix |
| --- | --- | --- |
| System clock wrong by more than the approval window | Approvals can expire immediately or live too long. Expired approvals always mean "deny". | Turn on automatic time sync. |
| Laptop asleep during a run | The engine is suspended with the machine. Timeouts count wall-clock time, so a long sleep can end the attempt as timed out, which counts as a failed attempt. | Retry the phase; avoid sleeping during long runs. |
| Approval requested while you're away | It expires and counts as denied; nothing runs without you. | Approve from the dashboard or Telegram when back. |

## External MCP servers

| Situation | What happens | Fix |
| --- | --- | --- |
| Server needs secrets | Only secret names Meadow manages are passed, never literal values from config files. | Add the secret in Runtime settings; then import the server. |
| Server launched through `npx` on Windows | Started through cross-spawn so `.cmd` shims work. First launch downloads the package and can time out on slow networks. | Install the server globally, then point the config at it. |
| Server marks a destructive tool as read-only | Meadow trusts the tool name over the hint: destructive-sounding tools are gated, and refused over MCP. | — |

## Optional extras

| Situation | What happens | Fix |
| --- | --- | --- |
| Playwright not installed | Web phases pass on their checks without screenshots. | `pnpm add playwright && pnpm exec playwright install chromium`. On Linux CI add `--with-deps`. |
| `piper` or `ffmpeg` missing | Spoken replies are off. | Install them and set `MEADOW_PIPER_MODEL`. |
| `whisper.cpp` missing and the provider can't transcribe | Voice notes get "I couldn't transcribe that voice note" with the reason. | Install whisper.cpp + ffmpeg and set `MEADOW_WHISPER_MODEL`, or pick a provider with transcription. |
| Signed updates not configured | Update checks say "not configured". | Upgrade with your package manager. |
