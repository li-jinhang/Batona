param(
  [switch]$Launch,
  [switch]$Stop,
  [ValidateRange(1024, 65535)][int]$Port = 45678
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '..\..\..\..\output\.shared-transport-probe\native-handoff.json'

function Get-DesktopRoot {
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.CommandLine -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
}

if ($Stop) {
  if (!(Test-Path -LiteralPath $statePath)) { throw 'No shared app-server handoff state found.' }
  if (Get-DesktopRoot) { throw 'Quit Codex Desktop before stopping its shared app-server.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverPid)"
  if ($running) {
    if ($running.ExecutablePath -ne $state.cliPath -or
        !$running.CommandLine.Contains('app-server') -or !$running.CommandLine.Contains($state.url)) {
      throw 'Stored PID belongs to another process; no process was stopped.'
    }
    Stop-Process -Id $state.serverPid
  }
  Remove-Item -LiteralPath $statePath
  Write-Output 'Shared app-server handoff stopped.'
  exit 0
}

if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required for Start-Process -Environment.' }
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package) { throw 'Codex Desktop package not found.' }
$desktopExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$bundledCli = Join-Path $package.InstallLocation 'app\resources\codex.exe'
$cliRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$cli = Get-ChildItem -LiteralPath $cliRoot -Filter codex.exe -File -Recurse |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!(Test-Path -LiteralPath $desktopExe) -or !(Test-Path -LiteralPath $bundledCli) -or !$cli) {
  throw 'Desktop executable or Codex CLI is missing.'
}
if ((Get-FileHash -LiteralPath $bundledCli -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $cli.FullName -Algorithm SHA256).Hash) {
  throw 'Codex CLI does not match the installed Desktop package.'
}
$url = "ws://127.0.0.1:$Port"
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port already has a listener." }
Write-Output "Preflight OK: $($package.Version); matching CLI; $url available."
if (!$Launch) { exit 0 }

if (Get-DesktopRoot) { throw 'Quit Codex Desktop before running -Launch. This script will not terminate it.' }
if (Test-Path -LiteralPath $statePath) { throw 'Existing handoff state found; inspect or run -Stop first.' }
$server = Start-Process -FilePath $cli.FullName -ArgumentList @(
  '-c', 'features.code_mode_host=true', 'app-server', '--listen', $url, '--analytics-default-enabled'
) -WindowStyle Hidden -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($server.HasExited) { throw 'Shared app-server exited during startup.' }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 1
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (!$ready) { throw 'Shared app-server did not become ready.' }
  $desktop = Start-Process -FilePath $desktopExe -Environment @{
    CODEX_APP_SERVER_WS_URL = $url
    CODEX_APP_SERVER_FORCE_CLI = '0'
  } -PassThru
  $desktopRoot = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $desktopRoot = Get-DesktopRoot | Select-Object -First 1
    if ($desktopRoot) { break }
    Start-Sleep -Milliseconds 500
  }
  if (!$desktopRoot) { throw 'Codex Desktop did not stay running with the shared URL.' }
  $stateDir = Split-Path -Parent $statePath
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  @{ url = $url; serverPid = $server.Id; cliPath = $cli.FullName;
     desktopPid = $desktopRoot.ProcessId; packageVersion = "$($package.Version)" } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  Write-Output "Desktop launched; shared listener PID $($server.Id), $url."
  Write-Output 'Verify Desktop connection and task behavior before enabling Batona writes.'
} catch {
  if (!$server.HasExited) { Stop-Process -Id $server.Id }
  throw
}
