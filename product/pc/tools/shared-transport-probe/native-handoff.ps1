param(
  [switch]$Launch,
  [switch]$Status,
  [switch]$Stop,
  [ValidateRange(1024, 65535)][int]$Port = 45678
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '..\..\..\..\output\.shared-transport-probe\native-handoff.json'
if (@(@($Launch, $Status, $Stop) | Where-Object { $_ }).Count -gt 1) {
  throw 'Use only one of -Launch, -Status, or -Stop.'
}

function Get-DesktopRoot {
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.CommandLine -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
}

function Test-DesktopConnection([int]$ProcessId, [int]$Port) {
  @(Get-NetTCPConnection -OwningProcess $ProcessId -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq $Port }).Count -gt 0
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
$state = if (Test-Path -LiteralPath $statePath) {
  Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} else { $null }
if ($state -and ($state.url -ne $url -or $state.cliPath -ne $cli.FullName -or
    $state.packageVersion -ne "$($package.Version)")) {
  throw 'Saved shared server belongs to a different URL or Codex version. Quit Desktop, then use -Stop before a fresh -Launch.'
}
$managedServer = if ($state) {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverPid)"
} else { $null }
if ($managedServer -and ($managedServer.ExecutablePath -ne $cli.FullName -or
    !$managedServer.CommandLine.Contains('app-server') -or !$managedServer.CommandLine.Contains($url))) {
  throw 'Saved PID belongs to another process; refusing to reuse it.'
}
if ($listener -and (!$managedServer -or $listener.OwningProcess -ne $state.serverPid)) {
  throw "Port $Port belongs to an unknown listener; refusing to attach Desktop."
}
if ($managedServer -and !$listener) {
  throw 'Saved app-server is running without its expected loopback listener.'
}
if ($managedServer) {
  $ready = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 2).StatusCode -eq 200
  if (!$ready) { throw 'Saved app-server is not ready.' }
}
$desktopRoot = Get-DesktopRoot | Select-Object -First 1
if ($Status -or !$Launch) {
  Write-Output "Preflight OK: $($package.Version); matching CLI; $url."
  Write-Output "Shared server: $(if ($managedServer) { "ready (PID $($state.serverPid))" } else { 'not running' })."
  Write-Output "Desktop: $(if (!$desktopRoot) { 'closed' } elseif ($managedServer -and (Test-DesktopConnection $desktopRoot.ProcessId $Port)) { "connected (PID $($desktopRoot.ProcessId))" } else { "not connected to shared server (PID $($desktopRoot.ProcessId))" })."
  exit 0
}

if ($desktopRoot) { throw 'Quit Codex Desktop before running -Launch. This script will not terminate it.' }
$newServer = $false
$serverPid = if ($managedServer) { [int]$state.serverPid } else { 0 }
try {
  if (!$managedServer) {
    $server = Start-Process -FilePath $cli.FullName -ArgumentList @(
      '-c', 'features.code_mode_host=true', 'app-server', '--listen', $url, '--analytics-default-enabled'
    ) -WindowStyle Hidden -PassThru
    $newServer = $true
    $serverPid = $server.Id
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if ($server.HasExited) { throw 'Shared app-server exited during startup.' }
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 1
        if ($response.StatusCode -eq 200) { $ready = $true; break }
      } catch { Start-Sleep -Milliseconds 250 }
    }
    if (!$ready) { throw 'Shared app-server did not become ready.' }
  }
  $stateDir = Split-Path -Parent $statePath
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  @{ url = $url; serverPid = $serverPid; cliPath = $cli.FullName;
     desktopPid = 0; packageVersion = "$($package.Version)" } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  $desktop = Start-Process -FilePath $desktopExe -Environment @{
    CODEX_APP_SERVER_WS_URL = $url
    CODEX_APP_SERVER_FORCE_CLI = '0'
  } -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $desktopRoot = Get-DesktopRoot | Select-Object -First 1
    if ($desktopRoot -and (Test-DesktopConnection $desktopRoot.ProcessId $Port)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (!$desktopRoot -or !(Test-DesktopConnection $desktopRoot.ProcessId $Port)) {
    throw 'Codex Desktop did not connect to the shared app-server. Quit Desktop, then inspect -Status or use -Stop.'
  }
  @{ url = $url; serverPid = $serverPid; cliPath = $cli.FullName;
     desktopPid = $desktopRoot.ProcessId; packageVersion = "$($package.Version)" } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  Write-Output "Desktop launched; shared listener PID $serverPid, $url$(if ($newServer) { ' (new)' } else { ' (reused)' })."
  Write-Output 'Verify Desktop connection and task behavior before enabling Batona writes.'
} catch {
  if ($newServer -and !(Get-DesktopRoot)) {
    Stop-Process -Id $serverPid -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
  }
  throw
}
