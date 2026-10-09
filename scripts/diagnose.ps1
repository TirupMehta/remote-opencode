#Requires -Version 5.1
<# Prints diagnostics for OpenCode Remote: versions, paths, ports, Tailscale. #>
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $root

Write-Host '=== OpenCode Remote diagnostics ===' -ForegroundColor Cyan
Write-Host "node:      $(try { & node --version } catch { 'MISSING' })"
Write-Host "npm:       $(try { & npm --version } catch { 'MISSING' })"
Write-Host "opencode:  $(try { & opencode --version } catch { 'MISSING' })"
Write-Host "root:      $root"
Write-Host "vendor:    $(if ((Test-Path 'web\vendor\xterm.mjs') -or (Test-Path 'web\vendor\xterm.js')) { 'present' } else { 'MISSING — run scripts\start.ps1' })"
Write-Host "node_modules: $(if (Test-Path 'node_modules') { 'present' } else { 'missing' })"

$port = if ($env:OCR_PORT) { $env:OCR_PORT } else { '8787' }
$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue
Write-Host "port ${port}:  $(if ($tcp.TcpTestSucceeded) { 'LISTENING' } else { 'closed (app not running?)' })"

$ts = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (Test-Path -LiteralPath $ts) {
  Write-Host "tailscale: installed"
  Write-Host (& $ts ip -4 2>&1 | Out-String)
} else {
  Write-Host 'tailscale: NOT installed (phone access needs it or same Wi-Fi). See README.'
}

Write-Host ''
Write-Host 'Data dir contents:'
$dataDir = if ($env:OCR_DATA_DIR) { $env:OCR_DATA_DIR } else { Join-Path $env:APPDATA 'opencode-remote' }
Get-ChildItem -LiteralPath $dataDir -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table | Out-String | Write-Host
Write-Host "OpenCode data: $env:USERPROFILE\.local\share\opencode\opencode.db"
