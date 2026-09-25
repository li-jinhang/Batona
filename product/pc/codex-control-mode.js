'use strict';

const fs = require('node:fs');

function sharedUrl(value) {
  if (typeof value !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(value)) return null;
  try {
    const port = Number(new URL(value).port);
    return port >= 1 && port <= 65535 ? value : null;
  } catch { return null; }
}

function loadControlMode(filePath, env = process.env) {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved.mode === 'interface') return { mode: 'interface' };
    const websocketUrl = sharedUrl(saved.websocketUrl);
    if (saved.mode === 'shared' && websocketUrl) {
      return { mode: 'shared', websocketUrl, enableSharedWrites: saved.enableSharedWrites === true };
    }
  } catch { /* A missing or invalid preference falls back to the existing startup configuration. */ }
  const websocketUrl = sharedUrl(env.BATONA_SHARED_CODEX_WS_URL);
  return websocketUrl
    ? { mode: 'shared', websocketUrl, enableSharedWrites: env.BATONA_SHARED_CODEX_WRITES === '1' }
    : { mode: 'interface' };
}

function saveControlMode(filePath, config) {
  if (config.mode !== 'interface' && (config.mode !== 'shared' || !sharedUrl(config.websocketUrl))) {
    throw new Error('无效的 Codex 控制方式。');
  }
  fs.writeFileSync(filePath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
}

module.exports = { loadControlMode, saveControlMode, sharedUrl };
