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
  const explicit = String(env.DSHLINK_DSH_CMD || '').trim();
  if (explicit) return { command: explicit, prefixArgs: [], source: 'override' };
  if (hasCommand('dsh')) return { command: 'dsh', prefixArgs: [], source: 'global' };
  if (hasCommand('npx')) return { command: 'npx', prefixArgs: ['--yes', '@deepseek-ai/dsh'], source: 'npx' };
  return null;
}

module.exports = { resolveDshLauncher };
