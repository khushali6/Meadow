# One command from a fresh checkout to a running Meadow on Windows (PowerShell 5.1+ or 7+).
#   powershell -ExecutionPolicy Bypass -File .\startup.ps1 [-Yes] [-NoStart] [-EnvFile keys.env] [-SkipModel] [-SkipEngine] [-SkipTelegram]
param(
  [switch]$Yes,
  [switch]$NoStart,
  [string]$EnvFile,
  [switch]$SkipModel,
  [switch]$SkipEngine,
  [switch]$SkipTelegram
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  [x] $text" -ForegroundColor Red; exit 1 }
function AskYes($question) {
  if ($Yes -or -not [Environment]::UserInteractive) { return $true }
  $reply = Read-Host "  $question [Y/n]"
  return -not ($reply -match '^[nN]')
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function NodeOk {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  node -e "const [a,b]=process.versions.node.split('.').map(Number);if(!(a>=24||(a===22&&b>=16)))process.exit(1);import('node:sqlite').then(({DatabaseSync})=>{new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')}).catch(()=>process.exit(1))" 2>$null
  return $LASTEXITCODE -eq 0
}

Write-Host "Meadow startup (Windows, $env:PROCESSOR_ARCHITECTURE)" -ForegroundColor White

if (NodeOk) { Ok "Node.js $(node -v)" } else {
  Warn "Node.js 22.16+ or 24+ is required."
  if (-not (AskYes "Install Node.js 24 LTS now?")) { Fail "Install Node.js 24 from https://nodejs.org, then run startup.ps1 again." }
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
  elseif (Get-Command fnm -ErrorAction SilentlyContinue) { fnm install 24; fnm use 24 }
  elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install nodejs-lts -y }
  else { Fail "No installer found (winget, fnm or choco). Install Node.js 24 from https://nodejs.org." }
  RefreshPath
  if (-not (NodeOk)) { Fail "Node.js still isn't usable. Open a new terminal and run startup.ps1 again." }
  Ok "Node.js $(node -v)"
}

if (Get-Command git -ErrorAction SilentlyContinue) { Ok "$(git --version)" } else {
  Warn "git is missing; Meadow needs it to run plans."
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (AskYes "Install Git now?")) { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements; RefreshPath }
}

if ((Test-Path package.json) -and (Test-Path server)) {
  $pnpmVersion = node -p "(require('./package.json').packageManager || 'pnpm@10').split('@')[1]"
  $pnpm = if (Get-Command pnpm -ErrorAction SilentlyContinue) { @("pnpm") } else { @("npx", "--yes", "pnpm@$pnpmVersion") }
  $modules = "node_modules/.modules.yaml"
  if (-not (Test-Path $modules) -or ((Get-Item pnpm-lock.yaml).LastWriteTime -gt (Get-Item $modules).LastWriteTime)) {
    Write-Host "Installing dependencies"
    & $pnpm[0] $pnpm[1..9] install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail "Dependency install failed." }
  }
  Ok "Dependencies"
  $built = Test-Path dist/meadow.js
  $stale = $built -and (Get-ChildItem server, client -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Item dist/meadow.js).LastWriteTime } | Select-Object -First 1)
  if (-not $built -or $stale) {
    Write-Host "Building Meadow"
    & $pnpm[0] $pnpm[1..9] build | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Build failed." }
  }
  Ok "Build"
  $meadow = @("node", (Join-Path $PSScriptRoot "dist/cli.js"))
} elseif (Get-Command meadow -ErrorAction SilentlyContinue) {
  $meadow = @("meadow")
} else { Fail "Run this from a Meadow checkout, or install Meadow first." }

$homeDir = if ($env:MEADOW_HOME) { $env:MEADOW_HOME } else { Join-Path $env:USERPROFILE ".meadow" }
function RunningPid {
  $lock = Join-Path $homeDir "daemon.json"
  if (-not (Test-Path $lock)) { return $null }
  $id = (Get-Content $lock -Raw | ConvertFrom-Json).pid
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) { return $id } else { return $null }
}
$running = RunningPid
if ($running) {
  Warn "Meadow is already running (pid $running)."
  if (AskYes "Restart it after setup so new settings apply?") { Stop-Process -Id $running -Force; Start-Sleep -Seconds 2; $running = $null }
}

$setupArgs = @("setup")
if ($Yes) { $setupArgs += "--yes" }
if ($EnvFile) { $setupArgs += @("--env-file", (Resolve-Path $EnvFile).Path) }
if ($SkipModel) { $setupArgs += "--skip-model" }
if ($SkipEngine) { $setupArgs += "--skip-engine" }
if ($SkipTelegram) { $setupArgs += "--skip-telegram" }
& $meadow[0] $meadow[1..9] @setupArgs
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) { Fail "Setup stopped (exit $LASTEXITCODE)." }

if ($NoStart) { Ok "Done. Start Meadow with: $($meadow -join ' ') start"; exit 0 }
if ($running) { Ok "Meadow is still running (pid $running)."; exit 0 }

$token = Join-Path $homeDir "session-token"
Remove-Item $token -ErrorAction SilentlyContinue
Start-Job -ArgumentList $homeDir -ScriptBlock {
  param($dir)
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $tokenFile = Join-Path $dir "session-token"; $lock = Join-Path $dir "daemon.json"
    if ((Test-Path $tokenFile) -and (Test-Path $lock)) {
      $url = (Get-Content $lock -Raw | ConvertFrom-Json).url + "?token=" + (Get-Content $tokenFile -Raw).Trim()
      if (-not $env:MEADOW_NO_BROWSER) { Start-Process $url }
      return
    }
  }
} | Out-Null
Write-Host "`nStarting Meadow (Ctrl-C to stop)"
& $meadow[0] $meadow[1..9] start
