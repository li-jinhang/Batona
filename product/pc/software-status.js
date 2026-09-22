'use strict';
const { execFile } = require('node:child_process');

// The Codex desktop Store package runs ChatGPT.exe; codex.exe app-server alone
// must never count as the desktop application. Process details never reach IPC.
function classifySoftware(processes) {
  return {
    dshProcess: processes.some(p => /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(p.CommandLine || '') && /(?:\bweb\b|--profile\s+web)/i.test(p.CommandLine || '')),
    codexDesktop: processes.some(p => /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/i.test(p.ExecutablePath || '') || /[\\/]Codex[\\/](?:app[\\/])?(?:Codex|ChatGPT)\.exe$/i.test(p.ExecutablePath || '')),
  };
}

let pending = null;
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

module.exports = { classifySoftware, probeSoftware };
