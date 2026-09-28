$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\tools\shared-transport-probe\native-handoff.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw
# Execute the real preflight, with OS boundaries replaced by deterministic fixtures.
$begin = $source.IndexOf('$url = "ws://127.0.0.1:$Port"')
$end = $source.IndexOf('$desktopRoot = Get-DesktopRoot | Select-Object -First 1')
$preflight = [scriptblock]::Create($source.Substring($begin, $end - $begin))
function Get-Content { param($LiteralPath, [switch]$Raw) $script:savedState | ConvertTo-Json }
function Test-Path { param($LiteralPath) $true }
function Get-CimInstance { param($ClassName, $Filter) $script:runningServer }
function Get-NetTCPConnection { param($LocalAddress, $LocalPort, $State, $ErrorAction) if ($LocalPort -eq 45678) { $script:listener } }
function Get-FreeLoopbackPort { 49152 }
function Get-DesktopRoot { $null }
function Invoke-WebRequest { param($Uri, $TimeoutSec, [switch]$UseBasicParsing) @{ StatusCode = 200 } }
function Stop-Process { param($Id, $ErrorAction) throw 'Preflight must not terminate any process.' }

foreach ($action in @('Restart', 'Launch')) {
  & {
    $Restart = $action -eq 'Restart'; $Launch = $action -eq 'Launch'; $Status = $false
    $Port = 45678; $statePath = 'fixture.json'
    $package = @{ Version = '26.924.2738.0' }; $cli = @{ FullName = 'C:\new\codex.exe' }
    $script:savedState = @{ url = 'ws://127.0.0.1:45678'; cliPath = 'C:\old\codex.exe'; packageVersion = '26.917.9434.0'; serverPid = 123 }
    $script:runningServer = $null; $script:listener = $null
    . $preflight
    if ($managedServer -or $state -or $url -ne 'ws://127.0.0.1:45678') { throw 'Dead outdated state must allow a fresh launch.' }
    Write-Output "PASS: $action recovers outdated state after the old server has exited"
  }
}

& {
  $Restart = $true; $Launch = $false; $Status = $false
  $Port = 45678; $statePath = 'fixture.json'
  $package = @{ Version = 'new' }; $cli = @{ FullName = 'C:\new\codex.exe' }
  $script:savedState = @{ url = 'ws://127.0.0.1:45678'; cliPath = 'C:\old\codex.exe'; packageVersion = 'old'; serverPid = 123 }
  $script:runningServer = [pscustomobject]@{ ProcessId = 123; ExecutablePath = 'C:\old\codex.exe'; CommandLine = 'codex app-server --listen ws://127.0.0.1:45678'; CreationDate = 'original' }
  $script:listener = @{ OwningProcess = 123 }
  . $preflight
  if (!$retiredServer -or $managedServer -or $state -or $Port -ne 49152) { throw 'A verified outdated server must be retired after Desktop closes, on a fresh port.' }
  Write-Output 'PASS: old running server is retained during preflight and scheduled for retirement'

  $script:runningServer = [pscustomobject]@{ ProcessId = 123; ExecutablePath = 'C:\unrelated.exe'; CommandLine = 'unrelated'; CreationDate = 'replacement' }
  $Port = 45678
  $failure = $null
  try { . $preflight } catch { $failure = $_.Exception.Message }
  if ($failure -notmatch 'Saved PID belongs to another process') { throw 'PID reuse must fail without termination.' }
  Write-Output 'PASS: unrelated process using saved PID is protected'

  $script:runningServer = $null; $Port = 45678
  . $preflight
  if ($retiredServer -or $Port -ne 49152) { throw 'Unknown port owner must be left untouched and bypassed.' }
  Write-Output 'PASS: stale state plus unknown listener selects a free port'

  $Status = $true; $Restart = $false; $Port = 45678
  $failure = $null
  try { . $preflight } catch { $failure = $_.Exception.Message }
  if ($failure -notmatch 'outdated Codex version') { throw 'Status must report stale state without changing it.' }
  Write-Output 'PASS: Status remains read-only for outdated state'

  $script:savedState = @{ url = 'ws://127.0.0.1:49152'; cliPath = 'C:\new\codex.exe'; packageVersion = 'new'; serverPid = 123 }
  $script:runningServer = [pscustomobject]@{ ProcessId = 123; ExecutablePath = 'C:\new\codex.exe'; CommandLine = 'codex app-server --listen ws://127.0.0.1:49152'; CreationDate = 'current' }
  function Get-NetTCPConnection { param($LocalAddress, $LocalPort, $State, $ErrorAction) if ($LocalPort -eq 49152) { @{ OwningProcess = 123 } } }
  . $preflight
  if (!$managedServer -or $retiredServer -or $Port -ne 49152) { throw 'Status must inspect the saved fallback port and reuse current server.' }
  Write-Output 'PASS: current matching server on fallback port is reused'
}

$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$helper = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-RetiredSharedServer' }, $true)
Invoke-Expression $helper.Extent.Text
& {
  $snapshot = [pscustomobject]@{ ProcessId = 123; ExecutablePath = 'C:\old\codex.exe'; CommandLine = 'old app-server'; CreationDate = 'original' }
  $script:runningServer = $snapshot
  $script:stopped = @()
  function Stop-Process { param($Id, $ErrorAction) $script:stopped += $Id; $script:runningServer = $null }
  Stop-RetiredSharedServer $snapshot
  if ($script:stopped.Count -ne 1 -or $script:stopped[0] -ne 123) { throw 'Verified old server was not retired.' }
  $script:runningServer = [pscustomobject]@{ ProcessId = 123; ExecutablePath = $snapshot.ExecutablePath; CommandLine = $snapshot.CommandLine; CreationDate = 'replacement' }
  $failure = $null
  try { Stop-RetiredSharedServer $snapshot } catch { $failure = $_.Exception.Message }
  if ($failure -notmatch 'identity changed' -or $script:stopped.Count -ne 1) { throw 'Retirement must protect a replaced process.' }
  Write-Output 'PASS: retirement rechecks process creation time before stopping'
}

# Exercise the retirement helper against an isolated, harmless Windows child.
& {
  function Get-CimInstance { param($ClassName, $Filter) CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter }
  function Stop-Process { param($Id, $ErrorAction) Microsoft.PowerShell.Management\Stop-Process -Id $Id -ErrorAction Stop }
  $child = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
  $snapshot = $null
  try {
    $snapshot = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
    if (!$snapshot) { throw 'Isolated child did not start.' }
    Stop-RetiredSharedServer $snapshot
    if (!$child.WaitForExit(5000)) { throw 'Isolated old server was not stopped.' }
    Write-Output 'PASS: isolated Windows process retirement completes'
  } finally {
    if ($snapshot) {
      $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
      if ($remaining -and $remaining.CreationDate -eq $snapshot.CreationDate -and $remaining.ExecutablePath -eq $snapshot.ExecutablePath) {
        Stop-Process -Id $child.Id
      }
    }
    $child.Dispose()
  }
}
