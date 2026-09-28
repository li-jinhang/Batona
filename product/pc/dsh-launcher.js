'use strict';

const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Terminate only this instance's launch tree and/or the verified DSH listener.
// Capture and recheck process identity before taskkill to avoid reusing stale PIDs.
async function stopDshProcesses({ port, managedPid = 0, parentPid = process.pid }, run = promisify(execFile)) {
  if (![port, managedPid, parentPid].every(Number.isInteger) || port < 1 || port > 65535 || managedPid < 0 || parentPid < 1)
    throw new Error('DSH 进程参数无效。');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$targets = @{}
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($owner in $listeners) {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
  if (!$candidate -or $candidate.Name -ne 'node.exe' -or
      $candidate.CommandLine -notmatch '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -or
      $candidate.CommandLine -notmatch '(?:\bweb\b|--profile\s+web)') { throw 'dsh-process-unverified' }
  $targets[[int]$candidate.ProcessId] = $candidate
}
if (${managedPid} -gt 0) {
  $managed = Get-CimInstance Win32_Process -Filter 'ProcessId=${managedPid}'
  if ($managed) {
    if ($managed.ParentProcessId -ne ${parentPid} -or $managed.Name -ne 'cmd.exe') { throw 'dsh-process-unverified' }
    $targets[[int]$managed.ProcessId] = $managed
  }
}
foreach ($candidate in $targets.Values) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)"
  if (!$current) { continue }
  if ($current.CreationDate -ne $candidate.CreationDate -or $current.ExecutablePath -ne $candidate.ExecutablePath) { throw 'dsh-process-changed' }
  & "$env:WINDIR\System32\taskkill.exe" /PID $current.ProcessId /T /F 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue)) { throw 'dsh-stop-failed' }
}
`;
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 });
  } catch {
    throw new Error('无法确认或结束原 DSH 进程，请检查端口占用与进程权限后重试。');
  }
}

async function restartDshService({ stop, isListening, reset, start, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  await stop();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!await isListening()) {
      reset();
      return start();
    }
    await wait(200);
  }
  throw new Error('原 DSH 端口尚未释放，未启动新进程，请稍后重试。');
}

function commandExists(command) {
  return spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true }).status === 0;
}

function hasNodeRuntime(run = spawnSync) {
  const result = run('node.exe', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return result.status === 0 && /^v\d+\.\d+\.\d+/.test(String(result.stdout || '').trim());
}

/**
 * 确定 DSH 启动器。
 *
 * 电脑端常见两种安装方式：全局 `dsh` 与 `npx @deepseek-ai/dsh`。后者是本项目
 * 已验证的开发机路径；不能因为没全局安装而把“端口未监听”误标为 DSH 已启动。
 */
function resolveDshLauncher(env = process.env, hasCommand = commandExists) {
  const explicit = String(env.BATONA_DSH_CMD || '').trim();
  if (explicit) return { command: explicit, prefixArgs: [], source: 'override' };
  if (hasCommand('dsh')) return { command: 'dsh', prefixArgs: [], source: 'global' };
  if (hasCommand('npx')) return { command: 'npx', prefixArgs: ['--yes', '@deepseek-ai/dsh'], source: 'npx' };
  return null;
}

function isDshAuthenticated(reply) {
  if (reply.status !== 200) return false;
  try { return JSON.parse(reply.body).result?.ok === true; } catch { return false; }
}

// Only parse complete lines: stdout may split in the middle of a launch token.
function createDshOutputParser(onToken, onLine) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop().slice(-8192);
    for (const line of lines) {
      const match = /dsh web:\s*(https?:\/\/[^\s/?]+)\/?\?token=([\w.~-]+)(?:\s|$)/.exec(line);
      if (match) onToken({ port: Number(new URL(match[1]).port) || 3080, token: match[2] });
      // Launch URLs are credentials, not diagnostics.
      onLine(line.replace(/([?&]token=)[^\s)]+/gi, '$1<REDACTED>'));
    }
  };
}

module.exports = { resolveDshLauncher, hasNodeRuntime, isDshAuthenticated, createDshOutputParser, stopDshProcesses, restartDshService };
