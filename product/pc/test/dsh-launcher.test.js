'use strict';

const assert = require('node:assert/strict');
const { resolveDshLauncher, hasNodeRuntime, isDshAuthenticated, createDshOutputParser } = require('../dsh-launcher.js');

assert.equal(hasNodeRuntime(() => ({ status: 0, stdout: 'v22.12.0\n' })), true);
assert.equal(hasNodeRuntime(() => ({ status: 1, stdout: '' })), false);
assert.equal(hasNodeRuntime(() => ({ status: null, error: new Error('ENOENT') })), false);

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
  resolveDshLauncher({ BATONA_DSH_CMD: 'custom-dsh' }, () => false),
  { command: 'custom-dsh', prefixArgs: [], source: 'override' },
);
console.log('✔ DSH 启动器会在缺少全局命令时回退到 npx');
assert.equal(isDshAuthenticated({ status: 401, body: '' }), false);
assert.equal(isDshAuthenticated({ status: 200, body: '<html>occupied port</html>' }), false);
assert.equal(isDshAuthenticated({ status: 200, body: '{"result":{"ok":true}}' }), true);
const tokens = [], logs = [];
const parse = createDshOutputParser(value => tokens.push(value), line => logs.push(line));
parse('dsh web: http://127.0.0.1:3080/?token=fixture-');
assert.equal(tokens.length, 0);
parse('complete\n');
assert.deepEqual(tokens, [{ port: 3080, token: 'fixture-complete' }]);
assert.ok(logs.every(line => !line.includes('fixture-complete')));
console.log('✔ DSH 认证失败不能标为在线；分片令牌完整捕获且日志脱敏');
