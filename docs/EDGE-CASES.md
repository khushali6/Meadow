# Where Meadow can fail, and what to do

Meadow runs on macOS, Linux and Windows (native or WSL). This page lists the situations that still break a first setup or a run, how Meadow reacts, and the fix. Run `meadow doctor` first: most of these show up there with a fix line.

## Installing and starting

| Situation | What happens | Fix |
| --- | --- | --- |
| Node older than 22.16, or Node 23 | The launcher stops with "Meadow needs Node.js 22.16+ or 24+" before loading anything. | Install the current LTS (`nvm install 24`, `fnm install 24`, `volta install node@24`, or nodejs.org). |
| Node built against a system SQLite without FTS5 (some Linux distro packages) | The launcher stops with "This Node.js build can't run Meadow's database". | Use the official Node build (nodejs.org, nvm, fnm, volta) instead of the distro package. |
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
| Monorepo (services/*, apps/*, packages/*) | Languages, frameworks and databases are detected one and two levels deep. Verify commands come only from the root, because checks run from the project root. | Add root scripts that run each package's tests (`pnpm -r test`, a Makefile target), or add per-phase `cmd:` checks with `cd`. |
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
| No coding engine installed | `doctor` lists each engine with its install command; the fake engine still works for trying the flow. | Install one: `cursor-agent`, `codex`, `gemini`, or configure the custom engine. |
| Engine installed but not logged in | `doctor` shows "Not logged in" with the login command. Runs fail fast with the engine's own message. | Run the engine's login command once in a terminal. |
| Engine installed in a version manager path that isn't on PATH for GUI-launched shells | `which` can't find it, even though it works in your terminal. | Start Meadow from the same terminal, or add the path to your shell profile. |
| Engine CLI changed its flags | Meadow detects flags from `--help`; a large CLI change can still need an adapter update. | `doctor` shows what was detected; pin the engine version until Meadow is updated. |
| Local model server not running (Ollama, LM Studio, FreeLLMAPI) | `doctor` and Runtime settings show "Not running" for that provider. Features that need the agent model (intake questions, plan improvement, agentic answers) fail with that message; engine runs don't use it and keep working. | Start the server, or pick another provider in Runtime settings. |
| Wrong or expired API key | Provider health check fails with "Credentials"; repair can't fix it. | Update the key in Runtime settings or `~/.meadow/secrets.env`. |
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
