$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '..\tools\shared-transport-probe\native-handoff.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $scriptPath).Path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Handoff script failed to parse.' }
foreach ($functionName in @('New-DesktopStartInfo', 'Start-PackagedDesktop')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
  if (!$definition) { throw "Missing $functionName" }
  Invoke-Expression $definition.Extent.Text
}
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package) { throw 'This integration test requires installed Codex; it does not start Desktop.' }
$resultPath = [IO.Path]::GetTempFileName()
try {
  # A harmless hidden PowerShell child replaces Desktop but follows the same launch path.
  $probe = @'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class PackageProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetCurrentPackageFullName(ref uint size, StringBuilder name);
}
"@
[uint32]$size=1024
$name=New-Object Text.StringBuilder 1024
$code=[PackageProbe]::GetCurrentPackageFullName([ref]$size,$name)
@{ code=$code; package=$name.ToString(); url=$env:CODEX_APP_SERVER_WS_URL; force=$env:CODEX_APP_SERVER_FORCE_CLI; writes=$env:BATONA_SHARED_CODEX_WRITES } | ConvertTo-Json | Set-Content -LiteralPath '__RESULT__' -Encoding utf8
'@
  $probe = $probe.Replace('__RESULT__', $resultPath.Replace("'", "''"))
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
  $startInfo = New-DesktopStartInfo -Executable "$PSHOME\powershell.exe" -SharedUrl 'ws://127.0.0.1:49152'
  $startInfo.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
  $processId = Start-PackagedDesktop $startInfo $package.PackageFamilyName $package.PackageFullName
  if ($processId -le 0) { throw 'No child process ID.' }
  $result = $null
  for ($i=0; $i -lt 60; $i++) {
    try { $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json } catch { $result = $null }
    if ($result) { break }
    Start-Sleep -Milliseconds 250
  }
  if (!$result -or $result.code -ne 0 -or $result.package -ne $package.PackageFullName) { throw 'Child lacks the installed Codex package identity.' }
  if ($result.url -ne 'ws://127.0.0.1:49152' -or $result.force -ne '0' -or $result.writes) { throw 'Shared child environment was lost or leaked.' }
  if ($startInfo.UseShellExecute) { throw 'Environment requires direct child process creation inside the package.' }
  Write-Output 'PASS: real Windows package identity and shared environment reach the isolated child'
} finally {
  Remove-Item -LiteralPath $resultPath -ErrorAction SilentlyContinue
}
