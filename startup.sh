#!/usr/bin/env bash
# One command from a fresh checkout to a running Meadow: Node, dependencies, build, keys, model,
# coding engine, Telegram, then the dashboard. Safe to run again; finished steps are kept.
#
#   ./startup.sh                      interactive
#   ./startup.sh --yes                accept every default (installs included), no questions
#   ./startup.sh --env-file keys.env  import TELEGRAM_BOT_TOKEN, CURSOR_API_KEY, ... from a file
#   ./startup.sh --no-start           set up, but don't start the dashboard
#   ./startup.sh --skip-telegram      also --skip-model, --skip-engine
#
# Windows: run startup.ps1 in PowerShell, or this script in WSL or Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

YES=0
START=1
SETUP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1; SETUP_ARGS+=("--yes") ;;
    --no-start) START=0 ;;
    --env-file) SETUP_ARGS+=("--env-file" "$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"); shift ;;
    --skip-model|--skip-engine|--skip-telegram) SETUP_ARGS+=("$1") ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ask_yes() {
  # ask_yes "Question" -> 0 for yes. Defaults to yes; with --yes or no terminal, answers yes.
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then return 0; fi
  local reply
  read -r -p "  $1 [Y/n] " reply
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl; else OS=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) OS=unknown ;;
esac
bold "Meadow startup ($OS, $(uname -m))"

# ── Node.js 22.16+ or 24+ with node:sqlite (FTS5) ───────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 && node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    if (!(a >= 24 || (a === 22 && b >= 16))) process.exit(1);
    import("node:sqlite").then(({ DatabaseSync }) => { const d = new DatabaseSync(":memory:"); d.exec("CREATE VIRTUAL TABLE t USING fts5(x)"); }).catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

load_version_managers() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  command -v fnm >/dev/null 2>&1 && eval "$(fnm env 2>/dev/null)" || true
  [ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH" || true
}

install_node() {
  if command -v fnm >/dev/null 2>&1; then fnm install 24 && fnm use 24 && eval "$(fnm env)"
  elif command -v nvm >/dev/null 2>&1; then nvm install 24 && nvm use 24
  elif command -v volta >/dev/null 2>&1; then volta install node@24
  elif [ "$OS" = macos ] && command -v brew >/dev/null 2>&1; then brew install node@24 && brew link --overwrite --force node@24
  else
    # No version manager: install nvm (per-user, no sudo), then Node 24.
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    load_version_managers
    nvm install 24 && nvm use 24
  fi
}

load_version_managers
if node_ok; then
  ok "Node.js $(node -v)"
else
  if command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) can't run Meadow (needs 22.16+ or 24+ with node:sqlite)."; else warn "Node.js is not installed."; fi
  if ask_yes "Install Node.js 24 now?"; then install_node; else fail "Install Node.js 24 from https://nodejs.org, then run ./startup.sh again."; fi
  node_ok || fail "Node.js still isn't usable. Open a new terminal and run ./startup.sh again."
  ok "Node.js $(node -v)"
fi

# ── git ─────────────────────────────────────────────────────────────────────
if command -v git >/dev/null 2>&1; then
  ok "$(git --version)"
else
  case "$OS" in
    macos) warn "git is missing. Install it with: xcode-select --install" ;;
    linux|wsl) warn "git is missing. Install it with your package manager, e.g. sudo apt install git" ;;
    *) warn "git is missing. Install it from https://git-scm.com" ;;
  esac
  warn "Meadow needs git to run plans (each phase is a branch). Setup continues."
fi

# ── Dependencies and build ──────────────────────────────────────────────────
if [ -f package.json ] && [ -d server ]; then
  PNPM_VERSION="$(node -p 'require("./package.json").packageManager?.split("@")[1] ?? "10"')"
  if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm)
  elif command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm)
  else PNPM=(npx --yes "pnpm@$PNPM_VERSION"); fi

  if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    bold "Installing dependencies"
    "${PNPM[@]}" install --frozen-lockfile
  fi
  ok "Dependencies"

  if [ ! -f dist/cli.js ] || [ ! -f dist/meadow.js ] || [ -n "$(find server client package.json -newer dist/meadow.js -type f -print -quit 2>/dev/null)" ]; then
    bold "Building Meadow"
    BUILD_LOG="$(mktemp)"
    "${PNPM[@]}" build >"$BUILD_LOG" 2>&1 || { cat "$BUILD_LOG" >&2; fail "Build failed."; }
    rm -f "$BUILD_LOG"
  fi
  ok "Build"
  MEADOW=(node "$ROOT/dist/cli.js")
elif command -v meadow >/dev/null 2>&1; then
  MEADOW=(meadow)
else
  fail "Run this from a Meadow checkout, or install Meadow first (npm install -g ./meadow-*.tgz)."
fi

# ── A running Meadow keeps old settings in memory ───────────────────────────
HOME_DIR="${MEADOW_HOME:-$HOME/.meadow}"
running_pid() {
  node -e '
    try { const { pid } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.kill(pid, 0); console.log(pid); } catch {}
  ' "$HOME_DIR/daemon.json"
}
PID="$(running_pid)"
if [ -n "$PID" ]; then
  warn "Meadow is already running (pid $PID)."
  if ask_yes "Restart it after setup so new settings apply?"; then
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(running_pid)" ] && break; sleep 0.5; done
    PID=""
  fi
fi

# ── Keys, model, coding engine, Telegram ────────────────────────────────────
echo
set +e
"${MEADOW[@]}" setup ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
STATUS=$?
set -e
[ "$STATUS" = 0 ] || [ "$STATUS" = 2 ] || fail "Setup stopped (exit $STATUS)."

# ── Dashboard ───────────────────────────────────────────────────────────────
[ "$START" = 1 ] || { echo; ok "Done. Start Meadow with: ${MEADOW[*]} start"; exit 0; }
if [ -n "$PID" ]; then
  ok "Meadow is still running (pid $PID): $(node -p 'require(process.argv[1]).url' "$HOME_DIR/daemon.json")?token=$(cat "$HOME_DIR/session-token" 2>/dev/null)"
  exit 0
fi

open_dashboard() {
  # Waits for the daemon to write its URL and session token, then opens the dashboard once.
  for _ in $(seq 1 60); do
    sleep 0.5
    [ -n "$(running_pid)" ] && [ -s "$HOME_DIR/session-token" ] || continue
    local url
    url="$(node -p 'require(process.argv[1]).url' "$HOME_DIR/daemon.json")?token=$(cat "$HOME_DIR/session-token")"
    [ -n "${MEADOW_NO_BROWSER:-}" ] && return
    case "$OS" in
      macos) open "$url" ;;
      wsl) cmd.exe /c start "" "$url" >/dev/null 2>&1 || true ;;
      windows) start "" "$url" ;;
      *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 || true ;;
    esac
    return
  done
}
rm -f "$HOME_DIR/session-token"
echo
bold "Starting Meadow (Ctrl-C to stop)"
open_dashboard &
exec "${MEADOW[@]}" start
