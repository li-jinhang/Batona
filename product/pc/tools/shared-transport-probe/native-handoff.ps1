param(
  [switch]$Launch,
  [switch]$Restart,
  [switch]$Status,
  [switch]$Stop,
  [ValidateRange(1024, 65535)][int]$Port = 45678,
  [string]$StateFile
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1 or newer is required.' }
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'PlainText' }
# PowerShell 5.1 launched from Node can miss automatic loading for Get-FileHash.
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$statePath = if ([string]::IsNullOrWhiteSpace($StateFile)) {
  Join-Path $PSScriptRoot '..\..\..\..\output\.shared-transport-probe\native-handoff.json'
} else {
  [System.IO.Path]::GetFullPath($StateFile)
}
if (@(@($Launch, $Restart, $Status, $Stop) | Where-Object { $_ }).Count -gt 1) {
  throw 'Use only one of -Launch, -Restart, -Status, or -Stop.'
}

function Get-DesktopRoot {
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
    Where-Object { $_.ExecutablePath -match '[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$' -and
                   $_.CommandLine -notmatch '--type=' }
}

function Test-DesktopConnection([int]$ProcessId, [int]$Port) {
  @(Get-NetTCPConnection -OwningProcess $ProcessId -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq $Port }).Count -gt 0
}

function Get-FreeLoopbackPort {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $probe.Start()
    return [int]$probe.LocalEndpoint.Port
  } finally {
    $probe.Stop()
  }
}

function New-DesktopStartInfo([string]$Executable, [string]$SharedUrl) {
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = Split-Path -Parent $Executable
  # .NET Framework requires UseShellExecute=false when setting a child-only environment.
  $startInfo.UseShellExecute = $false
  # Do not let the GUI process write into Batona's PowerShell execFile pipes.
  # Chromium diagnostics can otherwise be mistaken for a failed handoff.
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['CODEX_APP_SERVER_WS_URL'] = $SharedUrl
  $startInfo.EnvironmentVariables['CODEX_APP_SERVER_FORCE_CLI'] = '0'
  # Do not inherit Batona's experimental shared-write opt-in into Desktop.
  $startInfo.EnvironmentVariables.Remove('BATONA_SHARED_CODEX_WRITES')
  return $startInfo
}

function Start-PackagedDesktop($StartInfo, [string]$PackageFamilyName, [string]$PackageFullName) {
  # Package activation does not inherit our environment. Use a hidden package-bound
  # bootstrap to inject only the shared connection settings into its Desktop child.
  $resultPath = [System.IO.Path]::GetTempFileName()
  try {
    $payload = @{
      executable = $StartInfo.FileName; arguments = $StartInfo.Arguments
      url = $StartInfo.EnvironmentVariables['CODEX_APP_SERVER_WS_URL']
      package = $PackageFullName; result = $resultPath
    } | ConvertTo-Json -Compress
    $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $bootstrap = @'
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
try {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BatonaPackageIdentity {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
}
"@
  [uint32]$length = 1024
  $name = New-Object Text.StringBuilder 1024
  $code = [BatonaPackageIdentity]::GetCurrentPackageFullName([ref]$length, $name)
  if ($code -ne 0 -or $name.ToString() -ne $data.package) { throw 'Package bootstrap identity verification failed.' }
  __START_INFO_FUNCTION__
  $info = New-DesktopStartInfo -Executable $data.executable -SharedUrl $data.url
  $info.Arguments = $data.arguments
  $info.CreateNoWindow = $true
  $child = [Diagnostics.Process]::Start($info)
  if (!$child) { throw 'Codex Desktop process did not start.' }
  $child.BeginOutputReadLine()
  $child.BeginErrorReadLine()
  $length = 1024
  $name.Clear() | Out-Null
  $code = [BatonaPackageIdentity]::GetPackageFullName($child.Handle, [ref]$length, $name)
  if ($code -ne 0 -or $name.ToString() -ne $data.package) { throw 'Desktop child package identity verification failed.' }
  @{ ok = $true; processId = $child.Id } | ConvertTo-Json -Compress | Set-Content -LiteralPath $data.result -Encoding utf8
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $data.result -Encoding utf8
}
'@
    $definition = 'function New-DesktopStartInfo {' + ${function:New-DesktopStartInfo}.ToString() + '}'
    $bootstrap = $bootstrap.Replace('__PAYLOAD__', $encodedPayload).Replace('__START_INFO_FUNCTION__', $definition)
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
    Invoke-CommandInDesktopPackage -PackageFamilyName $PackageFamilyName -AppId 'App' `
      -Command "$PSHOME\powershell.exe" `
      -Args "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encodedCommand" `
      -PreventBreakaway -ErrorAction Stop | Out-Null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      $result = Get-Content -LiteralPath $resultPath -Raw
      if ($result) {
        # The bootstrap may still be completing its single small JSON write.
        try { $result = $result | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 250; continue }
        if (!$result.ok) { throw $result.error }
        return [int]$result.processId
      }
      Start-Sleep -Milliseconds 250
    }
    throw 'Timed out starting Codex with Windows package identity.'
  } finally {
    Remove-Item -LiteralPath $resultPath -ErrorAction SilentlyContinue
  }
}

function Stop-RetiredSharedServer($Snapshot) {
  if (!$Snapshot) { return }
  # Called only after Desktop has closed. Recheck identity rather than trusting a saved PID.
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Snapshot.ProcessId)"
  if (!$current) { return }
  if ($current.ExecutablePath -ne $Snapshot.ExecutablePath -or
      $current.CreationDate -ne $Snapshot.CreationDate -or
      $current.CommandLine -ne $Snapshot.CommandLine) {
    throw 'Previous shared app-server identity changed; no process was terminated.'
  }
  Stop-Process -Id $current.ProcessId -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($Snapshot.ProcessId)"
    if (!$remaining -or $remaining.CreationDate -ne $Snapshot.CreationDate) { return }
    Start-Sleep -Milliseconds 200
  }
  throw 'Previous shared app-server did not exit; fresh startup was cancelled.'
}

if ($Stop) {
  if (!(Test-Path -LiteralPath $statePath)) { throw 'No shared app-server handoff state found.' }
  if (Get-DesktopRoot) { throw 'Quit Codex Desktop before stopping its shared app-server.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverPid)"
  if ($running) {
    if ($running.ExecutablePath -ne $state.cliPath -or
        !$running.CommandLine.Contains('app-server') -or !$running.CommandLine.Contains($state.url)) {
      Write-Output 'Stored PID no longer identifies the recorded app-server; leaving that process untouched.'
    } else {
      Stop-Process -Id $state.serverPid
    }
  }
  Remove-Item -LiteralPath $statePath
  Write-Output 'Shared app-server handoff stopped.'
  exit 0
}

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
$state = if (Test-Path -LiteralPath $statePath) {
  Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} else { $null }
if (($Restart -or $Status) -and $state -and $state.url -match '^ws://127\.0\.0\.1:(\d+)$') {
  $Port = [int]$Matches[1]
  $url = "ws://127.0.0.1:$Port"
}
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$retiredServer = $null
$managedServer = if ($state) {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($state.serverPid)"
} else { $null }
if ($state -and ($state.url -ne $url -or $state.cliPath -ne $cli.FullName -or
    $state.packageVersion -ne "$($package.Version)")) {
  if (!$Launch -and !$Restart) {
    throw 'Saved shared server uses an outdated Codex version or URL; start or restart the shared connection to refresh it.'
  }
  if ($managedServer) {
    if ($managedServer.ExecutablePath -ne $state.cliPath -or
        !$managedServer.CommandLine -or !$managedServer.CommandLine.Contains('app-server') -or
        !$managedServer.CommandLine.Contains($state.url)) {
      throw 'Saved PID belongs to another process; refusing to stop it.'
    }
    $retiredServer = $managedServer
  }
  # Do not remove the on-disk record or stop the old server during preflight.
  # A confirmed restart closes Desktop first, then retires the verified old server.
  $state = $null
  $managedServer = $null
}
if ($managedServer -and ($managedServer.ExecutablePath -ne $cli.FullName -or
    !$managedServer.CommandLine.Contains('app-server') -or !$managedServer.CommandLine.Contains($url))) {
  throw 'Saved PID belongs to another process; refusing to reuse it.'
}
$portFallback = $false
if ($listener -and (!$managedServer -or $listener.OwningProcess -ne $state.serverPid)) {
  if (!$Launch -and !$Restart) { throw "Port $Port belongs to an unknown listener; no connection was made." }
  $requestedPort = $Port
  $Port = Get-FreeLoopbackPort
  $url = "ws://127.0.0.1:$Port"
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw 'Could not reserve a free loopback port for the shared app-server.' }
  $managedServer = $null
  $state = $null
  $portFallback = $true
}
if ($managedServer -and !$listener) {
  throw 'Saved app-server is running without its expected loopback listener.'
}
if ($managedServer) {
  $ready = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200
  if (!$ready) { throw 'Saved app-server is not ready.' }
}
$desktopRoot = Get-DesktopRoot | Select-Object -First 1
if ($Status -or (!$Launch -and !$Restart)) {
  Write-Output "Preflight OK: $($package.Version); matching CLI; $url."
  Write-Output "Shared server: $(if ($managedServer) { "ready (PID $($state.serverPid))" } else { 'not running' })."
  Write-Output "Desktop: $(if (!$desktopRoot) { 'closed' } elseif ($managedServer -and (Test-DesktopConnection $desktopRoot.ProcessId $Port)) { "connected (PID $($desktopRoot.ProcessId))" } else { "not connected to shared server (PID $($desktopRoot.ProcessId))" })."
  exit 0
}

# Prepare the Desktop launch before closing an existing process on -Restart.
$null = Get-Command Invoke-CommandInDesktopPackage -ErrorAction Stop
$desktopStartInfo = New-DesktopStartInfo -Executable $desktopExe -SharedUrl $url

if ($Restart -and $desktopRoot) {
  $desktopRoots = @(Get-DesktopRoot)
  if ($desktopRoots.Count -ne 1 -or $desktopRoot.ExecutablePath -ne $desktopExe) {
    throw 'Codex Desktop process identity could not be verified for restart.'
  }
  $verifiedDesktop = Get-CimInstance Win32_Process -Filter "ProcessId=$($desktopRoot.ProcessId)"
  if (!$verifiedDesktop -or $verifiedDesktop.ExecutablePath -ne $desktopExe -or
      $verifiedDesktop.CreationDate -ne $desktopRoot.CreationDate) {
    throw 'Codex Desktop process changed before restart; no process was terminated.'
  }
  $desktopProcess = Get-Process -Id $desktopRoot.ProcessId -ErrorAction Stop
  # Request a normal close first. Electron can keep the process alive after its
  # window closes; the confirmed restart may then end only this verified root.
  if ($desktopProcess.MainWindowHandle -ne 0 -and $desktopProcess.CloseMainWindow()) {
    [void]$desktopProcess.WaitForExit(15000)
  }
  $desktopProcess.Refresh()
  if (!$desktopProcess.HasExited) {
    $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId=$($desktopRoot.ProcessId)"
    if (!$stillRunning -or $stillRunning.ExecutablePath -ne $desktopExe -or
        $stillRunning.CreationDate -ne $desktopRoot.CreationDate -or
        $stillRunning.CommandLine -match '--type=') {
      throw 'Codex Desktop process identity changed during restart; no process was terminated.'
    }
    Stop-Process -Id $desktopRoot.ProcessId -Force -ErrorAction Stop
    if (!$desktopProcess.WaitForExit(5000)) {
      throw 'Codex Desktop did not exit after the restart request.'
    }
  }
  $desktopRoot = Get-DesktopRoot | Select-Object -First 1
}
if ($desktopRoot) { throw 'Codex Desktop is still running; shared connection startup was cancelled.' }
Stop-RetiredSharedServer $retiredServer
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
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 1 -UseBasicParsing
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
  $launchedDesktopPid = Start-PackagedDesktop -StartInfo $desktopStartInfo `
    -PackageFamilyName $package.PackageFamilyName -PackageFullName $package.PackageFullName
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
  if ($portFallback) { Write-Output "Port $requestedPort was occupied by an unverified listener; using a free loopback port instead." }
  Write-Output "Desktop launched; shared listener PID $serverPid, $url$(if ($newServer) { ' (new)' } else { ' (reused)' })."
  Write-Output "BATONA_SHARED_WS_URL=$url"
  Write-Output 'Verify Desktop connection and task behavior before enabling Batona writes.'
} catch {
  if ($newServer -and !(Get-DesktopRoot)) {
    Stop-Process -Id $serverPid -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
  }
  throw
}
