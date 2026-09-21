'use strict';

const assert = require('node:assert/strict');
const { resolveDshLauncher } = require('../dsh-launcher.js');

assert.deepEqual(
  resolveDshLauncher({}, (command) => command === 'npx'),
  { command: 'npx', prefixArgs: ['--yes', '@deepseek-ai/dsh'], source: 'npx' },
  '未全局安装 dsh 时必须回退到 npx，而不是启动失败',
);
assert.deepEqual(
  resolveDshLauncher({}, (command) => command === 'dsh'),
  { command: 'dsh', prefixArgs: [], source: 'global' },
);
assert.deepEqual(
  resolveDshLauncher({ DSHLINK_DSH_CMD: 'custom-dsh' }, () => false),
  { command: 'custom-dsh', prefixArgs: [], source: 'override' },
);
console.log('✔ DSH 启动器会在缺少全局命令时回退到 npx');
