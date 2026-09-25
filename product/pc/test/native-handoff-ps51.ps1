$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot '..\tools\shared-transport-probe\native-handoff.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath $scriptPath).Path, [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw 'The handoff script does not parse under Windows PowerShell 5.1.' }
$definition = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'New-DesktopStartInfo'
}, $true)
if (!$definition) { throw 'The Desktop launch helper is missing.' }
Invoke-Expression $definition.Extent.Text

$env:BATONA_SHARED_CODEX_WRITES = '1'
$startInfo = New-DesktopStartInfo -Executable $env:ComSpec -SharedUrl 'ws://127.0.0.1:45678'
if (!$startInfo.RedirectStandardOutput -or !$startInfo.RedirectStandardError) {
  throw 'The Desktop launch would leak diagnostics into the handoff output.'
}
if ($startInfo.EnvironmentVariables.ContainsKey('BATONA_SHARED_CODEX_WRITES')) {
  throw 'The Desktop launch would inherit the shared-write opt-in.'
}
$startInfo.Arguments = '/c echo %CODEX_APP_SERVER_WS_URL%,%CODEX_APP_SERVER_FORCE_CLI%,%BATONA_SHARED_CODEX_WRITES%'
$startInfo.RedirectStandardOutput = $true
$startInfo.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($startInfo)
if (!$child) { throw 'The environment probe process did not start.' }
try {
  $output = $child.StandardOutput.ReadToEnd().Trim()
  $child.WaitForExit()
  if ($child.ExitCode -ne 0 -or $output -ne 'ws://127.0.0.1:45678,0,%BATONA_SHARED_CODEX_WRITES%') {
    throw 'The Desktop child environment did not match the expected isolated values.'
  }
} finally {
  $child.Dispose()
}
Write-Output 'PASS: Windows PowerShell 5.1 child environment isolation'
