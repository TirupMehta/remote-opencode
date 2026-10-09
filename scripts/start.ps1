#Requires -Version 5.1
<#
  Starts OpenCode Remote. Double-click or run: powershell -ExecutionPolicy Bypass -File scripts\start.ps1
  Optional: -Port 8787 -Host 127.0.0.1 -DataDir <path>
#>
param(
  [int]$Port = 0,
  [string]$Bind = '',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $root

function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js not found. Install Node.js 22+ from https://nodejs.org/ and re-run.' }
$major = (& node -p "process.versions.node.split('.')[0]")
if ([int]$major -lt 22) { Fail "Node.js 22+ required (found $(& node --version)). Please upgrade." }
Write-Host "Node $(& node --version) OK" -ForegroundColor Green

# 2. OpenCode CLI
$oc = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $oc) { Fail 'opencode CLI not found on PATH. Install it (npm i -g opencode-ai) and re-run.' }
Write-Host "opencode $(& opencode --version) OK" -ForegroundColor Green

# 3. Dependencies (devDeps only: typecheck + terminal assets; runtime has zero deps)
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Write-Host 'Installing local tooling (npm install)…'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Check your network and re-run.' }
}

# 4. Terminal assets
if (-not (Test-Path -LiteralPath (Join-Path $root 'web\vendor\xterm.mjs')) -and -not (Test-Path -LiteralPath (Join-Path $root 'web\vendor\xterm.js'))) {
  Write-Host 'Preparing terminal assets…'
  & node scripts\setup-web.mjs
  if ($LASTEXITCODE -ne 0) { Fail 'Terminal asset setup failed (see above).' }
}

# 5. Env
if ($Port -ne 0) { $env:OCR_PORT = "$Port" }
if ($Bind -ne '') { $env:OCR_HOST = $Bind }
if ($DataDir -ne '') { $env:OCR_DATA_DIR = $DataDir }

Write-Host ''
Write-Host 'Starting OpenCode Remote… (Ctrl+C to stop)' -ForegroundColor Cyan
& node server\src\main.ts
exit $LASTEXITCODE
