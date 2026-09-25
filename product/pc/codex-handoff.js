'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

function stripTerminalFormatting(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function powerShellErrorMessage(value) {
  const text = stripTerminalFormatting(value);
  const lines = text.split('\n').map(line => line.trim()).filter(line => line
    && !/^\[\d+:\d+:[^\]]+\]/.test(line)
    && !/Registration response error message: DEPRECATED_ENDPOINT/.test(line));
  // PowerShell 7 renders the actual exception text as the final "| message" row.
  const renderedMessage = lines.filter(line => /^\|\s*\S/.test(line) && !/^\|\s*[~^]/.test(line))
    .map(line => line.replace(/^\|\s*/, '').trim()).at(-1);
  if (renderedMessage) return renderedMessage;
  const exceptionMessage = lines
    .filter(line => /^Exception:\s*/i.test(line))
    .map(line => line.replace(/^Exception:\s*/i, '').trim())
    .find(line => line && !/^(?:[A-Z]:\\|\\\\)/i.test(line));
  if (exceptionMessage) return exceptionMessage;
  const usefulLines = lines.filter(line => line
    && !/^At\s+.+\s+line:\d+/i.test(line)
    && !/^\+/.test(line)
    && !/^\|/.test(line)
    && !/^Line\s*\|?$/i.test(line)
    && !/^\d+\s*\|/.test(line)
    && !/^Exception:\s*(?:[A-Z]:\\|\\\\)/i.test(line)
    && !/^CategoryInfo:|^FullyQualifiedErrorId:/i.test(line)
    && !/^[~\^]+$/.test(line));
  return usefulLines.at(-1) || 'PowerShell handoff failed.';
}

function sharedWebSocketUrl(output) {
  const text = stripTerminalFormatting(output);
  const match = text.match(/^BATONA_SHARED_WS_URL=(ws:\/\/127\.0\.0\.1:\d+)\s*$/m)
    || text.match(/(ws:\/\/127\.0\.0\.1:\d+)/);
  return match?.[1] || null;
}

function connectedSharedWebSocketUrl(output) {
  const text = stripTerminalFormatting(output);
  if (!/^Preflight OK:/m.test(text) || !/^Shared server: ready \(PID \d+\)\.$/m.test(text)
    || !/^Desktop: connected \(PID \d+\)\.$/m.test(text)) return null;
  return sharedWebSocketUrl(text);
}

function runPowerShell(scriptPath, statePath, action, executor = execFile) {
  return new Promise((resolve, reject) => {
    executor(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-StateFile', statePath, `-${action}`],
      { windowsHide: true, timeout: 90000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === 'ENOENT') {
            const missing = new Error('Windows PowerShell 5.1 不可用，请检查系统组件或联系管理员。');
            missing.code = 'windows-powershell-missing';
            reject(missing);
            return;
          }
          if (/about_Execution_Policies|running scripts is disabled|PSSecurityException|UnauthorizedAccess/i.test(String(stderr || '') + String(stdout || ''))) {
            const blocked = new Error('系统策略仍禁止运行 Codex 共享连接脚本。请联系管理员检查组策略中的 PowerShell 执行限制，然后重试；当前 Codex 不会被关闭。');
            blocked.code = 'codex-handoff-policy-blocked';
            reject(blocked);
            return;
          }
          const stderrDetail = powerShellErrorMessage(stderr);
          const detail = stderrDetail === 'PowerShell handoff failed.'
            ? powerShellErrorMessage(stdout)
            : stderrDetail;
          const message = detail === 'PowerShell handoff failed.'
            ? (error.killed ? 'Codex 重启等待超时，请检查 Codex 是否仍在运行。'
              : `Codex 重启脚本执行失败（退出码 ${error.code ?? '未知'}）。`)
            : detail;
          const wrapped = new Error(message);
          wrapped.code = 'codex-handoff-failed';
          reject(wrapped);
          return;
        }
        resolve(String(stdout || '').trim());
      },
    );
  });
}

async function launchSharedCodexDesktop({
  scriptPath,
  statePath,
  codexDesktop,
  restart = false,
  runCommand = runPowerShell,
  stateExists = fs.existsSync,
}) {
  if (codexDesktop === true && !restart) {
    const error = new Error('请先保存工作并完全退出 Codex，再启动共享连接。Batona 不会强制结束 Codex。');
    error.code = 'codex-desktop-open';
    throw error;
  }
  if (codexDesktop == null) {
    const error = new Error('无法确认 Codex 是否已关闭，请刷新状态后重试。');
    error.code = 'codex-status-unknown';
    throw error;
  }

  if (restart && stateExists(statePath)) {
    const status = await runCommand(scriptPath, statePath, 'Status').catch(() => null);
    const websocketUrl = connectedSharedWebSocketUrl(status);
    if (websocketUrl) return { output: status, websocketUrl, reused: true };
  }

  // Remove only the previously recorded, identity-checked handoff process.
  // native-handoff.ps1 verifies Desktop is closed and validates the saved PID.
  if (!restart && stateExists(statePath)) await runCommand(scriptPath, statePath, 'Stop');
  let output;
  try {
    output = await runCommand(scriptPath, statePath, restart ? 'Restart' : 'Launch');
  } catch (error) {
    // Desktop may have connected even if its diagnostics made execFile report an
    // error. The read-only status path verifies the managed server and socket.
    const status = await runCommand(scriptPath, statePath, 'Status').catch(() => null);
    const websocketUrl = connectedSharedWebSocketUrl(status);
    if (websocketUrl) return { output: status, websocketUrl, recovered: true };
    throw error;
  }
  const websocketUrl = sharedWebSocketUrl(output);
  if (!websocketUrl) {
    const error = new Error('Codex 已启动，但 Batona 未能读取共享连接地址；请查看运行日志中的启动结果。');
    error.code = 'codex-handoff-url-missing';
    throw error;
  }
  return { output, websocketUrl };
}

module.exports = { connectedSharedWebSocketUrl, launchSharedCodexDesktop, powerShellErrorMessage, runPowerShell, sharedWebSocketUrl, stripTerminalFormatting };
