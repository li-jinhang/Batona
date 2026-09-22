'use strict';

const { spawnSync } = require('node:child_process');

function commandExists(command) {
  return spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true }).status === 0;
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

module.exports = { resolveDshLauncher, isDshAuthenticated, createDshOutputParser };
