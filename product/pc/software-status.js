'use strict';
const { execFile } = require('node:child_process');
const { sharedUrl } = require('./codex-control-mode.js');

// The Codex desktop Store package runs ChatGPT.exe; codex.exe app-server alone
// must never count as the desktop application. Process details never reach IPC.
function classifySoftware(processes) {
  return {
    dshProcess: processes.some(p => /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(p.CommandLine || '') && /(?:\bweb\b|--profile\s+web)/i.test(p.CommandLine || '')),
    codexDesktop: processes.some(p => /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/i.test(p.ExecutablePath || '') || /[\\/]Codex[\\/](?:app[\\/])?(?:Codex|ChatGPT)\.exe$/i.test(p.ExecutablePath || '')),
  };
}

let pending = null;
let sharedConnectionCache = null;
const sharedDesktopPathPattern = String.raw`[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$`;

function clearSharedDesktopConnectionCache() { sharedConnectionCache = null; }

function probeSharedDesktopConnection(websocketUrl) {
  const url = sharedUrl(websocketUrl);
  if (!url || process.platform !== 'win32') return Promise.resolve(false);
  if (sharedConnectionCache?.url === url && Date.now() - sharedConnectionCache.at < 5_000) {
    return sharedConnectionCache.result;
  }
  const port = Number(new URL(url).port);
  const command = [
    `$roots = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -match '${sharedDesktopPathPattern}' -and $_.CommandLine -notmatch '--type=' })`,
    `if ($roots.Count -ne 1) { 'False'; exit }`,
    `$links = @(Get-NetTCPConnection -OwningProcess $roots[0].ProcessId -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq ${port} })`,
    `[bool]($links.Count -gt 0)`,
  ].join('; ');
  const result = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024, encoding: 'utf8' },
      (error, stdout) => resolve(!error && stdout.trim().toLowerCase() === 'true'));
  });
  sharedConnectionCache = { url, at: Date.now(), result };
  return result;
}
function probeSoftware() {
  if (pending) return pending;
  if (process.platform !== 'win32') return Promise.resolve({ dshProcess: null, codexDesktop: null });
  pending = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='ChatGPT.exe' OR Name='Codex.exe'\" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve({ dshProcess: null, codexDesktop: null }); return; }
      try { const rows = JSON.parse(stdout || '[]'); resolve(classifySoftware(Array.isArray(rows) ? rows : [rows])); }
      catch { resolve({ dshProcess: null, codexDesktop: null }); }
    });
  }).finally(() => { pending = null; });
  return pending;
}

module.exports = { classifySoftware, probeSoftware, probeSharedDesktopConnection, clearSharedDesktopConnectionCache, sharedDesktopPathPattern };
