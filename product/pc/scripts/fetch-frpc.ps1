# fetch-frpc.ps1 — 手动下载 frpc.exe 到 pc\frpc-bin\（可选，主进程也会自动下载）
# 用法:  powershell -ExecutionPolicy Bypass -File scripts/fetch-frpc.ps1
# 镜像:  $env:DSHLINK_FRP_MIRROR="https://mirror.ghproxy.com/https://github.com" 再运行

$ErrorActionPreference = "Stop"
$FRP_VERSION = "0.68.0"
$OutDir = Join-Path $PSScriptRoot "..\frpc-bin"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$mirror = $env:DSHLINK_FRP_MIRROR
if ($mirror) {
  $url = "$($mirror.TrimEnd('/'))/fatedier/frp/releases/download/v$FRP_VERSION/frp_${FRP_VERSION}_windows_amd64.zip"
} else {
  $url = "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_${FRP_VERSION}_windows_amd64.zip"
}

$zip = Join-Path $OutDir "frp.zip"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $OutDir -Force
Copy-Item (Get-ChildItem "$OutDir\frp_*_windows_amd64\frpc.exe" | Select-Object -First 1).FullName (Join-Path $OutDir "frpc.exe") -Force
Remove-Item $zip -Force
Get-ChildItem "$OutDir\frp_*_windows_amd64" | Remove-Item -Recurse -Force
Write-Host "OK: $(Join-Path $OutDir 'frpc.exe')" -ForegroundColor Green
